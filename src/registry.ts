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
import { resolveUploads } from './upload.ts'
import type { Operation, OperationKind } from './types.ts'
import { ensureAuthenticated, getClient, LoginPendingError, TwoFactorRequiredError } from './vrchat/client.ts'

/** Default page size for paginated operations, mirrored from codegen. */
const DEFAULT_PAGE_SIZE = 25

/**
 * Whether an operation's safety class is unlocked by the current env.
 *
 * Destructive and money operations layer on top of writes, so enabling writes
 * grants exactly the ability to create and edit, never to delete or to spend.
 * Admin stands apart and is not implied by anything: letting an agent edit your
 * own content must never also let it delete the account.
 */
export function passesKindGate(kind: OperationKind): boolean {
	switch (kind) {
		case 'read':
			return true
		case 'write':
			return config.allowWrites
		case 'destructive':
			return config.allowWrites && config.allowDestructive
		case 'money':
			return config.allowWrites && config.allowPurchases
		case 'admin':
			return config.allowAdmin
	}
}

/**
 * Unset `VRCHAT_MCP_TAGS` means every tag registers. Otherwise an operation
 * needs to answer to at least one requested tag, which includes the synthetic
 * ones codegen adds (`store`) alongside the spec's own.
 */
export function passesTagGate(tags: readonly string[]): boolean {
	if (config.tags === null) return true
	return tags.some((tag) => config.tags!.has(tag.toLowerCase()))
}

export function shouldRegister(operation: Operation): boolean {
	return passesTagGate(operation.tags) && passesKindGate(operation.kind)
}

/** The env var that unlocks each safety class, for reporting. */
const KIND_ENV: Record<OperationKind, string | null> = {
	read: null,
	write: 'VRCHAT_MCP_ALLOW_WRITES=1',
	destructive: 'VRCHAT_MCP_ALLOW_WRITES=1 and VRCHAT_MCP_ALLOW_DESTRUCTIVE_WRITES=1',
	money: 'VRCHAT_MCP_ALLOW_WRITES=1 and VRCHAT_MCP_ALLOW_PURCHASES=1',
	admin: 'VRCHAT_MCP_ALLOW_ADMIN=1'
}

/**
 * What is currently exposed and what is not, and the env change that would
 * expose it.
 *
 * A tool that is gated off is simply absent, which reads to an agent as "VRChat
 * cannot do this" rather than "this server was told not to". That mistake has
 * already been made once in the wild: an agent reported the economy API as
 * read-only when the write tools existed and were merely behind a flag. This is
 * the surface that lets it say "ask the user to set X" instead.
 */
export function describeGates() {
	const tagCounts = new Map<string, { total: number; registered: number }>()

	for (const operation of operations) {
		const visible = shouldRegister(operation)
		for (const tag of operation.tags) {
			const entry = tagCounts.get(tag) ?? { total: 0, registered: 0 }
			entry.total += 1
			if (visible) entry.registered += 1
			tagCounts.set(tag, entry)
		}
	}

	const byTag = [...tagCounts].sort((a, b) => a[0].localeCompare(b[0]))
	const selected = (tag: string) => passesTagGate([tag])

	const kinds = {} as Record<
		OperationKind,
		{ enabled: boolean; total: number; hidden: number; enableWith: string | null }
	>

	for (const kind of ['read', 'write', 'destructive', 'money', 'admin'] as const) {
		const all = operations.filter((operation) => operation.kind === kind)
		const enabled = passesKindGate(kind)
		kinds[kind] = {
			enabled,
			total: all.length,
			hidden: enabled ? 0 : all.length,
			enableWith: enabled ? null : KIND_ENV[kind]
		}
	}

	const registered = operations.filter(shouldRegister).length
	const nextSteps: string[] = []

	for (const kind of ['write', 'destructive', 'money', 'admin'] as const) {
		if (!kinds[kind].enabled) {
			nextSteps.push(
				`${kinds[kind].total} \`${kind}\` operations are hidden. Ask the user to set ${KIND_ENV[kind]} in the server environment (.env) and restart the server.`
			)
		}
	}

	if (config.tags !== null) {
		const off = byTag.filter(([tag]) => !selected(tag)).map(([tag]) => tag)
		nextSteps.push(
			`VRCHAT_MCP_TAGS is restricting tools to ${[...config.tags].join(', ')}. ${
				off.length
			} other tags are hidden (${off.join(', ')}). Ask the user to widen or unset VRCHAT_MCP_TAGS.`
		)
	}

	return {
		toolsRegistered: registered,
		toolsHidden: operations.length - registered,
		tagFilter: config.tags === null ? null : [...config.tags],
		tags: byTag.map(([tag, counts]) => ({
			tag,
			selected: selected(tag),
			registered: counts.registered,
			total: counts.total
		})),
		kinds,
		nextSteps:
			nextSteps.length > 0
				? nextSteps
				: ['Everything the spec defines is registered; nothing is gated off.']
	}
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

	parts.push(
		`${operation.method.toUpperCase()} ${operation.path} (tags: ${operation.tags.join(', ')}, ${operation.kind})`
	)

	if (operation.responseKeys.length > 0) {
		parts.push(`Response fields: ${operation.responseKeys.join(', ')}.`)
	}

	if (operation.binaryFields.length > 0) {
		const names = operation.binaryFields.map((field) => '`' + field + '`').join(', ')
		parts.push(
			'Uploads a file. Pass a LOCAL FILE PATH for ' +
				names +
				' and the server reads the file itself. Never paste file contents or base64.'
		)
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

	// VRChat answers a partial session with 200 + `requiresTwoFactorAuth`, not a
	// 401, so nothing else would ever drive the login.
	await ensureAuthenticated()

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

		// Binary fields arrive as paths; the SDK needs the file itself.
		const { uploaded } =
			operation.binaryFields.length > 0 && body
				? await resolveUploads(body, operation.binaryFields)
				: { uploaded: [] }

		const result = await invoke(operation, { path, query, body })

		if (result.error) return toToolError(result.error)

		const projected = project(result.data, responseKeys as string[])

		// Naming the bytes actually sent is the only way to tell a successful
		// upload of the right file from one of the wrong file.
		if (uploaded.length > 0) return textResult({ uploaded, result: projected })

		if (!operation.paginated) return textResult(projected)

		const nextOffset = nextOffsetFor(args, result.data)
		return textResult({ data: projected, nextOffset })
	} catch (error) {
		// A parked login is not a failure, and reporting it as one invites the
		// agent to give up. The login is still running: answering the prompt
		// completes it and the retry then succeeds.
		if (error instanceof TwoFactorRequiredError) {
			return textResult({
				status: 'login_paused',
				requestId: error.pending.requestId,
				method: error.pending.method,
				message: error.message,
				retryTool: toolNameFor(operation)
			})
		}

		// Someone else's login is still running. Reporting that plainly is far
		// better than holding this call open: the agent retries one tool instead
		// of stalling every tool it fired off at once.
		if (error instanceof LoginPendingError) {
			return textResult({
				status: 'login_pending',
				message: error.message,
				retryTool: toolNameFor(operation),
				nextStep:
					'Wait a moment and call this tool again. If it keeps reporting this, call vrchat_authStatus.'
			})
		}

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
