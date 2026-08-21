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
import { fileFromPath, mimeTypeFor, resolveUploads, UploadError } from '../src/upload.ts'

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

	test('a binary field asks for a path, not base64', () => {
		// The whole point: base64 here would be megabytes of tool argument.
		const schema = operationsById.uploadImage!.inputSchema as never
		const parsed = (schema as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
			file: '/tmp/x.png',
			tag: 'icon'
		})

		expect(parsed.success).toBe(true)
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
		expect(uploaded).toEqual([{ field: 'file', name: 'avatar.png', bytes: 11, type: 'image/png' }])
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
