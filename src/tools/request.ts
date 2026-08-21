/**
 * `vrchat_request` — call any VRChat endpoint directly.
 *
 * The generated tools cover the spec, but the spec is community-maintained and
 * says so: `createProductListingDirect` documents its own body as "based on
 * observed fields and may be incomplete". When the schema and the API disagree,
 * the schema loses and there has to be a way through that does not involve
 * waiting for an upstream fix and a codegen run.
 *
 * This is not a hole in the safety model. The same classification and the same
 * env gates apply, worked out from the method and path rather than looked up by
 * operationId, so a raw DELETE needs exactly what `vrchat__deleteProduct`
 * needs.
 */

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { describeError, toToolError } from '../errors.ts'
import { project } from '../project.ts'
import { passesKindGate } from '../registry.ts'
import type { OperationKind } from '../types.ts'
import { ensureAuthenticated, getClient } from '../vrchat/client.ts'

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

/** Mirrors the codegen classifier, which works from the same two signals. */
const MONEY_PATH = /tilia|kyc|payout|purchase/i
const ADMIN_PATH = /moderationReports|avatarmoderations|\/auth\/user\/delete|registerUserAccount/i

/**
 * Safety class for an arbitrary call.
 *
 * Deliberately more cautious than the generated table: without an operationId
 * there is no override list to consult, so anything touching a money or admin
 * path is treated as such on the strength of the path alone.
 */
export function classifyRequest(method: string, path: string): OperationKind {
	if (ADMIN_PATH.test(path)) return 'admin'
	if (MONEY_PATH.test(path)) return 'money'
	if (method === 'delete') return 'destructive'
	return method === 'get' ? 'read' : 'write'
}

function json(value: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

export function registerRequestTools(server: McpServer): void {
	server.registerTool(
		'vrchat_request',
		{
			title: 'Call a VRChat endpoint directly',
			description:
				'Sends a request to any VRChat API path with a body you control completely, bypassing the generated schemas. Use this when a generated tool rejects or drops a field the API actually needs: parts of the VRChat spec are marked incomplete upstream, so its idea of a request body is sometimes wrong. `path` is relative to https://api.vrchat.cloud/api/1, for example "/listing" or "/users/usr_.../feedback". Runs through the same session, proxy and rate limiter as every other tool, and is gated by the same env flags, worked out from the method and path: GET needs nothing, POST/PUT/PATCH need VRCHAT_MCP_ALLOW_WRITES, DELETE also needs VRCHAT_MCP_ALLOW_DESTRUCTIVE_WRITES.',
			inputSchema: z.object({
				method: z.enum(METHODS).default('get').describe('HTTP method.'),
				path: z
					.string()
					.describe('Path relative to the API root, e.g. "/listing". A full URL is also accepted.'),
				query: z
					.record(z.string(), z.unknown())
					.optional()
					.describe('Query string parameters.'),
				body: z
					.record(z.string(), z.unknown())
					.optional()
					.describe('JSON request body, sent exactly as given. Ignored for GET.'),
				_responseKeys: z
					.array(z.string())
					.default(['*'])
					.describe('Fields to keep from the response. Default ["*"] returns everything.')
			}),
			annotations: {
				title: 'Call a VRChat endpoint directly',
				readOnlyHint: false,
				destructiveHint: true,
				openWorldHint: true
			}
		},
		async ({ method, path, query, body, _responseKeys }) => {
			try {
				// A full URL is accepted for convenience, but only for the API host:
				// the session cookie rides on this request.
				let route = path.trim()

				if (/^https?:\/\//i.test(route)) {
					const url = new URL(route)
					if (url.hostname !== 'api.vrchat.cloud') {
						return toToolError(
							Object.assign(new Error(`Refusing to send a VRChat session to ${url.hostname}.`), {
								hint: 'Pass a path relative to the API root, or a URL on api.vrchat.cloud.'
							})
						)
					}
					route = url.pathname.replace(/^\/api\/1/, '') + url.search
				}

				if (!route.startsWith('/')) route = `/${route}`

				const kind = classifyRequest(method, route)

				if (!passesKindGate(kind)) {
					return toToolError(
						Object.assign(new Error(`${method.toUpperCase()} ${route} classifies as \`${kind}\`.`), {
							hint: `This tool obeys the same gates as the generated tools. Ask the user to enable ${kind} operations in the server environment, then retry.`
						})
					)
				}

				await ensureAuthenticated()
				const client = getClient()

				const result = (await client.client[method]({
					url: route,
					...(query ? { query } : {}),
					...(body && method !== 'get' ? { body } : {}),
					throwOnError: false
				})) as { data?: unknown; error?: unknown }

				if (result.error) return toToolError(result.error)

				return json({
					method: method.toUpperCase(),
					path: route,
					kind,
					data: project(result.data, _responseKeys)
				})
			} catch (cause) {
				return { ...json(describeError(cause)), isError: true as const }
			}
		}
	)
}
