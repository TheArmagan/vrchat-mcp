/**
 * The memoized, lazily-constructed VRChat SDK client.
 *
 * Nothing here runs at import time. `getClient()` is called on the first tool
 * that needs the API, which is what keeps `tools/list` working with no
 * credentials at all — important for stdio, where the server respawns on every
 * client start and a login at boot would fire each time with no tool call for a
 * 2FA prompt to attach to.
 */

import { dirname } from 'node:path'
import { VRChat } from 'vrchat'
import { KeyvFile } from 'keyv-file'
import { config, ensureDataDir, hasCredentials } from '../config.ts'
import { isVerifyLinkChallenge } from '../errors.ts'
import type { LimiterStatus, PendingTwoFactor } from '../types.ts'
import { getBroker, twoFactorPrompt } from './twofactor.ts'
import { getLimiter } from './ratelimit.ts'

/** Thrown when the server cannot build a client from the environment it has. */
export class ConfigurationError extends Error {
	readonly hint: string

	constructor(message: string, hint: string) {
		super(message)
		this.name = 'ConfigurationError'
		this.hint = hint
	}
}

/** Thrown when a request fails while a proxy is configured. Never carries the URL. */
export class ProxyError extends Error {
	readonly hint: string

	constructor(message: string) {
		super(message)
		this.name = 'ProxyError'
		this.hint =
			'Check VRCHAT_MCP_PROXY points at a reachable proxy. No direct connection was attempted — that would leak the real IP.'
	}
}

let client: VRChat | undefined
let sessionStore: KeyvFile | undefined
/** Live view of whether this process holds a session, for `authStatus()`. */
let sessionActive = false

/** Bun 1.3.14 rejects these schemes outright, so catch it at construction. */
const SOCKS_SCHEME = /^socks/i

export function getClient(): VRChat {
	if (client) return client

	if (!hasCredentials()) {
		throw new ConfigurationError(
			'VRChat credentials are not configured.',
			'Set VRCHAT_USERNAME and VRCHAT_PASSWORD (and VRCHAT_CONTACT) in the server environment, then retry.'
		)
	}
	// The SDK's own `isApplication` check also rejects `@example.com` and
	// newlines; catching it here turns a raw VRChatError into an actionable one.
	if (!config.contact || config.contact.includes('@example.com') || config.contact.includes('\n')) {
		throw new ConfigurationError(
			'VRCHAT_CONTACT is missing or a placeholder, and VRChat rejects requests without a real contact in the User-Agent.',
			'Set VRCHAT_CONTACT to a genuine email address or support URL (an @example.com address is refused by the SDK).'
		)
	}
	if (config.proxy && SOCKS_SCHEME.test(config.proxy)) {
		throw new ConfigurationError(
			"The installed Bun's fetch does not support SOCKS proxies (UnsupportedProxyProtocol).",
			'Use an http:// or https:// proxy in VRCHAT_MCP_PROXY, or front the SOCKS proxy with a local HTTP proxy.'
		)
	}

	ensureDataDir(config.sessionPath)
	sessionStore = new KeyvFile({ filename: config.sessionPath })

	const broker = getBroker()

	client = new VRChat({
		application: { name: config.appName, version: config.appVersion, contact: config.contact },
		keyv: sessionStore,
		// Bun's `typeof fetch` carries a `preconnect` static the SDK never calls;
		// the cast keeps the override a plain function.
		fetch: vrchatFetch as unknown as typeof fetch,
		authentication: {
			// The default `true` logs in from the constructor. False is what makes
			// login lazy — the SDK re-authenticates on the first 401 instead.
			optimistic: false,
			credentials: {
				username: config.username!,
				password: config.password!,
				totpSecret: config.totpSecret,
				// The SDK ignores `totpSecret` whenever `twoFactorCode` is set
				// (`loginWith2FA`: `... && totpSecret && !twoFactorCode`), so wiring
				// both would drag an unattended TOTP account into an interactive
				// prompt it can never answer.
				twoFactorCode: config.totpSecret ? undefined : () => broker.requestCode()
			}
		}
	})

	// `VRChat.authenticate()` calls `pipeline.authenticate(cookie)` unconditionally
	// whenever an auth cookie exists — including from the 401 re-auth interceptor,
	// and including when the websocket feature is off. That would open a socket
	// nobody asked for, burn a session slot, and (since the SDK's socket takes no
	// proxy) connect directly while the rest of the server is proxied. When the
	// feature is enabled, `EventPipeline.start()` replaces this method with its
	// own token-capture hook; when it is disabled, neutering it here is the only
	// thing standing between a disabled feature and a leaked direct connection.
	if (!config.websocket) {
		const pipeline = client.pipeline as unknown as {
			authenticate: (token: string) => Promise<void>
			close: () => void
		}

		pipeline.close()
		pipeline.authenticate = async () => {}
	}

	return client
}

/**
 * The single seam every VRChat request passes through. It carries three jobs
 * that all need the same interception point, which is why it is installed
 * unconditionally rather than only when proxying. Exported so it can be driven
 * directly against a local server in tests.
 */
export async function vrchatFetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
	const request = input instanceof Request && init === undefined ? input : new Request(input as never, init)
	const limiter = getLimiter()

	const response = await limiter.schedule(async () => {
		try {
			// Bun honours `proxy` in the init even when the first argument is a
			// Request. A failure here is never retried without the proxy.
			return config.proxy
				? await fetch(request, { proxy: config.proxy } as RequestInit)
				: await fetch(request)
		} catch (cause) {
			if (config.proxy) {
				throw new ProxyError(
					`Request failed while a proxy is configured (${(cause as { code?: string })?.code ?? 'connection error'}); the proxy may be unreachable.`
				)
			}
			throw cause
		}
	})

	// VRChat reuses 429 for "too many login places", which is an auth challenge
	// wearing a rate-limit status. Pausing the shared bucket for it would stall
	// every tool waiting out a limit that only an emailed link can clear.
	if (!(await isAuthChallenge(response))) limiter.noteResponse(response)

	await sniff(request, response)
	return response
}

/** Reads a 429 body to tell an auth challenge from a genuine rate limit. */
async function isAuthChallenge(response: Response): Promise<boolean> {
	if (response.status !== 429) return false

	try {
		return isVerifyLinkChallenge(429, await response.clone().text())
	} catch {
		// Unreadable body: treat it as a real rate limit, which is the safe
		// reading — backing off needlessly beats hammering a throttled API.
		return false
	}
}

/** Endpoints whose bodies can carry `requiresTwoFactorAuth`. */
const AUTH_PATH = /\/auth\/(user|twofactorauth)/i

/**
 * Reads the 2FA methods off the login response so the broker can say "check
 * your email" rather than something vague. Works on a clone — consuming the
 * real body would leave the SDK with a used stream.
 */
async function sniff(request: Request, response: Response): Promise<void> {
	if (response.status === 401) sessionActive = false
	if (!AUTH_PATH.test(request.url)) return
	if (!response.ok) return

	try {
		const body = (await response.clone().json()) as {
			requiresTwoFactorAuth?: unknown
			id?: unknown
			verified?: unknown
		}

		if (Array.isArray(body.requiresTwoFactorAuth) && body.requiresTwoFactorAuth.length > 0) {
			getBroker().noteMethods(body.requiresTwoFactorAuth.map(String))
			sessionActive = false
			return
		}

		// A full user object (or a verified 2FA check) means the session is live.
		if (typeof body.id === 'string' || body.verified === true) sessionActive = true
	} catch {
		// A non-JSON auth response tells us nothing; it is not an error here.
	}
}

export type AuthState = 'not_configured' | 'authenticated' | 'awaiting_code' | 'unauthenticated'

export interface AuthStatus {
	state: AuthState
	/** Present only while a login is parked on a code. */
	pending: PendingTwoFactor | null
	/** True when a session file exists, so a relaunch may skip 2FA entirely. */
	sessionStored: boolean
	credentialsConfigured: boolean
	totpConfigured: boolean
	proxyConfigured: boolean
	gates: {
		tags: string[] | null
		allowWrites: boolean
		allowPurchases: boolean
		allowAdmin: boolean
		websocket: boolean
	}
	limiter: LimiterStatus
	hint: string
}

export async function authStatus(): Promise<AuthStatus> {
	const twoFactor = getBroker().status()
	const configured = hasCredentials()
	const sessionStored = await Bun.file(config.sessionPath)
		.exists()
		.catch(() => false)

	const state: AuthState = !configured
		? 'not_configured'
		: twoFactor.state === 'awaiting_code'
			? 'awaiting_code'
			: sessionActive
				? 'authenticated'
				: 'unauthenticated'

	return {
		state,
		pending: twoFactor.pending,
		sessionStored,
		credentialsConfigured: configured,
		totpConfigured: Boolean(config.totpSecret),
		proxyConfigured: Boolean(config.proxy),
		gates: {
			tags: config.tags ? [...config.tags] : null,
			allowWrites: config.allowWrites,
			allowPurchases: config.allowPurchases,
			allowAdmin: config.allowAdmin,
			websocket: config.websocket
		},
		limiter: getLimiter().status(),
		hint: HINTS[state]
	}
}

const HINTS: Record<AuthState, string> = {
	not_configured:
		'Set VRCHAT_USERNAME, VRCHAT_PASSWORD and VRCHAT_CONTACT in the server environment; no API tool can run without them.',
	authenticated: 'Session is live. Call any vrchat__ tool.',
	awaiting_code:
		'A login is parked on a two-factor code. Ask the user for it and call vrchat_submitTwoFactorCode with the requestId below.',
	unauthenticated:
		'No login has happened yet in this process. Login is lazy — just call the tool you want and it will authenticate (prompting for a 2FA code if needed).'
}

/** In-flight `ensureAuthenticated`, so a cold-start burst logs in exactly once. */
let authenticating: Promise<void> | undefined

/**
 * Raised when a login is parked on a code instead of failing.
 *
 * The login keeps running in the background, so the caller must not treat this
 * as a dead end: once `vrchat_submitTwoFactorCode` resolves the broker, the
 * same login finishes and the session persists.
 */
export class TwoFactorRequiredError extends Error {
	override readonly name = 'TwoFactorRequiredError'

	constructor(
		readonly pending: PendingTwoFactor,
		message: string
	) {
		super(message)
	}
}

/** Polling interval while watching for the broker to park. */
const PARK_POLL_MS = 100

/**
 * How long a call that did *not* start the login will wait for it.
 *
 * Agents fan several tools out at once, and on a cold start every one of them
 * lands on the same unauthenticated client. Queueing them all behind the login
 * turns one slow authentication into N stalled tool calls, and a login that
 * parks on a code turns them into N duplicate prompts. Waiting briefly covers
 * the common case, where a stored session logs in within a second, and anything
 * slower is reported as pending so the agent can retry one call instead of
 * blocking on all of them.
 */
const CONCURRENT_WAIT_MS = 3_000

/**
 * How long a failed login is remembered before another is attempted.
 *
 * Without this, a fanned-out burst of tool calls becomes a burst of *logins*:
 * the first fails, clears the in-flight guard, and the next call starts another
 * one. Every attempt costs a VRChat session slot, and on the new-location check
 * every attempt sends the user another email. Retrying cannot help until either
 * the credentials or the account state changes, so the failure is cached and
 * replayed. `restartLogin()` and `logout()` clear it, which is what makes the
 * user-driven retry immediate.
 */
const FAILURE_COOLDOWN_MS = 30_000

/** The last login failure, replayed to callers until the cooldown expires. */
let lastFailure: { error: unknown; at: number } | undefined

/** Raised to a caller that arrived while someone else's login was still running. */
export class LoginPendingError extends Error {
	override readonly name = 'LoginPendingError'

	constructor() {
		super('A VRChat login is already in progress. Retry this call in a moment.')
	}
}

/**
 * Waits for the login to finish, or for the broker to park on a code.
 *
 * Awaiting the login outright would block the tool call for the broker's full
 * timeout (five minutes by default) while the agent has no idea a code is
 * wanted. Nobody can answer a prompt they were never shown, so the wait has to
 * end the moment a code is requested, not when it times out.
 */
async function raceAgainstPrompt(login: Promise<void>, waitMs?: number): Promise<void> {
	const broker = getBroker()
	const deadline = waitMs === undefined ? undefined : Date.now() + waitMs

	for (;;) {
		const settled = await Promise.race([
			login.then(() => 'done' as const),
			Bun.sleep(PARK_POLL_MS).then(() => undefined)
		])

		if (settled === 'done') return

		const status = broker.status()
		if (status.state === 'awaiting_code' && status.pending) {
			throw new TwoFactorRequiredError(status.pending, twoFactorPrompt(status.pending))
		}

		if (deadline !== undefined && Date.now() >= deadline) throw new LoginPendingError()
	}
}

/**
 * Drives a login if this process does not already hold a live session.
 *
 * The plan assumed the SDK's 401 interceptor would make login lazy for free.
 * It does not: on a *partial* session VRChat answers `/auth/user` with **200**
 * and a `requiresTwoFactorAuth` body rather than a 401, so the interceptor
 * never fires, `authenticate()` is never called, and the tool hands the agent
 * `{ requiresTwoFactorAuth: ['emailOtp'] }` as though it were a result. Calling
 * `authenticate({ partial: true })` explicitly is what turns that into a real
 * login (and, when a code is needed, a real prompt).
 *
 * Cheap in the common case: it returns immediately once a session is live, so
 * this is one extra request per process, not per tool call.
 */
export async function ensureAuthenticated(): Promise<void> {
	if (sessionActive) return

	// A login already parked on a code: report it now rather than queueing
	// behind a prompt that only the user can clear.
	const parked = getBroker().status()
	if (parked.state === 'awaiting_code' && parked.pending) {
		throw new TwoFactorRequiredError(parked.pending, twoFactorPrompt(parked.pending))
	}

	if (lastFailure && Date.now() - lastFailure.at < FAILURE_COOLDOWN_MS) throw lastFailure.error

	if (authenticating) return raceAgainstPrompt(authenticating, CONCURRENT_WAIT_MS)

	// `authenticate` is public at runtime but marked private in the SDK's types.
	const client = getClient() as unknown as {
		authenticate: (options: { partial: boolean }) => Promise<{ data?: unknown; error?: unknown }>
	}

	authenticating = (async () => {
		const result = await client.authenticate({ partial: true })

		if (result.error) throw result.error

		// The fetch sniffer sets `sessionActive` from the response body; if a
		// login "succeeded" without ever producing a user, treat it as a failure
		// rather than letting every later call retry the same dead path.
		if (!sessionActive) {
			const pending = getBroker().status()

			throw new Error(
				pending.state === 'awaiting_code'
					? 'Login is parked on a two-factor code.'
					: 'Login did not produce a session.'
			)
		}
	})()
		.catch((error: unknown) => {
			// A parked prompt is not a failure; caching it would make the code the
			// user is about to submit unusable for the next thirty seconds.
			if (!(error instanceof TwoFactorRequiredError)) lastFailure = { error, at: Date.now() }
			throw error
		})
		.finally(() => {
			authenticating = undefined
		})

	// Keep a handle on the rejection so parking on a prompt does not surface as
	// an unhandled rejection when nobody is awaiting the login any more.
	authenticating.catch(() => {})

	return raceAgainstPrompt(authenticating)
}

/**
 * Abandons a parked login and starts a clean one.
 *
 * This is the escape hatch for VRChat's new-location check: logging in from an
 * unfamiliar IP (a new proxy, say) emails a confirmation *link* rather than a
 * code, and the parked login is waiting for a code that email never contained.
 * Clicking the link does not retroactively unblock the attempt, so the only way
 * forward is to drop it and log in again, which is when VRChat finally sends
 * the one-time code.
 */
export async function restartLogin(): Promise<void> {
	getBroker().cancel('Login restarted.')
	sessionActive = false

	// The whole point of an explicit retry is to bypass the cooldown: the user
	// has just done the thing the cached failure was waiting on.
	lastFailure = undefined

	// Let the abandoned attempt unwind before starting another, so the SDK's own
	// in-flight guard does not hand us back the very login we just cancelled.
	const previous = authenticating
	if (previous) await previous.catch(() => {})

	return ensureAuthenticated()
}

/**
 * Clears the persisted session and drops the memoized client, so the next call
 * logs in from scratch.
 */
export async function logout(): Promise<void> {
	getBroker().cancel('Logged out before the two-factor code arrived.')
	sessionActive = false
	lastFailure = undefined

	// Clear the file even when no client was ever built this process — a session
	// persisted by an earlier launch is exactly what logout is for.
	const store = sessionStore ?? new KeyvFile({ filename: config.sessionPath })
	try {
		await store.clear()
	} finally {
		sessionStore = undefined
		client = undefined
	}
}

/** Test seam: forget the memoized client without touching the stored session. */
export function resetClient(): void {
	client = undefined
	sessionStore = undefined
	sessionActive = false
	lastFailure = undefined
}
