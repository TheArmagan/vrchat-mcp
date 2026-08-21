/**
 * Turns the generated operation table into MCP tools.
 *
 * Every gate an operation must pass to be registered lives here, as does the
 * single shared handler all ~250 tools run through. Keeping one handler means
 * the rate limiter, the error mapping and the `_responseKeys` projection are
 * applied uniformly rather than re-implemented per tool.
 */

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { config } from './config.ts'
import { describeError, toToolError } from './errors.ts'
import { operations } from './generated/operations.ts'
import { PROJECTION_HELP, project } from './project.ts'
import type { Operation, OperationKind } from './types.ts'
import { getClient } from './vrchat/client.ts'

/** Default page size for paginated operations, mirrored from codegen. */
const DEFAULT_PAGE_SIZE = 25

/**
 * Whether an operation's safety class is unlocked by the current env.
 *
 * The three gates are deliberately independent: `admin` is not implied by
 * `writes`, so granting an agent the ability to edit your own content never
 * also grants it the ability to delete the account.
 */
export function passesKindGate(kind: OperationKind): boolean {
	switch (kind) {
		case 'read':
			return true
		case 'write':
		case 'destructive':
			return config.allowWrites
		case 'money':
			return config.allowWrites && config.allowPurchases
		case 'admin':
			return config.allowAdmin
	}
}

/** Unset `VRCHAT_MCP_TAGS` means every tag registers. */
export function passesTagGate(tag: string): boolean {
	return config.tags === null || config.tags.has(tag.toLowerCase())
}

export function shouldRegister(operation: Operation): boolean {
	return passesTagGate(operation.tag) && passesKindGate(operation.kind)
}

/** `vrchat__` — the double underscore marks a tool as generated from the spec. */
export function toolNameFor(operation: Operation): string {
	return `vrchat__${operation.operationId}`
}

/**
 * MCP annotations, as defense in depth on top of the env gates: a client that
 * surfaces them can prompt even though the gate already had to be opened.
 */
function annotationsFor(operation: Operation) {
	return {
		title: operation.summary || operation.operationId,
		readOnlyHint: operation.kind === 'read',
		destructiveHint:
			operation.kind === 'destructive' || operation.kind === 'money' || operation.kind === 'admin'
	}
}

/**
 * Builds the tool description from the spec, and names the response's
 * top-level fields when the spec knows them — that turns the common
 * `_responseKeys` case into zero discovery round-trips.
 */
function describeOperation(operation: Operation): string {
	const parts = [operation.summary || operation.operationId]

	if (operation.description) parts.push(operation.description)

	parts.push(`${operation.method.toUpperCase()} ${operation.path} (tag: ${operation.tag}, ${operation.kind})`)

	if (operation.responseKeys.length > 0) {
		parts.push(`Response fields: ${operation.responseKeys.join(', ')}.`)
	}

	if (operation.paginated) {
		parts.push(
			`Returns one page. \`nextOffset\` is echoed back for the following page — there is no internal pagination loop, so ask for the next page explicitly.`
		)
	}

	parts.push(PROJECTION_HELP)

	return parts.join('\n\n')
}

/** The projection argument every generated tool carries. */
const responseKeysSchema = z
	.array(z.string())
	.default(['*'])
	.describe(
		'Fields to keep from the raw response. Default ["*"] returns the untouched payload; narrow it to avoid burning context on fat objects. Supports dot paths, "*" per element, "**" for any depth, and a leading "!" to exclude.'
	)

/**
 * Merges the operation's own arguments with `_responseKeys`.
 *
 * Codegen already asserts no VRChat parameter is named `_responseKeys`, so
 * this extension cannot silently shadow a real API argument.
 */
function inputSchemaFor(operation: Operation) {
	const base = operation.inputSchema as z.ZodObject<z.ZodRawShape>
	return base.extend({ _responseKeys: responseKeysSchema })
}

/**
 * Splits validated arguments back into the request parts the SDK expects.
 * Path params were flattened into one object at codegen time; this is the
 * reassembly step.
 */
export function splitArguments(operation: Operation, args: Record<string, unknown>) {
	const path: Record<string, unknown> = {}
	const query: Record<string, unknown> = {}
	const body: Record<string, unknown> = {}

	for (const name of operation.params.path) {
		if (args[name] !== undefined) path[name] = args[name]
	}

	for (const name of operation.params.query) {
		if (args[name] !== undefined) query[name] = args[name]
	}

	for (const name of operation.params.body ?? []) {
		if (args[name] !== undefined) body[name] = args[name]
	}

	return {
		path,
		query,
		body: operation.params.body === null ? undefined : body
	}
}

/**
 * The offset the agent should pass to get the next page.
 *
 * Returns null when the page came back short, which is the only reliable
 * end-of-results signal the VRChat API gives us — it reports no total.
 */
export function nextOffsetFor(
	args: Record<string, unknown>,
	data: unknown
): number | null {
	if (!Array.isArray(data)) return null

	const limit = typeof args.n === 'number' ? args.n : DEFAULT_PAGE_SIZE
	if (data.length < limit) return null

	const offset = typeof args.offset === 'number' ? args.offset : 0
	return offset + data.length
}

/** What a `throwOnError: false` SDK call resolves to. */
type SdkResult = { data?: unknown; error?: unknown }

/**
 * Calls the SDK method named after the operation, falling back to a raw
 * request when the installed SDK has no such method.
 *
 * Codegen reports the gaps (currently ten, mostly 2FA management endpoints):
 * the spec moves faster than the client library, and an operation the spec
 * defines should still be callable rather than 1:1 coverage quietly becoming
 * a lie. The fallback goes through the same client, so cookies, the User-Agent,
 * the proxy and the rate limiter all still apply.
 */
async function invoke(
	operation: Operation,
	request: { path: Record<string, unknown>; query: Record<string, unknown>; body: Record<string, unknown> | undefined }
): Promise<SdkResult> {
	const client = getClient()
	const method = (client as unknown as Record<string, unknown>)[operation.operationId]

	const options = { ...request, throwOnError: false }

	if (typeof method === 'function') {
		const call = method as (this: unknown, options: unknown) => Promise<SdkResult>
		return await call.call(client, options)
	}

	return (await client.client[operation.method]({
		url: operation.path,
		...options
	})) as SdkResult
}

function textResult(payload: unknown) {
	return {
		content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }]
	}
}

/**
 * The one handler shared by every generated tool: split args, call through the
 * rate-limited client, then project. Nothing operation-specific happens here,
 * which is why the safety and shaping behaviour cannot drift between tools.
 */
async function handle(operation: Operation, rawArgs: Record<string, unknown>) {
	const { _responseKeys: responseKeys = ['*'], ...args } = rawArgs

	try {
		const { path, query, body } = splitArguments(operation, args)

		const result = await invoke(operation, { path, query, body })

		if (result.error) return toToolError(result.error)

		const projected = project(result.data, responseKeys as string[])

		if (!operation.paginated) return textResult(projected)

		const nextOffset = nextOffsetFor(args, result.data)
		return textResult({ data: projected, nextOffset })
	} catch (error) {
		return toToolError(error)
	}
}

/**
 * Registers every generated operation that passes the gates.
 * Returns a summary so the entry point can report what it exposed — to stderr.
 */
export function registerGeneratedTools(server: McpServer) {
	const registered: string[] = []
	const skipped: string[] = []

	for (const operation of operations) {
		if (!shouldRegister(operation)) {
			skipped.push(operation.operationId)
			continue
		}

		const name = toolNameFor(operation)

		server.registerTool(
			name,
			{
				description: describeOperation(operation),
				inputSchema: inputSchemaFor(operation),
				annotations: annotationsFor(operation)
			},
			async (args: Record<string, unknown>) => handle(operation, args)
		)

		registered.push(name)
	}

	return { registered, skipped }
}

export { describeError }
