/**
 * Upload path handling.
 *
 * The spec calls these fields `format: binary`, which would otherwise be
 * advertised as base64 and put a whole PNG inside the tool arguments. These
 * tests pin the alternative: the agent passes a path, the server reads it.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { operationsById } from '../src/generated/operations.ts'
import {
	extensionFor,
	fileFromInline,
	fileFromInput,
	fileFromPath,
	mimeTypeFor,
	resolveUploads,
	UploadError
} from '../src/upload.ts'

const DIR = join(
	process.env.TEMP ?? '.',
	`vrchat-mcp-upload-${process.pid}`
)
mkdirSync(DIR, { recursive: true })

const png = join(DIR, 'avatar.png')
writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))

const empty = join(DIR, 'empty.png')
writeFileSync(empty, '')

afterAll(() => rmSync(DIR, { recursive: true, force: true }))

describe('codegen marks binary fields', () => {
	test('the eight multipart operations declare their file fields', () => {
		const withBinary = Object.values(operationsById).filter((op) => op.binaryFields.length > 0)

		expect(withBinary).toHaveLength(8)
		expect(operationsById.uploadImage?.binaryFields).toEqual(['file'])
		expect(operationsById.uploadPrint?.binaryFields).toEqual(['image'])
	})

	test('a binary field accepts a path or inline bytes', () => {
		const schema = operationsById.uploadImage!.inputSchema as unknown as {
			safeParse: (v: unknown) => { success: boolean }
		}

		expect(schema.safeParse({ file: '/tmp/x.png', tag: 'icon' }).success).toBe(true)
		expect(
			schema.safeParse({ file: { data: 'AAAA', mimeType: 'image/png' }, tag: 'icon' }).success
		).toBe(true)

		// A bare number is neither, and must not be quietly coerced.
		expect(schema.safeParse({ file: 42, tag: 'icon' }).success).toBe(false)
	})

	test('ordinary operations carry no binary fields', () => {
		expect(operationsById.getCurrentUser?.binaryFields).toEqual([])
	})
})

describe('reading a file for upload', () => {
	test('produces a File carrying the name and type', async () => {
		const file = await fileFromPath(png, 'file')

		// A Blob would reach VRChat named "blob" with no extension, and be refused.
		expect(file).toBeInstanceOf(File)
		expect(file.name).toBe('avatar.png')
		expect(file.type).toBe('image/png')
		expect(file.size).toBe(11)
	})

	test('a missing path fails with a hint instead of a stack', async () => {
		const error = (await fileFromPath(join(DIR, 'nope.png'), 'file').catch((e) => e)) as UploadError

		expect(error).toBeInstanceOf(UploadError)
		expect(error.hint).toContain('absolute path')
		expect(error.message).not.toContain('\n    at ')
	})

	test('a directory is rejected as such', async () => {
		const error = (await fileFromPath(DIR, 'file').catch((e) => e)) as UploadError

		expect(error.message).toContain('directory')
	})

	test('an empty file is rejected before it reaches VRChat', async () => {
		// VRChat accepts a zero-byte upload and stores a broken record, so this
		// has to be caught here rather than reported by the API.
		const error = (await fileFromPath(empty, 'file').catch((e) => e)) as UploadError

		expect(error.message).toContain('empty')
	})

	test('mime types come from the extension', () => {
		expect(mimeTypeFor('a.png')).toBe('image/png')
		expect(mimeTypeFor('a.JPG')).toBe('image/jpeg')
		expect(mimeTypeFor('a.vrca')).toBe('application/x-avatar')
		expect(mimeTypeFor('a.unknown')).toBe('application/octet-stream')
	})
})

describe('resolveUploads', () => {
	test('swaps the path for the file and reports what was read', async () => {
		const body: Record<string, unknown> = { file: png, tag: 'icon' }
		const { uploaded } = await resolveUploads(body, ['file'])

		expect(body.file).toBeInstanceOf(File)
		expect(body.tag).toBe('icon')
		expect(uploaded).toEqual([
			{ field: 'file', name: 'avatar.png', bytes: 11, type: 'image/png', source: 'path' }
		])
	})

	test('leaves an omitted optional field alone', async () => {
		const body: Record<string, unknown> = { tag: 'icon' }
		const { uploaded } = await resolveUploads(body, ['file'])

		expect(body).not.toHaveProperty('file')
		expect(uploaded).toEqual([])
	})

	test('handles several binary fields in one body', async () => {
		const body: Record<string, unknown> = { file: png, image: png }
		const { uploaded } = await resolveUploads(body, ['file', 'image'])

		expect(uploaded).toHaveLength(2)
		expect(body.file).toBeInstanceOf(File)
		expect(body.image).toBeInstanceOf(File)
	})
})

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64')

describe('inline bytes', () => {
	test('decodes base64 with an explicit mime type', () => {
		const file = fileFromInline({ data: PNG_BASE64, mimeType: 'image/png' }, 'file')

		expect(file.size).toBe(7)
		expect(file.type).toBe('image/png')
		// VRChat rejects a body with no usable filename, so one is invented from
		// the mime type rather than left as "blob".
		expect(file.name).toBe('upload.png')
	})

	test('honours an explicit filename', () => {
		expect(fileFromInline({ data: PNG_BASE64, filename: 'icon.png' }, 'file').name).toBe('icon.png')
	})

	test('accepts a data: URI and takes the type from it', () => {
		const file = fileFromInline({ data: `data:image/png;base64,${PNG_BASE64}` }, 'file')

		expect(file.type).toBe('image/png')
		expect(file.size).toBe(7)
	})

	test('a data: URI works in the string position too', async () => {
		// An agent handed one form naturally reaches for the other, and failing
		// with "no such file" on an obvious data: URI would be unhelpful.
		const file = await fileFromInput(`data:image/png;base64,${PNG_BASE64}`, 'file')

		expect(file.type).toBe('image/png')
	})

	test('rejects a non-base64 data: URI rather than mangling it', () => {
		const error = (() => {
			try {
				fileFromInline({ data: 'data:image/png,notbase64' }, 'file')
			} catch (e) {
				return e as UploadError
			}
		})()

		expect(error).toBeInstanceOf(UploadError)
		expect(error!.message).toContain('not base64-encoded')
	})

	test('rejects junk that is not base64 at all', () => {
		expect(() => fileFromInline({ data: 'not base64!!!' }, 'file')).toThrow(UploadError)
	})

	test('rejects data that decodes to nothing', () => {
		// Base64 silently decodes plenty of junk to zero bytes, and VRChat stores
		// an empty upload as a broken record, so this has to be caught here.
		expect(() => fileFromInline({ data: '' }, 'file')).toThrow(UploadError)
	})

	test('falls back to octet-stream when no type is given', () => {
		const file = fileFromInline({ data: PNG_BASE64 }, 'file')

		expect(file.type).toBe('application/octet-stream')
		expect(file.name).toBe('upload.bin')
	})

	test('a non-string, non-object argument is refused', async () => {
		await expect(fileFromInput(42 as never, 'file')).rejects.toBeInstanceOf(UploadError)
	})

	test('extensions map back from mime types', () => {
		expect(extensionFor('image/png')).toBe('.png')
		expect(extensionFor('image/jpeg')).toBe('.jpg')
		expect(extensionFor('application/x-avatar')).toBe('.vrca')
		expect(extensionFor('application/unknown')).toBe('.bin')
	})
})

describe('resolveUploads with inline bytes', () => {
	test('swaps inline data for a File and marks the source', async () => {
		const body: Record<string, unknown> = {
			file: { data: PNG_BASE64, mimeType: 'image/png', filename: 'a.png' }
		}
		const { uploaded } = await resolveUploads(body, ['file'])

		expect(body.file).toBeInstanceOf(File)
		expect(uploaded).toEqual([
			{ field: 'file', name: 'a.png', bytes: 7, type: 'image/png', source: 'inline' }
		])
	})

	test('reports which form each field arrived in', async () => {
		// The result names the bytes sent so a wrong file is detectable; naming
		// the source makes it clear which argument produced them.
		const body: Record<string, unknown> = {
			file: png,
			image: { data: PNG_BASE64, mimeType: 'image/png' }
		}
		const { uploaded } = await resolveUploads(body, ['file', 'image'])

		expect(uploaded.map((u) => u.source)).toEqual(['path', 'inline'])
	})
})
