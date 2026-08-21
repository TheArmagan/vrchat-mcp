/**
 * Turning a local file path into something the VRChat SDK can upload.
 *
 * The spec declares upload fields as `format: binary`, which codegen would
 * otherwise advertise as base64. That is the wrong shape for an agent: a 2 MB
 * PNG becomes ~2.7 MB of base64 sitting in the tool arguments, dwarfing the
 * rest of the call and often exceeding what the transport will carry. This
 * server runs on the same machine as the files, so it reads them itself and the
 * agent only ever passes a path.
 */

import { statSync } from 'node:fs'
import { basename, extname, isAbsolute, resolve } from 'node:path'

/**
 * Refused above this size.
 *
 * VRChat's own image limits are well under this; the cap exists so a mistyped
 * path pointing at a disk image fails immediately instead of after a long
 * upload through someone's proxy.
 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/** Extension to MIME type. VRChat rejects uploads whose type it cannot read. */
const MIME_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.bmp': 'image/bmp',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.vrca': 'application/x-avatar',
	'.vrcw': 'application/x-world',
	'.unitypackage': 'application/gzip',
	'.zip': 'application/zip'
}

export class UploadError extends Error {
	override readonly name = 'UploadError'
	readonly hint: string

	constructor(message: string, hint: string) {
		super(message)
		this.hint = hint
	}
}

export function mimeTypeFor(path: string): string {
	return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** MIME type back to an extension, for naming a file that arrived without one. */
const EXTENSIONS: Record<string, string> = Object.fromEntries(
	Object.entries(MIME_TYPES)
		.reverse()
		.map(([extension, mime]) => [mime, extension])
)

export function extensionFor(mimeType: string): string {
	return EXTENSIONS[mimeType.toLowerCase()] ?? '.bin'
}

/**
 * An upload argument: a local path, or the bytes themselves.
 *
 * Paths are the cheap route and should be preferred. Inline base64 exists for
 * content that has no path to begin with, such as an image the agent just
 * generated, and it costs roughly 1.33 bytes of tool argument per byte of file.
 */
export type FileInput =
	| string
	| { data: string; mimeType?: string; filename?: string }

/** Rejects the obvious non-base64 before spending memory decoding it. */
const BASE64_PATTERN = /^[A-Za-z0-9+/\s]*={0,2}$/

/**
 * Decodes inline bytes into a `File`.
 *
 * Accepts a bare base64 string or a `data:` URI, since an agent handed one
 * naturally reaches for the other.
 */
export function fileFromInline(
	input: { data: string; mimeType?: string; filename?: string },
	field: string
): File {
	let payload = input.data.trim()
	let mimeType = input.mimeType

	const dataUri = /^data:([^;,]*)(;base64)?,/i.exec(payload)
	if (dataUri) {
		if (!dataUri[2]) {
			throw new UploadError(
				`\`${field}\` is a data: URI that is not base64-encoded.`,
				'Use a `data:<mime>;base64,<...>` URI, or pass `data` as plain base64 with `mimeType`.'
			)
		}
		mimeType ||= dataUri[1] || undefined
		payload = payload.slice(dataUri[0].length)
	}

	if (!payload) {
		throw new UploadError(`\`${field}\` has no data.`, 'Pass base64 bytes in `data`.')
	}
	if (!BASE64_PATTERN.test(payload)) {
		throw new UploadError(
			`\`${field}\` is not valid base64.`,
			'Pass base64 bytes, a data: URI, or a local file path instead.'
		)
	}

	// Base64 inflates by 4/3, so an oversized payload can be refused before the
	// decode allocates it.
	if ((payload.length * 3) / 4 > MAX_UPLOAD_BYTES) {
		throw new UploadError(
			`\`${field}\` is over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.`,
			'Write the file to disk and pass its path instead.'
		)
	}

	const bytes = Buffer.from(payload, 'base64')

	if (bytes.byteLength === 0) {
		throw new UploadError(
			`\`${field}\` decoded to zero bytes.`,
			'Check the base64 is complete and not truncated.'
		)
	}

	const type = mimeType || 'application/octet-stream'
	const name = input.filename || `upload${extensionFor(type)}`

	return new File([bytes], name, { type })
}

/** Resolves either form of upload argument into a `File`. */
export async function fileFromInput(input: FileInput, field: string): Promise<File> {
	if (typeof input === 'string') {
		// A data: URI is unambiguous, so accept it in the path position rather
		// than failing with "no such file" on something clearly not a path.
		if (/^data:/i.test(input.trim())) return fileFromInline({ data: input }, field)
		return fileFromPath(input, field)
	}

	if (input && typeof input === 'object' && typeof input.data === 'string') {
		return fileFromInline(input, field)
	}

	throw new UploadError(
		`\`${field}\` must be a file path or { data, mimeType }.`,
		'Pass a local path, or base64 bytes as { data: "...", mimeType: "image/png" }.'
	)
}

/**
 * Reads a path into a `File`.
 *
 * A `File` rather than a `Blob` because the SDK appends the value straight to
 * `FormData`, and only a `File` carries a filename through. VRChat uses that
 * name, and a body announcing itself as `blob` with no extension gets rejected.
 */
export async function fileFromPath(path: string, field: string): Promise<File> {
	const full = isAbsolute(path) ? path : resolve(path)

	let size: number
	try {
		const stats = statSync(full)
		if (stats.isDirectory()) {
			throw new UploadError(
				`\`${field}\` points at a directory, not a file: ${full}`,
				'Give the path of the file itself.'
			)
		}
		size = stats.size
	} catch (cause) {
		if (cause instanceof UploadError) throw cause
		throw new UploadError(
			`Cannot read the file for \`${field}\`: ${full}`,
			'Check the path exists and is readable. Relative paths resolve against the server process’s working directory, so an absolute path is safer.'
		)
	}

	if (size === 0) {
		throw new UploadError(`The file for \`${field}\` is empty: ${full}`, 'Check you meant this path.')
	}
	if (size > MAX_UPLOAD_BYTES) {
		throw new UploadError(
			`The file for \`${field}\` is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${
				MAX_UPLOAD_BYTES / 1024 / 1024
			} MB limit.`,
			'Check the path is the one you meant, or shrink the file.'
		)
	}

	const bytes = await Bun.file(full).arrayBuffer()
	return new File([bytes], basename(full), { type: mimeTypeFor(full) })
}

/**
 * Replaces every binary field's path with the file it names.
 *
 * Returns a description of what was read so the tool result can report the
 * bytes actually sent, which is the only way to tell a successful upload of the
 * wrong file from a successful upload of the right one.
 */
export interface UploadedFile {
	field: string
	name: string
	bytes: number
	type: string
	source: 'path' | 'inline'
}

export async function resolveUploads(
	body: Record<string, unknown>,
	binaryFields: readonly string[]
): Promise<{ uploaded: UploadedFile[] }> {
	const uploaded: UploadedFile[] = []

	for (const field of binaryFields) {
		const value = body[field]
		if (value === undefined || value === null || value === '') continue

		const inline = typeof value !== 'string' || /^data:/i.test(value.trim())
		const file = await fileFromInput(value as FileInput, field)

		body[field] = file
		uploaded.push({
			field,
			name: file.name,
			bytes: file.size,
			type: file.type,
			source: inline ? 'inline' : 'path'
		})
	}

	return { uploaded }
}
