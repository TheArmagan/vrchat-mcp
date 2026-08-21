/**
 * Failure → agent-actionable detail (PLAN §8, "Error shape").
 *
 * Every tool failure leaves through here. The agent gets three things — HTTP
 * status, VRChat's own message, and a hint saying what to do next — so it can
 * self-correct instead of the user going to read logs.
 *
 * Hard rule: **no raw exception or stack trace ever reaches the transcript.**
 * A stack is noise to the model, burns context, and leaks local paths. Messages
 * are cut at the first stack frame and length-capped.
 *
 * Everything here is total: `describeError` accepts genuinely anything and
 * always returns a `ToolErrorDetail`, because the one place that must not throw
 * is the error path.
 */

import type { CallToolResult } from '@modelcontextprotocol/server'
import type { ToolErrorDetail } from './types.ts'

/** Longest message we pass through; VRChat is terse, anything longer is noise. */
const MAX_MESSAGE = 500

const HINTS: Record<number, string> = {
	400:
		'malformed request. Check the arguments against the tool schema. If VRChat is asking for a field the schema does not have, the spec is incomplete for this endpoint rather than you being wrong: extra properties are passed through, so try adding it, and fall back to vrchat_request for full control of the body.',
	401: 'session expired — call `vrchat_authStatus`, re-auth may need a 2FA code',
	403: 'insufficient permissions (or an admin-only endpoint on a normal account)',
	404: 'resource not found — check the id',
	429: 'upstream rate limit; the limiter is backing off, retry shortly'
}

const LOCAL_TIMEOUT_HINT = 'queued behind the local rate limiter — retry'
const SERVER_HINT = 'VRChat-side failure — not your request; retry shortly, and check status.vrchat.com if it persists'
const UNKNOWN_HINT = 'unexpected failure — retry once; if it repeats the arguments or the session are likely at fault'

/** Maps a status (or `null`, for local failures) to the hint the agent acts on. */
/**
 * VRChat's wording when a login needs a confirmation link opened first.
 *
 * Two variants share one remedy. A login from an unfamiliar IP returns 401
 * ("logging in from somewhere new"); once enough attempts have piled up it
 * becomes 429 ("logging in from too many places"). Matched on the prose, which
 * is not part of any contract, so the patterns stay loose. The shared giveaway
 * is that VRChat points at an email containing a link.
 */
const VERIFY_LINK_PATTERN =
	/logging in from somewhere new|from too many places|check your email for (a message|verification)/i

const VERIFY_LINK_ADVICE =
	'The email holds a confirmation LINK, not a six-digit code, so vrchat_submitTwoFactorCode ' +
	'cannot help here. Ask the user to open the link, then call vrchat_retryLogin — VRChat only ' +
	'sends the one-time code on the attempt after the link is opened.'

const NEW_LOCATION_HINT =
	`VRChat is verifying the new location, not asking for a code. ${VERIFY_LINK_ADVICE} ` +
	'This is normal after changing proxy, VPN or network.'

const TOO_MANY_PLACES_HINT =
	`VRChat has seen too many login attempts from new locations and is throttling them. ${VERIFY_LINK_ADVICE} ` +
	'This is not the local rate limiter, so waiting alone will not clear it. Each login consumes ' +
	'a session slot, so avoid repeat attempts until the link is opened.'

/** True when the remedy is opening an emailed link rather than supplying a code. */
export function isVerifyLinkChallenge(status: number | null, message: string): boolean {
	return (status === 401 || status === 429) && VERIFY_LINK_PATTERN.test(message)
}

export function hintForStatus(status: number | null, local?: 'timeout', message = ''): string {
	if (local === 'timeout') return LOCAL_TIMEOUT_HINT

	// Checked before the status table: the credentials were fine and the session
	// is not expired, so the generic "re-auth" and "back off" hints would both
	// send the agent chasing the wrong problem.
	if (isVerifyLinkChallenge(status, message)) {
		return status === 429 ? TOO_MANY_PLACES_HINT : NEW_LOCATION_HINT
	}
	if (status === null) return UNKNOWN_HINT
	if (HINTS[status]) return HINTS[status]
	if (status >= 500) return SERVER_HINT
	if (status >= 400) return HINTS[400]!
	return UNKNOWN_HINT
}

/**
 * Trims a message down to something safe to put in the transcript: first stack
 * frame onwards removed, whitespace collapsed, length capped.
 */
function sanitize(raw: unknown): string {
	if (typeof raw !== 'string') return ''
	// V8 stacks start their frames with `\n    at ` — everything from there on is
	// local file paths and line numbers, useless to the agent and leaky.
	const [head = ''] = raw.split(/\n\s*at\s/)
	const text = head.replace(/\s+/g, ' ').trim()
	if (text.length <= MAX_MESSAGE) return text
	return `${text.slice(0, MAX_MESSAGE)}…`
}

/**
 * VRChat double-encodes many of its messages as a quoted JSON string
 * (`"\"Missing Credentials\""`). Unwrap so the agent reads prose, not escapes.
 */
function unquote(message: string): string {
	const trimmed = message.trim()
	if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed
	try {
		const parsed: unknown = JSON.parse(trimmed)
		return typeof parsed === 'string' ? parsed.trim() : trimmed
	} catch {
		return trimmed.slice(1, -1).trim()
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function numeric(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Digs VRChat's own message out of an error body. The API returns
 * `{ error: { message, status_code } }`, but `throwOnError: false` results and
 * hand-rolled mocks show up as `{ message }` or a bare string too.
 */
function messageFrom(body: unknown): { message: string; status: number | null } {
	if (typeof body === 'string') return { message: unquote(sanitize(body)), status: null }
	const object = record(body)
	if (!object) return { message: '', status: null }

	const inner = record(object.error)
	if (inner) {
		const nested = messageFrom(inner)
		if (nested.message) return nested
	}
	if (typeof object.error === 'string' && object.error) {
		return { message: unquote(sanitize(object.error)), status: numeric(object.status_code) }
	}

	const message = sanitize(object.message ?? object.error_description ?? object.detail)
	const status = numeric(object.status_code) ?? numeric(object.statusCode) ?? numeric(object.status)
	return { message: unquote(message), status }
}

/** True for the rate limiter's own timeout error. */
function isLocalTimeout(error: unknown): boolean {
	const object = record(error)
	if (!object) return false
	// Matched structurally rather than by `instanceof`: importing the limiter's
	// class here would couple this module to `src/vrchat/ratelimit.ts` and drag
	// timers into every error path.
	return (
		object.name === 'RateLimitTimeoutError' ||
		object.code === 'RATE_LIMIT_TIMEOUT' ||
		object.code === 'ETIMEDOUT'
	)
}

/**
 * Normalizes anything throwable — the SDK's `VRChatError`, a
 * `throwOnError: false` `{ data, error, response }` result, a bare `Response`,
 * a plain `Error`, a thrown string, `undefined` — into one detail shape.
 */
export function describeError(error: unknown): ToolErrorDetail {
	if (isLocalTimeout(error)) {
		const object = record(error)!
		return {
			status: null,
			message: sanitize(object.message) || 'timed out waiting for a rate-limiter token',
			hint: hintForStatus(null, 'timeout')
		}
	}

	if (typeof error === 'string') {
		const message = sanitize(error)
		return { status: null, message: message || 'unknown error', hint: hintForStatus(null) }
	}

	if (error instanceof Response) {
		return detail(error.status, sanitize(error.statusText))
	}

	const object = record(error)
	if (!object) {
		return { status: null, message: 'unknown error', hint: hintForStatus(null) }
	}

	// Our own configuration and proxy errors already know what the user should
	// do about them. Falling through to the status table would replace a precise
	// instruction ("set VRCHAT_CONTACT to a real address") with a generic shrug.
	if (typeof object.hint === 'string' && object.hint) {
		return {
			status: numeric(object.statusCode) ?? numeric(object.status),
			message: unquote(sanitize(object.message)) || 'configuration error',
			hint: object.hint
		}
	}

	// A `throwOnError: false` result: never an Error, carries the parsed body in
	// `error` and the transport status on `response`.
	const response = object.response
	const responseStatus = response instanceof Response ? response.status : numeric(record(response)?.status)

	// `VRChatError` exposes the status through a getter and the body through a
	// sync helper, so neither needs the (async) response body to be read.
	let bodyStatus: number | null = null
	let message = ''
	if (typeof object.toResponseContent === 'function') {
		try {
			const content = (object.toResponseContent as () => unknown)()
			const extracted = messageFrom(content)
			message = extracted.message
			bodyStatus = extracted.status
		} catch {
			// A malformed SDK error must not replace the real failure with ours.
		}
	}

	if (!message && 'error' in object) {
		const extracted = messageFrom(object.error)
		message = extracted.message
		bodyStatus ??= extracted.status
	}
	if (!message && 'data' in object) {
		const extracted = messageFrom(object.data)
		message = extracted.message
		bodyStatus ??= extracted.status
	}
	if (!message) message = unquote(sanitize(object.message))

	const status = numeric(object.statusCode) ?? numeric(object.status) ?? responseStatus ?? bodyStatus
	return detail(status, message)
}

function detail(status: number | null, message: string): ToolErrorDetail {
	return {
		status,
		message: message || (status === null ? 'unknown error' : `HTTP ${status}`),
		hint: hintForStatus(status, undefined, message)
	}
}

/**
 * Wraps a failure as an MCP `isError` result. The detail goes out as JSON text
 * rather than prose so the agent can branch on `status` without parsing English.
 */
export function toToolError(error: unknown): CallToolResult {
	const info = describeError(error)
	// stderr only — stdout is the JSON-RPC channel and a stray write corrupts it.
	console.error(`[vrchat-mcp] tool error status=${info.status ?? 'local'} ${info.message}`)
	return {
		isError: true,
		content: [{ type: 'text', text: JSON.stringify(info, null, 2) }]
	}
}
