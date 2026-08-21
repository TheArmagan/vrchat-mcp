/**
 * Pipeline event tools. Registered only when `VRCHAT_MCP_WEBSOCKET=1`.
 *
 * All four are read-only: they observe the event stream and its durable
 * history, and none of them touch the VRChat API.
 */

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { describeResponseKeys, project } from '../project.ts'
import { getEventPipeline } from '../vrchat/events.ts'

/** `vrchat_eventsWait` must not outlive the MCP client's own request timeout. */
const WAIT_DEFAULT_MS = 30_000
const WAIT_MAX_MS = 120_000

/** Shares one help text with the generated tools so the syntax cannot drift. */
function responseKeys(fields: string[]) {
	return z.array(z.string()).default(['*']).describe(describeResponseKeys(fields))
}

const typesArg = z
	.array(z.string())
	.optional()
	.describe('Event types to include. Omit for every subscribed type.')

function result(value: unknown, keys: string[]) {
	return {
		content: [{ type: 'text' as const, text: JSON.stringify(project(value, keys)) }]
	}
}

export function registerEventTools(server: McpServer): void {
	const pipeline = getEventPipeline()

	server.registerTool(
		'vrchat_eventsRecent',
		{
			title: 'Recent VRChat events',
			description:
				'Pipeline events after a cursor, oldest-first. Echoes the newest cursor so you ' +
				'can poll incrementally without re-reading what you already have. Omit `since` ' +
				'to start from the current tail.',
			inputSchema: z.object({
				types: typesArg,
				since: z
					.number()
					.int()
					.nonnegative()
					.optional()
					.describe('Cursor from a previous call; returns events strictly after it.'),
				limit: z.number().int().min(1).max(200).default(50),
				_responseKeys: responseKeys(['events', 'cursor', 'count'])
			}),
			annotations: { readOnlyHint: true, openWorldHint: false }
		},
		async ({ types, since, limit, _responseKeys }) => {
			const latest = pipeline.history.latestCursor()
			// No cursor yet means "catch me up": hand back the newest slice in
			// chronological order so the next poll continues from `cursor`.
			const events =
				since === undefined
					? pipeline.history.search({ types, limit }).events.reverse()
					: pipeline.history.after(since, types, limit)
			return result({ events, cursor: latest, count: events.length }, _responseKeys)
		}
	)

	server.registerTool(
		'vrchat_eventsWait',
		{
			title: 'Wait for a VRChat event',
			description:
				'Blocks until the first matching pipeline event arrives or the timeout elapses. ' +
				'An empty result at timeout is a normal outcome, not an error.',
			inputSchema: z.object({
				types: typesArg,
				timeoutMs: z.number().int().min(100).max(WAIT_MAX_MS).default(WAIT_DEFAULT_MS),
				_responseKeys: responseKeys(['events', 'timedOut', 'cursor'])
			}),
			annotations: { readOnlyHint: true, openWorldHint: false }
		},
		async ({ types, timeoutMs, _responseKeys }) => {
			const events = await pipeline.wait(types, Math.min(timeoutMs, WAIT_MAX_MS))
			return result(
				{ events, timedOut: events.length === 0, cursor: pipeline.history.latestCursor() },
				_responseKeys
			)
		}
	)

	server.registerTool(
		'vrchat_eventsSearch',
		{
			title: 'Search VRChat event history',
			description:
				'Queries the durable event history, newest-first. `query` is free text over the ' +
				'decoded payload; the rest are indexed filters. `totalMatches` tells you when you ' +
				'are seeing a slice.',
			inputSchema: z.object({
				query: z.string().optional().describe('Free text matched inside the decoded content.'),
				types: typesArg,
				userId: z.string().optional().describe('Exact user id extracted at ingest.'),
				since: z.number().int().nonnegative().optional().describe('Epoch ms lower bound.'),
				until: z.number().int().nonnegative().optional().describe('Epoch ms upper bound.'),
				limit: z.number().int().min(1).max(200).default(50),
				_responseKeys: responseKeys(['events', 'totalMatches', 'limit'])
			}),
			annotations: { readOnlyHint: true, openWorldHint: false }
		},
		async ({ query, types, userId, since, until, limit, _responseKeys }) => {
			const found = pipeline.history.search({ query, types, userId, since, until, limit })
			return result(found, _responseKeys)
		}
	)

	server.registerTool(
		'vrchat_eventsStatus',
		{
			title: 'VRChat event pipeline status',
			description:
				'Connection state, subscribed types, and a per-type retention breakdown: stored ' +
				'count, effective count cap and age ceiling, oldest retained event, rows dropped, ' +
				'and which limit is currently binding. Silent trimming otherwise reads as ' +
				'"nothing happened".',
			inputSchema: z.object({
				_responseKeys: responseKeys([
					'state',
					'enabled',
					'proxied',
					'subscribedTypes',
					'lastError',
					'latestCursor',
					'search',
					'types'
				])
			}),
			annotations: { readOnlyHint: true, openWorldHint: false }
		},
		async ({ _responseKeys }) => result(pipeline.status(), _responseKeys)
	)
}
