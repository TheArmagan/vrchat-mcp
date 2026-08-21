/**
 * The safety rail for the live suite.
 *
 * These tests hit a real, rate-limited VRChat account, so the danger is not a
 * failing assertion — it is a passing one that spent money or deleted an
 * account on the way. Every live call goes through `liveCall`, which refuses
 * `money` and `admin` operations outright. A test suite must not be able to
 * buy something.
 */

import { operationsById } from '../../src/generated/operations.ts'
import type { Operation, OperationKind } from '../../src/types.ts'
import { ensureAuthenticated, getClient } from '../../src/vrchat/client.ts'
import { getBroker } from '../../src/vrchat/twofactor.ts'

/** Classes the live suite may never invoke, whatever a test asks for. */
const FORBIDDEN: readonly OperationKind[] = ['money', 'admin']

export class ForbiddenOperationError extends Error {
	override readonly name = 'ForbiddenOperationError'

	constructor(operationId: string, kind: OperationKind) {
		super(
			`Live tests refuse to call "${operationId}": it is classified ${kind}. ` +
				'Money and admin operations are permanently out of scope for the live suite.'
		)
	}
}

/** Artifacts created by a test, torn down in reverse order after the run. */
const cleanups: (() => Promise<void>)[] = []

/**
 * Registers a teardown for something a test created. Reverse order, because a
 * later artifact may depend on an earlier one.
 */
export function onCleanup(teardown: () => Promise<void>): void {
	cleanups.push(teardown)
}

export async function runCleanups(): Promise<void> {
	for (const teardown of cleanups.reverse()) {
		try {
			await teardown()
		} catch (error) {
			// Report and keep going: one stuck teardown must not strand the rest,
			// or a failed run leaves artifacts scattered across a real account.
			console.error(
				`[live] cleanup failed: ${error instanceof Error ? error.message : String(error)}`
			)
		}
	}
	cleanups.length = 0
}

export interface LiveResult<T = unknown> {
	data?: T
	error?: unknown
	response?: Response
}

/**
 * Calls one operation against the real API.
 *
 * Routed through `getClient()` so it shares production's rate limiter, session,
 * User-Agent and proxy — a live run that bypassed the limiter would be exactly
 * the run most likely to get the account throttled.
 */
export async function liveCall<T = unknown>(
	operationId: string,
	args: { path?: Record<string, unknown>; query?: Record<string, unknown>; body?: Record<string, unknown> } = {}
): Promise<LiveResult<T>> {
	const operation: Operation | undefined = operationsById[operationId]

	if (!operation) throw new Error(`Unknown operation "${operationId}".`)
	if (FORBIDDEN.includes(operation.kind)) {
		throw new ForbiddenOperationError(operationId, operation.kind)
	}

	const client = getClient()
	await ensureAuthenticated()

	const method = (client as unknown as Record<string, unknown>)[operationId]
	const options = { ...args, throwOnError: false }

	if (typeof method === 'function') {
		const call = method as (this: unknown, options: unknown) => Promise<LiveResult<T>>
		return await call.call(client, options)
	}

	return (await client.client[operation.method]({
		url: operation.path,
		...options
	})) as LiveResult<T>
}

/** Marks anything this suite creates, so strays are identifiable in-game. */
export const ARTIFACT_TAG = 'vrchat-mcp-live-test'

/** How long to let a login run before concluding it is parked on a code. */
const LOGIN_DEADLINE_MS = 20_000

/**
 * Logs in, or fails fast with an actionable message.
 *
 * An account on email OTP with no persisted session parks the login on the
 * two-factor broker for `VRCHAT_MCP_2FA_TIMEOUT_MS` — five minutes by default,
 * with no test able to supply the emailed code. Left alone that reads as a
 * hung suite, and every subsequent describe block pays the same wait again.
 * So: watch for the broker parking, cancel it, and say exactly what to do.
 */
export async function liveLogin(): Promise<string> {
	const broker = getBroker()

	// `ensureAuthenticated` is what actually drives the login; `getCurrentUser`
	// alone would come back 200 with `requiresTwoFactorAuth` and never prompt.
	const login = ensureAuthenticated().then(() => liveCall<{ id?: string }>('getCurrentUser'))

	// Surface the rejection we may cause below without an unhandled rejection.
	login.catch(() => {})

	const deadline = Date.now() + LOGIN_DEADLINE_MS

	while (Date.now() < deadline) {
		const pending = broker.status()

		if (pending.state === 'awaiting_code') {
			broker.cancel('Live tests cannot answer an interactive two-factor prompt.')

			throw new Error(
				`This account requires a ${pending.pending?.method ?? 'two-factor'} code, and the live ` +
					'suite cannot answer an interactive prompt. Either set VRCHAT_TOTP_SECRET for ' +
					'unattended login, or start the server once (`bun run start`), submit the code via ' +
					'vrchat_submitTwoFactorCode, and re-run — the persisted session then skips 2FA.'
			)
		}

		const settled = await Promise.race([
			login.then((result) => result, () => null),
			Bun.sleep(250).then(() => undefined)
		])

		if (settled !== undefined) {
			if (settled?.data?.id) return settled.data.id
			break
		}
	}

	throw new Error(
		'Live login did not complete. Check VRCHAT_USERNAME / VRCHAT_PASSWORD, and that ' +
			'VRCHAT_MCP_PROXY (if set) is reachable.'
	)
}
