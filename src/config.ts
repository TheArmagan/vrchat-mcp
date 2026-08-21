/**
 * Environment configuration, read once at import time.
 *
 * Everything the server can be tuned with lives here so the env surface is
 * auditable in one place and modules never reach into `process.env` directly.
 * Nothing in here can throw: a missing credential is a tool-time error, not a
 * startup crash, so `tools/list` works with no configuration at all.
 */

const env = process.env

function bool(name: string): boolean {
	const value = env[name]
	return value === '1' || value?.toLowerCase() === 'true'
}

function int(name: string, fallback: number): number {
	const parsed = Number.parseInt(env[name] ?? '', 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Splits a comma-separated env var into a lowercased, de-duped set. */
function set(name: string): Set<string> | null {
	const raw = env[name]?.trim()
	if (!raw) return null
	const values = raw
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean)
	return values.length > 0 ? new Set(values) : null
}

/**
 * Parses the `1000,friend-location:200` retention syntax shared by
 * `VRCHAT_MCP_HISTORY` and `VRCHAT_MCP_HISTORY_MAX_AGE`.
 *
 * The first bare value is the default applied to every type; `type:value`
 * entries override it for that type only.
 */
export function parsePerType(
	raw: string | undefined,
	fallback: number,
	parseValue: (value: string) => number | null
): { default: number; overrides: Record<string, number> } {
	const result = { default: fallback, overrides: {} as Record<string, number> }
	if (raw === undefined) return result

	for (const entry of raw.split(',')) {
		const trimmed = entry.trim()
		if (!trimmed) continue

		const separator = trimmed.lastIndexOf(':')
		if (separator === -1) {
			const value = parseValue(trimmed)
			if (value !== null) result.default = value
			continue
		}

		const type = trimmed.slice(0, separator).trim()
		const value = parseValue(trimmed.slice(separator + 1).trim())
		if (type && value !== null) result.overrides[type] = value
	}

	return result
}

/** Accepts `30d`, `12h`, `90m`, `45s`, a bare millisecond count, or `0` to disable. */
export function parseDuration(raw: string): number | null {
	const match = /^(\d+)\s*(ms|[smhdw])?$/i.exec(raw)
	if (!match) return null

	const amount = Number.parseInt(match[1]!, 10)
	const unit = match[2]?.toLowerCase()
	const scale: Record<string, number> = {
		ms: 1,
		s: 1_000,
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
		w: 604_800_000
	}
	return amount * (unit ? scale[unit]! : 1)
}

function count(raw: string): number | null {
	const parsed = Number.parseInt(raw, 10)
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** Event types subscribed to when `VRCHAT_MCP_WS_EVENTS` is unset. */
export const DEFAULT_WS_EVENTS = [
	'notification',
	'notification-v2',
	'economy-update',
	'friend-online',
	'friend-offline',
	'instance-queue-ready'
] as const

export const config = {
	/** Reported in the mandatory descriptive User-Agent. */
	appName: 'vrchat-mcp',
	appVersion: '0.1.0',

	username: env.VRCHAT_USERNAME,
	password: env.VRCHAT_PASSWORD,
	totpSecret: env.VRCHAT_TOTP_SECRET,
	contact: env.VRCHAT_CONTACT,

	/** null = every tag registers. */
	tags: set('VRCHAT_MCP_TAGS'),
	allowWrites: bool('VRCHAT_MCP_ALLOW_WRITES'),
	allowPurchases: bool('VRCHAT_MCP_ALLOW_PURCHASES'),
	allowAdmin: bool('VRCHAT_MCP_ALLOW_ADMIN'),

	rps: int('VRCHAT_MCP_RPS', 20),
	/** How long a call may sit behind the limiter before giving up. */
	maxQueueWaitMs: int('VRCHAT_MCP_MAX_WAIT_MS', 30_000),

	websocket: bool('VRCHAT_MCP_WEBSOCKET'),
	wsEvents: [...(set('VRCHAT_MCP_WS_EVENTS') ?? DEFAULT_WS_EVENTS)],

	history: parsePerType(env.VRCHAT_MCP_HISTORY, 1000, count),
	/** 0 disables the age sweep entirely. */
	historyMaxAge: parsePerType(env.VRCHAT_MCP_HISTORY_MAX_AGE, 30 * 86_400_000, parseDuration),

	dataDir: '.vrchat-mcp',
	dbPath: env.VRCHAT_MCP_DB ?? '.vrchat-mcp/events.db',
	sessionPath: env.VRCHAT_MCP_SESSION ?? '.vrchat-mcp/session.json',

	/** Never log this — it may embed credentials. */
	proxy: env.VRCHAT_MCP_PROXY,

	twoFactorTimeoutMs: int('VRCHAT_MCP_2FA_TIMEOUT_MS', 300_000),
	liveTests: bool('VRCHAT_LIVE_TESTS')
}

/** True when a username and password are both present. */
export function hasCredentials(): boolean {
	return Boolean(config.username && config.password)
}
