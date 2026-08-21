/**
 * Gate checks, driven the way a real client drives the server: spawn it over
 * stdio and read `tools/list`.
 *
 * The gates are read from the environment at import time, so they can only be
 * tested across process boundaries — an in-process test would be asserting
 * against whatever env the test runner happened to start with. This also
 * proves the plan's other claim in passing: `tools/list` needs no credentials,
 * because login is lazy.
 */

import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

// `URL.pathname` yields a leading-slash `/C:/...` on Windows, which Bun cannot
// resolve as a module path.
const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url))

/** Minimal stdio JSON-RPC client — enough to initialize and list tools. */
async function listTools(env: Record<string, string>): Promise<string[]> {
	const proc = Bun.spawn(['bun', 'run', ENTRY], {
		// A bare env, so a developer's own .env cannot leak into the assertions.
		env: { PATH: process.env.PATH ?? '', ...env },
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe'
	})

	const send = (message: unknown) => proc.stdin.write(`${JSON.stringify(message)}\n`)

	send({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: '2026-07-28',
			capabilities: {},
			clientInfo: { name: 'gate-test', version: '0' }
		}
	})
	send({ jsonrpc: '2.0', method: 'notifications/initialized' })
	send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
	await proc.stdin.flush()

	const names: string[] = []
	const decoder = new TextDecoder()
	let buffer = ''

	for await (const chunk of proc.stdout) {
		buffer += decoder.decode(chunk, { stream: true })

		let newline: number
		while ((newline = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, newline).trim()
			buffer = buffer.slice(newline + 1)
			if (!line) continue

			const message = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } }
			if (message.id !== 2) continue

			names.push(...(message.result?.tools ?? []).map((tool) => tool.name))
			proc.kill()
			return names
		}
	}

	proc.kill()
	throw new Error(`server produced no tools/list response: ${await new Response(proc.stderr).text()}`)
}

describe('registration gates', () => {
	test('default env exposes reads only, and needs no credentials', async () => {
		const tools = await listTools({})

		// Lazy login is what makes this possible at all.
		expect(tools).toContain('vrchat_authStatus')
		expect(tools).toContain('vrchat__getCurrentUser')

		expect(tools).not.toContain('vrchat__deleteProduct')
		expect(tools).not.toContain('vrchat__purchaseProductListing')
		expect(tools).not.toContain('vrchat__deleteUser')
	}, 30_000)

	test('writes gate unlocks creating and editing, but nothing destructive', async () => {
		const tools = await listTools({ VRCHAT_MCP_ALLOW_WRITES: '1' })

		expect(tools).toContain('vrchat__uploadImage')
		expect(tools).not.toContain('vrchat__deleteProduct')
		expect(tools).not.toContain('vrchat__purchaseProductListing')
		expect(tools).not.toContain('vrchat__deleteUser')
	}, 30_000)

	test('destructive gate unlocks deletes, but not money or admin', async () => {
		const tools = await listTools({
			VRCHAT_MCP_ALLOW_WRITES: '1',
			VRCHAT_MCP_ALLOW_DESTRUCTIVE_WRITES: '1'
		})

		expect(tools).toContain('vrchat__deleteProduct')
		expect(tools).not.toContain('vrchat__purchaseProductListing')
		expect(tools).not.toContain('vrchat__deleteUser')
	}, 30_000)

	test('the destructive gate is layered on writes, not a substitute for it', async () => {
		// On its own it grants nothing: a delete is a write, so both are needed.
		// Otherwise the flag would be a way to get deletes without writes, which
		// is the opposite of what a safety gate should allow.
		const tools = await listTools({ VRCHAT_MCP_ALLOW_DESTRUCTIVE_WRITES: '1' })

		expect(tools).not.toContain('vrchat__deleteProduct')
		expect(tools).not.toContain('vrchat__uploadImage')
	}, 30_000)

	test('purchases gate unlocks money ops but not admin', async () => {
		const tools = await listTools({
			VRCHAT_MCP_ALLOW_WRITES: '1',
			VRCHAT_MCP_ALLOW_PURCHASES: '1'
		})

		expect(tools).toContain('vrchat__purchaseProductListing')
		expect(tools).not.toContain('vrchat__deleteUser')
	}, 30_000)

	test('admin gate is independent of the write gate', async () => {
		// Deliberately without ALLOW_WRITES: the three gates must not imply
		// one another, so admin alone is enough for an admin op.
		const tools = await listTools({ VRCHAT_MCP_ALLOW_ADMIN: '1' })

		expect(tools).toContain('vrchat__deleteUser')
		expect(tools).not.toContain('vrchat__deleteProduct')
	}, 30_000)

	test('tag filter narrows to one tag', async () => {
		const tools = await listTools({ VRCHAT_MCP_TAGS: 'economy' })
		const generated = tools.filter((name) => name.startsWith('vrchat__'))

		expect(generated.length).toBeGreaterThan(0)
		expect(tools).toContain('vrchat__getBalance')
		expect(tools).not.toContain('vrchat__getCurrentUser')
	}, 30_000)

	test('event tools appear only when the websocket is enabled', async () => {
		expect(await listTools({})).not.toContain('vrchat_eventsStatus')
		expect(await listTools({ VRCHAT_MCP_WEBSOCKET: '1' })).toContain('vrchat_eventsStatus')
	}, 30_000)
})
