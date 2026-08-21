/**
 * Pending-code broker for two-factor login.
 *
 * The VRChat SDK's `credentials.twoFactorCode` is a `Lazy<string>` — it may be
 * an async function, and the SDK awaits it before verifying. That is the hook
 * this module hangs on: instead of computing a code, `requestCode()` parks on a
 * deferred that the `vrchat_submitTwoFactorCode` tool resolves later. No code
 * is ever guessed, and none is ever logged.
 *
 * The SDK passes no arguments to that callback, so it cannot tell us whether
 * VRChat wants an emailed code or an authenticator code. `noteMethods()` is fed
 * by the client's `fetch` override, which sniffs `requiresTwoFactorAuth` off the
 * login response before the callback runs.
 */

import type { PendingTwoFactor, TwoFactorMethod } from '../types.ts'
import { config } from '../config.ts'

interface PendingRequest extends PendingTwoFactor {
	resolve: (code: string) => void
	reject: (reason: unknown) => void
	timer: ReturnType<typeof setTimeout>
	promise: Promise<string>
}

export interface BrokerOptions {
	/** How long a parked login waits before giving up. */
	timeoutMs?: number
}

/** VRChat's method names, in the order we prefer to prompt for them. */
function deriveMethod(methods: readonly string[]): TwoFactorMethod {
	if (methods.includes('emailOtp')) return 'emailOtp'
	if (methods.includes('totp')) return 'totp'
	if (methods.includes('otp')) return 'otp'
	return 'unknown'
}

/** Human-facing instruction for a method, used in the prompt the agent relays. */
function describeMethod(method: TwoFactorMethod): string {
	switch (method) {
		case 'emailOtp':
			return 'VRChat emailed a 6-digit code to the account address'
		case 'totp':
			return 'VRChat wants the 6-digit code from the authenticator app'
		case 'otp':
			return 'VRChat wants a one-time recovery code'
		default:
			return 'VRChat wants a two-factor code'
	}
}

export class TwoFactorBroker {
	private readonly timeoutMs: number
	private pending: PendingRequest | null = null
	/** Last method seen on the wire, so a prompt raised later still names it. */
	private lastMethod: TwoFactorMethod = 'unknown'

	constructor(options: BrokerOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? config.twoFactorTimeoutMs
	}

	/** Called by the client's fetch sniffer with the login response's array. */
	noteMethods(methods: readonly string[]): void {
		this.lastMethod = deriveMethod(methods)
		// The sniffer normally lands before the callback, but the SDK also retries
		// login on 401, so an already-parked request may learn its method late.
		if (this.pending) this.pending.method = this.lastMethod
	}

	/**
	 * Wired to `credentials.twoFactorCode`. Returns a promise that stays parked
	 * until a code is submitted, so the login — and the tool call that triggered
	 * it — waits rather than failing.
	 */
	requestCode(): Promise<string> {
		// The SDK single-flights `authenticate()`, so a concurrent burst should
		// reach here once. If it somehow doesn't, reuse the live request instead
		// of orphaning the requestId the user was already given.
		if (this.pending) return this.pending.promise

		const requestId = randomRequestId()
		const { promise, resolve, reject } = Promise.withResolvers<string>()

		const timer = setTimeout(() => {
			if (this.pending?.requestId !== requestId) return
			this.pending = null
			reject(
				new Error(
					`Two-factor request ${requestId} expired after ${Math.round(this.timeoutMs / 1000)}s with no code. Retry the original tool call to start a new login.`
				)
			)
		}, this.timeoutMs)

		this.pending = {
			requestId,
			method: this.lastMethod,
			expiresAt: Date.now() + this.timeoutMs,
			resolve,
			reject,
			timer,
			promise
		}

		console.error(`[vrchat-mcp] two-factor code requested (${requestId}, ${this.lastMethod})`)
		return promise
	}

	/**
	 * Resolves the parked login. Returns a result rather than throwing so the
	 * tool can report a bad requestId as a normal, actionable answer.
	 */
	submitCode(requestId: string, code: string): { ok: boolean; message: string } {
		const pending = this.pending

		if (!pending) {
			return {
				ok: false,
				message:
					'No two-factor request is pending. It may have already been answered or expired — call the tool you wanted again to start a fresh login.'
			}
		}

		if (pending.requestId !== requestId) {
			return {
				ok: false,
				message: `Unknown requestId "${requestId}". The pending request is "${pending.requestId}" — submit against that one.`
			}
		}

		const trimmed = code.trim()
		if (!trimmed) {
			return { ok: false, message: 'The code was empty. Ask the user for the code and submit again.' }
		}

		clearTimeout(pending.timer)
		this.pending = null
		pending.resolve(trimmed)

		return { ok: true, message: 'Code submitted; the parked login is continuing.' }
	}

	/** Drops any parked request — used by `logout()` so a stale prompt can't resolve. */
	cancel(reason = 'The pending two-factor request was cancelled.'): void {
		const pending = this.pending
		if (!pending) return
		clearTimeout(pending.timer)
		this.pending = null
		pending.reject(new Error(reason))
	}

	status(): { state: 'idle' | 'awaiting_code'; pending: PendingTwoFactor | null } {
		const pending = this.pending
		if (!pending) return { state: 'idle', pending: null }
		return {
			state: 'awaiting_code',
			pending: { requestId: pending.requestId, method: pending.method, expiresAt: pending.expiresAt }
		}
	}
}

/**
 * The message the blocked tool call should hand back to the agent, naming the
 * method so the user is told where to look for the code.
 *
 * The new-location warning is not decoration. VRChat reports this state as an
 * ordinary `emailOtp` request, so the two cases are indistinguishable from the
 * API alone, and a user who was sent a confirmation link will otherwise sit
 * hunting for a six-digit code that was never in the message.
 */
export function twoFactorPrompt(pending: PendingTwoFactor, retryTool?: string): string {
	const retry = retryTool ? `retry ${retryTool}` : 'retry the original call'

	if (pending.method === 'emailOtp' || pending.method === 'unknown') {
		return (
			`Login paused: ${describeMethod(pending.method)}. Ask the user what the email contains. ` +
			`If it is a code, call vrchat_submitTwoFactorCode { requestId: '${pending.requestId}', code: '……' } and ${retry}. ` +
			'If instead it says the account is being accessed from somewhere new and offers a link, ' +
			'that is VRChat verifying the location, not a code. Have the user open the link, then call ' +
			`vrchat_retryLogin: the code email only arrives on the next attempt. Do not ${retry} until one of those succeeds.`
		)
	}

	return `Login paused: ${describeMethod(pending.method)}. Ask the user for it, call vrchat_submitTwoFactorCode { requestId: '${pending.requestId}', code: '……' }, then ${retry}.`
}

function randomRequestId(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString('hex')
}

let shared: TwoFactorBroker | undefined

/** The single broker the client and the auth tools both talk to. */
export function getBroker(): TwoFactorBroker {
	shared ??= new TwoFactorBroker()
	return shared
}
