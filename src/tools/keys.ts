/**
 * `vrchat_availableKeys` — ask what a response contains, without fetching it.
 *
 * `_responseKeys` only pays off if you know what to ask for, and the key list
 * used to ride along on every response to solve that. It solved it by taxing
 * every successful call to serve the occasional one that needed help. This
 * moves the cost to the caller who wants it.
 *
 * Codegen already stores the spec's declared top-level response fields, so the
 * common case is answered with no request at all.
 */

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { describeError, toToolError } from '../errors.ts'
import { operationsById } from '../generated/operations.ts'
import { keyOutline, project } from '../project.ts'
import { shouldRegister, toolNameFor } from '../registry.ts'
import { ensureAuthenticated, getClient } from '../vrchat/client.ts'

function json(value: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

/** Accepts `vrchat__getUser` or plain `getUser`, since agents use both. */
function resolveOperation(name: string) {
	const id = name.replace(/^vrchat__/, '').trim()
	return operationsById[id]
}

export function registerKeyTools(server: McpServer): void {
	server.registerTool(
		'vrchat_availableKeys',
		{
			title: 'List the fields a VRChat response contains',
			description:
				'Reports the field names a tool returns, so you can pick `_responseKeys` without fetching a full payload first and without guessing. Answers from the OpenAPI spec with no API call when the spec describes the response, which is the usual case. Pass `live: true` (with whatever arguments the operation needs) to make one real call and outline the actual shape instead, including nested fields; use that when the spec has nothing, or when you need to see below the top level. A live call can also return the data itself: pass `_responseKeys` and the projected response comes back alongside the outline, so you do not pay for the same request twice. Read-only.',
			inputSchema: z.object({
				tool: z
					.string()
					.describe('Tool or operation name, e.g. "vrchat__getUser" or "getUser".'),
				live: z
					.boolean()
					.default(false)
					.describe('Make one real call and outline the response it actually returns.'),
				arguments: z
					.record(z.string(), z.unknown())
					.optional()
					.describe('Arguments for the live call. Required arguments still apply.'),
				depth: z
					.number()
					.int()
					.min(1)
					.max(5)
					.default(2)
					.describe('How many levels deep to outline, for a live call.'),
				_responseKeys: z
					.array(z.string())
					.default([])
					.describe(
						'Also return response data from the same live call, projected to these paths. Empty (the default) returns the outline alone. Use ["*"] for the whole payload. This is how you avoid paying for a second request once you know what you want.'
					)
			}),
			annotations: {
				title: 'List the fields a VRChat response contains',
				readOnlyHint: true,
				openWorldHint: true
			}
		},
		async ({ tool, live, arguments: args, depth, _responseKeys }) => {
			const operation = resolveOperation(tool)

			if (!operation) {
				return toToolError(
					Object.assign(new Error(`No VRChat operation named "${tool}".`), {
						hint: 'Use the tool name as listed, for example vrchat__getUser.'
					})
				)
			}

			const name = toolNameFor(operation)

			if (!live) {
				if (operation.responseKeys.length === 0) {
					return json({
						tool: name,
						source: 'spec',
						keys: [],
						note: 'The spec does not describe this response. Call again with live: true to outline the real one.'
					})
				}

				return json({
					tool: name,
					source: 'spec',
					keys: operation.responseKeys,
					note: 'Top-level fields, from the spec. Pass live: true to see nested fields.'
				})
			}

			// A live outline is a real request, so it has to respect the gates the
			// operation itself would: reading keys must not become a way to invoke
			// a write that is switched off.
			if (!shouldRegister(operation)) {
				return toToolError(
					Object.assign(new Error(`${name} is not currently registered.`), {
						hint: 'Call vrchat_authStatus to see which gate is hiding it. Its declared keys are still available with live: false.'
					})
				)
			}

			try {
				await ensureAuthenticated()
				const client = getClient()
				const method = (client as unknown as Record<string, unknown>)[operation.operationId]

				const request = {
					path: {} as Record<string, unknown>,
					query: {} as Record<string, unknown>,
					body: undefined as Record<string, unknown> | undefined,
					throwOnError: false
				}

				for (const key of operation.params.path) {
					if (args?.[key] !== undefined) request.path[key] = args[key]
				}
				for (const key of operation.params.query) {
					if (args?.[key] !== undefined) request.query[key] = args[key]
				}
				if (operation.params.body) {
					request.body = {}
					for (const key of operation.params.body) {
						if (args?.[key] !== undefined) request.body[key] = args[key]
					}
				}

				const result =
					typeof method === 'function'
						? ((await (method as (this: unknown, o: unknown) => Promise<unknown>).call(
								client,
								request
							)) as { data?: unknown; error?: unknown })
						: ((await client.client[operation.method]({
								url: operation.path,
								...request
							})) as { data?: unknown; error?: unknown })

				if (result.error) return toToolError(result.error)

				return json({
					tool: name,
					source: 'live',
					depth,
					// Names and types only by default. Returning the values unasked
					// would defeat the point, since avoiding exactly that is why this
					// tool exists.
					outline: keyOutline(result.data, depth),
					// The request has already been paid for, so handing back the data
					// the caller asked for saves them making it again.
					...(_responseKeys.length > 0 ? { data: project(result.data, _responseKeys) } : {})
				})
			} catch (cause) {
				return { ...json(describeError(cause)), isError: true as const }
			}
		}
	)
}
