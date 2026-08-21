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
import type { LimiterStatus, PendingTwoFactor } from '../types.ts'
import { getBroker } from './twofactor.ts'
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

	limiter.noteResponse(response)
	await sniff(request, response)
	return response
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
	if (authenticating) return authenticating

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
	})().finally(() => {
		authenticating = undefined
	})

	return authenticating
}

/**
 * Clears the persisted session and drops the memoized client, so the next call
 * logs in from scratch.
 */
export async function logout(): Promise<void> {
	getBroker().cancel('Logged out before the two-factor code arrived.')
	sessionActive = false

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
}
