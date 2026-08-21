/**
 * Environment configuration, read once at import time.
 *
 * Everything the server can be tuned with lives here so the env surface is
 * auditable in one place and modules never reach into `process.env` directly.
 * Nothing in here can throw: a missing credential is a tool-time error, not a
 * startup crash, so `tools/list` works with no configuration at all.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const env = process.env

/** The installed package root, derived from this file's own location. */
const packageRoot = dirname(import.meta.dir)

/** Markers that identify the top of a project, in the order we trust them. */
const PROJECT_MARKERS = ['.git', 'package.json', 'deno.json', 'pyproject.toml', 'go.mod']

/**
 * The project the server is being used *for*, found by walking up from the
 * working directory.
 *
 * State is per-project: run the server inside a project and its session and
 * event history live in that project's `.vrchat-mcp/`. Anchoring to a marker
 * rather than to `process.cwd()` directly means launching from a subdirectory
 * still reaches the same state, instead of stranding a second session a level
 * down. With no marker anywhere above, the working directory is the project.
 *
 * The consequence worth knowing: separate projects have separate logins, so the
 * first call in a new project authenticates again (and may ask for a 2FA code).
 * `VRCHAT_MCP_SESSION` pointed at one shared path opts back out of that.
 */
function findProjectRoot(): string {
	let directory = resolve(process.cwd())

	for (;;) {
		if (PROJECT_MARKERS.some((marker) => existsSync(join(directory, marker)))) return directory

		const parent = dirname(directory)
		if (parent === directory) return resolve(process.cwd())
		directory = parent
	}
}

const projectRoot = findProjectRoot()

/**
 * Loads the package's own `.env`, without overriding anything already set.
 *
 * Bun auto-loads `.env` from the working directory, which is the repo during
 * development but is arbitrary once `vrchat-mcp` is on PATH via `bun link` —
 * so a linked server would silently start with no credentials and fail on the
 * first tool call. Reading the package's `.env` as a *fallback* fixes that
 * while leaving precedence intact: anything the MCP client passes in `env`,
 * or the shell exports, still wins.
 */
function loadPackageEnv(): void {
	const file = join(packageRoot, '.env')

	let contents: string
	try {
		contents = readFileSync(file, 'utf8')
	} catch {
		// No package .env is the normal case for a client-configured install.
		return
	}

	for (const line of contents.split(/\r?\n/)) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) continue

		const separator = trimmed.indexOf('=')
		if (separator === -1) continue

		const key = trimmed.slice(0, separator).trim()
		if (!key || env[key] !== undefined) continue

		let value = trimmed.slice(separator + 1).trim()
		if (value.length > 1 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1)

		env[key] = value
	}
}

loadPackageEnv()

/** Env-supplied paths honour the user's intent; bare defaults anchor to the project. */
function dataPath(override: string | undefined, fallback: string): string {
	if (override) return isAbsolute(override) ? override : resolve(override)
	return join(projectRoot, fallback)
}

/**
 * Creates the data directory and makes it self-ignoring.
 *
 * The session file is an auth credential, and this directory now lands inside
 * whatever project the server is run from — projects whose `.gitignore` we do
 * not control and cannot edit. A `.gitignore` containing `*` *inside* the
 * directory ignores it from within, so the credential is protected by default
 * rather than by the host project remembering to add a rule.
 */
export function ensureDataDir(path: string): void {
	const directory = dirname(path)
	mkdirSync(directory, { recursive: true })

	const marker = join(directory, '.gitignore')
	if (!existsSync(marker)) {
		writeFileSync(marker, '# Created by vrchat-mcp: this directory holds an auth session.\n*\n')
	}
}

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
	/** Layered on top of writes: DELETE and the explicit destructive overrides. */
	allowDestructive: bool('VRCHAT_MCP_ALLOW_DESTRUCTIVE_WRITES'),
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

	dataDir: join(projectRoot, '.vrchat-mcp'),
	/** Where the server found the project boundary, for diagnostics. */
	projectRoot,
	dbPath: dataPath(env.VRCHAT_MCP_DB, '.vrchat-mcp/events.db'),
	sessionPath: dataPath(env.VRCHAT_MCP_SESSION, '.vrchat-mcp/session.json'),

	/** Never log this — it may embed credentials. */
	proxy: env.VRCHAT_MCP_PROXY,

	twoFactorTimeoutMs: int('VRCHAT_MCP_2FA_TIMEOUT_MS', 300_000),
	liveTests: bool('VRCHAT_LIVE_TESTS')
}

/** True when a username and password are both present. */
export function hasCredentials(): boolean {
	return Boolean(config.username && config.password)
}
