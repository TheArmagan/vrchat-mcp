/**
 * `vrchat_getImage` — fetch a VRChat image and hand it back as an MCP image
 * block, so the model can actually look at it.
 *
 * Every VRChat object that matters visually (users, worlds, avatars, prints,
 * store products) carries an `imageUrl` or a file id, and without this an agent
 * can only report the URL and hope someone else opens it.
 */

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { config } from '../config.ts'
import { describeError } from '../errors.ts'
import { ensureAuthenticated, getClient } from '../vrchat/client.ts'
import { getLimiter } from '../vrchat/ratelimit.ts'

/**
 * Hosts this tool will fetch from.
 *
 * Without a list, a tool that fetches a caller-supplied URL while holding a
 * session cookie is a request-forgery primitive: point it at an internal
 * address and it reports back what it found. The cookie itself is narrower
 * still, see `isApiHost`.
 */
const ALLOWED_HOSTS = [
	'api.vrchat.cloud',
	'vrchat.cloud',
	'assets.vrchat.com',
	'files.vrchat.cloud',
	'd348imysud55la.cloudfront.net'
]

/** Only the API host is ever sent the session cookie. */
export function isApiHost(host: string): boolean {
	return host === 'api.vrchat.cloud'
}

export function isAllowedHost(host: string): boolean {
	return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

/**
 * Ceiling on what gets returned.
 *
 * An image block is base64 in the conversation, so a 10 MB texture costs about
 * 13 MB of context and buys nothing over a thumbnail. Most VRChat image URLs
 * end in a size segment (`/256`, `/512`) that is worth using instead.
 */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

function json(value: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function fail(value: unknown) {
	return { ...json(value), isError: true as const }
}

export function registerImageTools(server: McpServer): void {
	server.registerTool(
		'vrchat_getImage',
		{
			title: 'View a VRChat image',
			description:
				'Downloads a VRChat image and returns it as an image you can actually look at, rather than a URL. Pass either `url` (any imageUrl / thumbnailImageUrl from a user, world, avatar, print or product) or `fileId` (plus optional `version`). Prefer a sized URL ending in /256 or /512 when one is available: the image is carried as base64, so a full-size texture costs a lot of context for no extra detail. Optionally also writes the file to `savePath`. Read-only.',
			inputSchema: z.object({
				url: z.string().optional().describe('Full VRChat image URL. Mutually exclusive with fileId.'),
				fileId: z
					.string()
					.optional()
					.describe('A VRChat file id (file_...). Mutually exclusive with url.'),
				version: z
					.number()
					.int()
					.optional()
					.describe('File version to fetch when using fileId. Defaults to 1.'),
				savePath: z.string().optional().describe('Optional local path to also write the bytes to.'),
				maxBytes: z
					.number()
					.int()
					.positive()
					.optional()
					.describe(`Refuse anything larger. Defaults to ${DEFAULT_MAX_BYTES}.`)
			}),
			annotations: { title: 'View a VRChat image', readOnlyHint: true, openWorldHint: true }
		},
		async ({ url, fileId, version, savePath, maxBytes }) => {
			const limit = maxBytes ?? DEFAULT_MAX_BYTES

			if (!url && !fileId) {
				return fail({
					status: null,
					message: 'Give either `url` or `fileId`.',
					hint: 'Most VRChat objects carry an imageUrl; pass that.'
				})
			}

			try {
				const target = url ?? `https://api.vrchat.cloud/api/1/file/${fileId}/${version ?? 1}/file`
				let parsed: URL

				try {
					parsed = new URL(target)
				} catch {
					return fail({
						status: null,
						message: `Not a valid URL: ${target}`,
						hint: 'Pass a full https:// URL, or use `fileId` instead.'
					})
				}

				if (parsed.protocol !== 'https:') {
					return fail({
						status: null,
						message: `Refusing to fetch over ${parsed.protocol.replace(':', '')}.`,
						hint: 'Use https. This request can carry your VRChat session, so it is never sent in the clear.'
					})
				}

				if (!isAllowedHost(parsed.hostname)) {
					return fail({
						status: null,
						message: `Refusing to fetch from ${parsed.hostname}.`,
						hint: `This tool only fetches VRChat-hosted images (${ALLOWED_HOSTS.join(
							', '
						)}), because it can carry your VRChat session.`
					})
				}

				let response: Response

				if (isApiHost(parsed.hostname)) {
					// Through the SDK client, whose interceptor attaches the session
					// cookie: API-hosted files 401 without it.
					await ensureAuthenticated()
					const client = getClient()
					const path = parsed.pathname.replace(/^\/api\/1/, '') + parsed.search

					const result = (await client.client.get({
						url: path,
						parseAs: 'stream',
						throwOnError: false
					})) as { response?: Response; error?: unknown }

					if (result.error || !result.response) return fail(describeError(result.error ?? result))
					response = result.response
				} else {
					// A CDN host. Deliberately a bare fetch: the cookie has no business
					// leaving the API host, and the CDN does not want it.
					response = await getLimiter().schedule(async () =>
						fetch(parsed, config.proxy ? ({ proxy: config.proxy } as RequestInit) : undefined)
					)
				}

				if (!response.ok) {
					return fail({
						status: response.status,
						message: `The image could not be fetched (HTTP ${response.status}).`,
						hint:
							response.status === 401 || response.status === 403
								? 'The image may need a session you do not have, or the id may be wrong.'
								: 'Check the URL or file id.'
					})
				}

				const declared = Number(response.headers.get('content-length') ?? '0')
				if (declared > limit) {
					return fail({
						status: null,
						message: `The image is ${declared} bytes, over the ${limit} byte limit.`,
						hint: 'Use a sized URL (ending in /256 or /512), or raise maxBytes.'
					})
				}

				const bytes = new Uint8Array(await response.arrayBuffer())

				// Re-checked after reading: not every host sends content-length.
				if (bytes.byteLength > limit) {
					return fail({
						status: null,
						message: `The image is ${bytes.byteLength} bytes, over the ${limit} byte limit.`,
						hint: 'Use a sized URL (ending in /256 or /512), or raise maxBytes.'
					})
				}

				const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''

				if (savePath) await Bun.write(savePath, bytes)

				const summary = {
					url: parsed.toString(),
					bytes: bytes.byteLength,
					mimeType: mimeType || 'unknown',
					...(savePath ? { savedTo: savePath } : {})
				}

				// A non-image (an HTML error page, say) must not be dressed up as an
				// image block: the model would be handed noise it cannot read.
				if (!IMAGE_TYPES.includes(mimeType)) {
					return fail({
						status: null,
						message: `That URL returned ${mimeType || 'an unknown type'}, not an image.`,
						hint: 'Check the URL points at an image. The bytes were not returned.',
						...summary
					})
				}

				return {
					content: [
						{ type: 'image' as const, data: Buffer.from(bytes).toString('base64'), mimeType },
						{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }
					]
				}
			} catch (cause) {
				return fail(describeError(cause))
			}
		}
	)
}
