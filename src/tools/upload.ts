/**
 * `vrchat_uploadFile` — the multi-step file upload.
 *
 * VRChat stores arbitrary files (avatar and world bundles, unity packages) in
 * four steps that no single generated tool can express: create the record, ask
 * for a presigned URL, PUT the bytes to S3, then tell VRChat the upload
 * finished. Getting the order wrong leaves an empty file record on the account,
 * so the orchestration lives here rather than being left to the agent.
 *
 * Images do not need this. `vrchat__uploadImage`, `vrchat__uploadPrint`,
 * `vrchat__uploadIcon` and `vrchat__uploadGalleryImage` take a local path
 * directly and are one call each.
 */

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { config } from '../config.ts'
import { describeError } from '../errors.ts'
import { fileFromPath, mimeTypeFor, UploadError } from '../upload.ts'
import { ensureAuthenticated, getClient } from '../vrchat/client.ts'
import { getLimiter } from '../vrchat/ratelimit.ts'

/** The three roles a stored file can play. `file` is the payload itself. */
const FILE_TYPES = ['file', 'signature', 'delta'] as const

function json(value: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function fail(value: unknown) {
	return { ...json(value), isError: true as const }
}

type SdkResult<T = Record<string, unknown>> = { data?: T; error?: unknown }

/**
 * Sends the bytes to the presigned S3 URL.
 *
 * Deliberately a bare `fetch` rather than the VRChat client: the URL points at
 * Amazon, and the client attaches the VRChat auth cookie to everything it
 * sends. Routing this through it would hand the session cookie to a third-party
 * host. The proxy and the rate limiter still apply, so IP separation holds.
 */
async function putToPresignedUrl(url: string, file: File): Promise<string> {
	const response = await getLimiter().schedule(async () =>
		fetch(url, {
			method: 'PUT',
			body: file,
			headers: { 'Content-Type': file.type },
			...(config.proxy ? { proxy: config.proxy } : {})
		} as RequestInit)
	)

	if (!response.ok) {
		throw new UploadError(
			`The storage service rejected the upload (HTTP ${response.status}).`,
			'The presigned URL may have expired. Retry the upload from the start.'
		)
	}

	// S3 quotes its ETags. VRChat wants the value, not the quoting.
	return (response.headers.get('etag') ?? '').replace(/"/g, '')
}

export function registerUploadTools(server: McpServer): void {
	server.registerTool(
		'vrchat_uploadFile',
		{
			title: 'Upload a file to VRChat',
			description:
				'Uploads a local file to VRChat storage, running the whole create → start → transfer → finish sequence and returning the finished file record. Use this for asset bundles, unity packages and other non-image files. For images use vrchat__uploadImage, vrchat__uploadPrint, vrchat__uploadIcon or vrchat__uploadGalleryImage, which take a path directly in one call. Requires VRCHAT_MCP_ALLOW_WRITES=1.',
			inputSchema: z.object({
				path: z
					.string()
					.describe(
						"Path to the local file to upload. Absolute, or relative to the server's working directory. Never file contents."
					),
				name: z
					.string()
					.optional()
					.describe('Display name for the file record. Defaults to the filename on disk.'),
				mimeType: z
					.string()
					.optional()
					.describe('MIME type. Inferred from the extension when omitted.'),
				fileType: z
					.enum(FILE_TYPES)
					.default('file')
					.describe('Which role this upload fills. `file` is the payload itself.'),
				tags: z.array(z.string()).optional().describe('Tags to attach to the file record.')
			}),
			annotations: {
				title: 'Upload a file to VRChat',
				readOnlyHint: false,
				destructiveHint: false,
				openWorldHint: true
			}
		},
		async ({ path, name, mimeType, fileType, tags }) => {
			// Gated with the generated write tools: this creates account content.
			if (!config.allowWrites) {
				return fail({
					status: null,
					message: 'Uploading is a write operation and writes are disabled.',
					hint: 'Set VRCHAT_MCP_ALLOW_WRITES=1 in the server environment to enable it.'
				})
			}

			let fileId = ''

			try {
				const file = await fileFromPath(path, 'path')
				await ensureAuthenticated()
				const client = getClient()

				const extension = file.name.includes('.') ? `.${file.name.split('.').pop()}` : ''

				const created = (await client.createFile({
					body: {
						name: name ?? file.name,
						mimeType: (mimeType ?? mimeTypeFor(file.name)) as never,
						extension,
						...(tags ? { tags: tags as never } : {})
					},
					throwOnError: false
				})) as SdkResult

				if (created.error || !created.data) return fail(describeError(created.error ?? created))

				fileId = String(created.data.id ?? '')
				const versions = Array.isArray(created.data.versions) ? created.data.versions : []
				const versionId = versions.length > 0 ? versions.length - 1 : 0

				if (!fileId) {
					return fail({
						status: null,
						message: 'VRChat created the file record but returned no id.',
						hint: 'Call vrchat__getFiles to check whether a stray record was left behind.'
					})
				}

				const started = (await client.startFileDataUpload({
					path: { fileId, versionId, fileType },
					throwOnError: false
				})) as SdkResult<{ url?: string }>

				if (started.error || !started.data?.url) {
					return fail(describeError(started.error ?? started))
				}

				const etag = await putToPresignedUrl(started.data.url, file)

				const finished = (await client.finishFileDataUpload({
					path: { fileId, versionId, fileType },
					// VRChat ignores the deprecated part fields but still expects them.
					body: { etags: etag ? [etag] : [], maxParts: '0', nextPartNumber: '0' },
					throwOnError: false
				})) as SdkResult

				if (finished.error) return fail(describeError(finished.error))

				return json({
					ok: true,
					uploaded: { name: file.name, bytes: file.size, type: file.type },
					fileId,
					versionId,
					fileType,
					record: finished.data
				})
			} catch (cause) {
				const detail = describeError(cause)

				// A half-finished upload leaves a real record on the account. We
				// cannot safely delete it (the id may be reused by a version that
				// did land), so name it instead of leaving the user to find it.
				return fail(
					fileId
						? {
								...detail,
								fileId,
								hint: `${detail.hint} A file record (${fileId}) was created before this failed; inspect it with vrchat__getFile and remove it with vrchat__deleteFile if it is empty.`
							}
						: detail
				)
			}
		}
	)
}
