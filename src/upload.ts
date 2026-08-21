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
export async function resolveUploads(
	body: Record<string, unknown>,
	binaryFields: readonly string[]
): Promise<{ uploaded: { field: string; name: string; bytes: number; type: string }[] }> {
	const uploaded: { field: string; name: string; bytes: number; type: string }[] = []

	for (const field of binaryFields) {
		const value = body[field]
		if (typeof value !== 'string' || value === '') continue

		const file = await fileFromPath(value, field)
		body[field] = file
		uploaded.push({ field, name: file.name, bytes: file.size, type: file.type })
	}

	return { uploaded }
}
