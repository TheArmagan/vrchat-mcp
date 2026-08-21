#!/usr/bin/env bun
/**
 * stdio entry point.
 *
 * stdout is the JSON-RPC channel — every diagnostic in this project goes to
 * stderr. A single stray `console.log` anywhere in the tree corrupts the
 * protocol stream, which is why nothing here prints to stdout.
 */

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

import { config } from './config.ts'
import { knownTags, registerGeneratedTools, unknownTags } from './registry.ts'
import { registerAuthTools } from './tools/auth.ts'
import { registerEventTools } from './tools/events.ts'
import { registerImageTools } from './tools/images.ts'
import { registerKeyTools } from './tools/keys.ts'
import { registerRequestTools } from './tools/request.ts'
import { registerUploadTools } from './tools/upload.ts'
import { getClient } from './vrchat/client.ts'
import { type EventClientLike, startEventPipeline } from './vrchat/events.ts'

function createServer() {
	const server = new McpServer(
		{ name: config.appName, version: config.appVersion },
		{ capabilities: { tools: {} } }
	)

	// Auth tools ignore every gate: they are not VRChat API operations, and a
	// server you cannot ask "why am I not authenticated?" is undiagnosable.
	registerAuthTools(server)

	// Registered even with writes off, so the tool can explain the gate rather
	// than simply not existing when an agent goes looking for it.
	registerUploadTools(server)

	// Read-only, so they need no gate.
	registerImageTools(server)
	registerKeyTools(server)

	// Gates itself per call, from the method and path.
	registerRequestTools(server)

	if (config.websocket) {
		registerEventTools(server)

		// The pipeline needs a client, and `getClient()` throws when credentials
		// are missing — so this must never be allowed to escape. Startup has to
		// survive an unconfigured environment: `tools/list` working with no
		// credentials at all is the property that makes the server inspectable,
		// and enabling the websocket must not be what takes it away.
		void (async () => {
			try {
				// `authenticate()` is public at runtime but marked private in the
				// SDK's declarations, so the structural match needs the cast.
				await startEventPipeline(getClient() as unknown as EventClientLike)
			} catch (error) {
				console.error(
					`[vrchat-mcp] event pipeline not started: ${error instanceof Error ? error.message : String(error)}`
				)
			}
		})()
	}

	const { registered, skipped } = registerGeneratedTools(server)

	// Said loudly, because the symptom is an empty tool list rather than an error.
	const unknown = unknownTags()
	if (unknown.length > 0) {
		console.error(
			`[vrchat-mcp] WARNING: VRCHAT_MCP_TAGS contains unknown ${
				unknown.length === 1 ? 'tag' : 'tags'
			}: ${unknown.join(', ')}
` +
				`[vrchat-mcp] valid tags: ${knownTags().join(', ')} (or 'everything' for no filter)`
		)
	}

	console.error(
		`[vrchat-mcp] ${registered.length} tools registered, ${skipped.length} gated off` +
			` (writes=${config.allowWrites} destructive=${config.allowDestructive}` +
			` purchases=${config.allowPurchases} admin=${config.allowAdmin}` +
			` tags=${config.tags ? [...config.tags].join(',') : 'all'} websocket=${config.websocket})`
	)

	return server
}

serveStdio(createServer, {
	onerror: (error) => console.error('[vrchat-mcp] transport error:', error.message)
})
