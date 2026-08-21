/**
 * Durable event history backed by `bun:sqlite`.
 *
 * Pipeline events are high-volume and the interesting question is almost always
 * "what happened while I was away", so an in-memory buffer is the wrong home for
 * them. Retention is enforced **per event type** rather than globally: a chatty
 * type like `friend-location` would otherwise evict a rare, valuable one like
 * `economy-update` within minutes of connecting.
 */

import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite'
import { config } from '../config.ts'
import type { VRChatEvent } from '../types.ts'

/** An event on its way into the store; `cursor` is assigned by SQLite. */
export interface EventInput {
	receivedAt: number
	type: string
	userId: string | null
	content: unknown
}

export interface SearchQuery {
	/** Free text over the decoded content. */
	query?: string
	types?: string[]
	userId?: string
	/** Inclusive `received_at` lower bound, epoch ms. */
	since?: number
	/** Inclusive `received_at` upper bound, epoch ms. */
	until?: number
	limit?: number
}

export interface SearchResult {
	events: VRChatEvent[]
	/** Rows matching the filters before `limit` — makes a truncated slice visible. */
	totalMatches: number
	limit: number
}

/** Which retention limit currently determines a type's oldest retained event. */
export type BindingLimit = 'count' | 'age' | 'none'

export interface TypeStats {
	type: string
	stored: number
	countCap: number
	/** 0 means the age sweep is disabled for this type. */
	maxAgeMs: number
	oldestReceivedAt: number | null
	newestReceivedAt: number | null
	/** Rows this process has trimmed away since startup. */
	dropped: number
	binding: BindingLimit
}

export interface HistoryOptions {
	/** Per-type count caps; defaults to `config.history`. */
	history?: { default: number; overrides: Record<string, number> }
	/** Per-type age ceilings in ms, 0 disabling; defaults to `config.historyMaxAge`. */
	maxAge?: { default: number; overrides: Record<string, number> }
	/** Inserts of a single type between trims. Lowered by tests. */
	trimEvery?: number
	/** Injectable clock so age-ceiling behaviour is testable without waiting. */
	now?: () => number
}

/** Rows a type may exceed its cap by before a trim is forced early. */
const CAP_SLACK = 64

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/**
 * Probes FTS5 once per process. Bun links its own SQLite build, so availability
 * is a property of the runtime rather than something we can assume; the answer
 * decides whether free-text search is a virtual table or an indexed `LIKE`.
 */
function detectFts5(): boolean {
	const probe = new Database(':memory:')
	try {
		probe.run("CREATE VIRTUAL TABLE fts5_probe USING fts5(content)")
		return true
	} catch {
		return false
	} finally {
		probe.close()
	}
}

export const FTS5_AVAILABLE = detectFts5()

/** Per-type bookkeeping kept in memory so the hot path never counts rows. */
interface TypeState {
	count: number
	insertsSinceTrim: number
	dropped: number
}

export class EventHistory {
	readonly db: Database
	readonly fts: boolean
	/** Number of trim statements executed — asserted by tests to prove batching. */
	trimCount = 0

	private readonly caps: { default: number; overrides: Record<string, number> }
	private readonly ages: { default: number; overrides: Record<string, number> }
	private readonly trimEvery: number
	private readonly now: () => number
	private readonly state = new Map<string, TypeState>()

	private readonly insertStatement: Statement
	private readonly cutoffStatement: Statement
	private readonly trimStatement: Statement
	private readonly countStatement: Statement

	constructor(path: string = config.dbPath, options: HistoryOptions = {}) {
		this.caps = options.history ?? config.history
		this.ages = options.maxAge ?? config.historyMaxAge
		this.trimEvery = options.trimEvery ?? 100
		this.now = options.now ?? Date.now

		this.db = new Database(path, { create: true })
		// WAL keeps a burst of inserts from blocking the reader that serves tools.
		this.db.run('PRAGMA journal_mode = WAL')
		this.db.run('PRAGMA synchronous = NORMAL')
		this.fts = FTS5_AVAILABLE
		this.migrate()

		this.insertStatement = this.db.prepare(
			'INSERT INTO events (received_at, type, user_id, content) VALUES (?1, ?2, ?3, ?4)'
		)
		this.cutoffStatement = this.db.prepare(
			'SELECT cursor FROM events WHERE type = ?1 ORDER BY cursor DESC LIMIT 1 OFFSET ?2'
		)
		this.trimStatement = this.db.prepare(
			'DELETE FROM events WHERE type = ?1 AND (cursor <= ?2 OR received_at < ?3)'
		)
		this.countStatement = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?1')

		this.loadCounts()
		this.sweep()
	}

	private migrate(): void {
		this.db.run(`CREATE TABLE IF NOT EXISTS events (
			cursor      INTEGER PRIMARY KEY AUTOINCREMENT,
			received_at INTEGER NOT NULL,
			type        TEXT    NOT NULL,
			user_id     TEXT,
			content     TEXT    NOT NULL
		)`)
		this.db.run('CREATE INDEX IF NOT EXISTS idx_events_type_cursor ON events(type, cursor DESC)')
		this.db.run('CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at)')

		if (!this.fts) {
			// The fallback path scans `content` with LIKE; nothing more to build.
			return
		}

		// External-content FTS5: the index stores no copy of the text, so the
		// `events` rows stay the single source of truth. The default tokenizer is
		// deliberate — it splits `wrld_pancakes` into `wrld`+`pancakes`, so a search
		// for either the bare word or the whole id (as an adjacent phrase) lands.
		this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
			content,
			content='events',
			content_rowid='cursor'
		)`)
		this.db.run(`CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events BEGIN
			INSERT INTO events_fts(rowid, content) VALUES (new.cursor, new.content);
		END`)
		this.db.run(`CREATE TRIGGER IF NOT EXISTS events_fts_delete AFTER DELETE ON events BEGIN
			INSERT INTO events_fts(events_fts, rowid, content) VALUES ('delete', old.cursor, old.content);
		END`)
	}

	/** Seeds the in-memory per-type counters from whatever the file already holds. */
	private loadCounts(): void {
		const rows = this.db
			.query('SELECT type, COUNT(*) AS n FROM events GROUP BY type')
			.all() as Array<{ type: string; n: number }>
		for (const row of rows) {
			this.state.set(row.type, { count: row.n, insertsSinceTrim: 0, dropped: 0 })
		}
	}

	private stateFor(type: string): TypeState {
		let entry = this.state.get(type)
		if (!entry) {
			entry = { count: 0, insertsSinceTrim: 0, dropped: 0 }
			this.state.set(type, entry)
		}
		return entry
	}

	capFor(type: string): number {
		return this.caps.overrides[type] ?? this.caps.default
	}

	maxAgeFor(type: string): number {
		return this.ages.overrides[type] ?? this.ages.default
	}

	insert(event: EventInput): VRChatEvent {
		return this.insertMany([event])[0]!
	}

	/**
	 * One transaction for the whole batch: a `friend-location` burst must not cost
	 * one fsync per event.
	 */
	insertMany(events: EventInput[]): VRChatEvent[] {
		if (events.length === 0) return []

		const stored: VRChatEvent[] = []
		const write = this.db.transaction((batch: EventInput[]) => {
			for (const event of batch) {
				const content = JSON.stringify(event.content ?? null)
				const result = this.insertStatement.run(
					event.receivedAt,
					event.type,
					event.userId,
					content
				)
				stored.push({
					cursor: Number(result.lastInsertRowid),
					receivedAt: event.receivedAt,
					type: event.type,
					userId: event.userId,
					content: event.content
				})
			}
		})
		write(events)

		const touched = new Set<string>()
		for (const event of events) {
			const entry = this.stateFor(event.type)
			entry.count += 1
			entry.insertsSinceTrim += 1
			touched.add(event.type)
		}
		for (const type of touched) this.maybeTrim(type)

		return stored
	}

	/**
	 * Trims on a threshold rather than per insert. Both triggers are deliberate:
	 * the interval keeps steady traffic cheap, the slack check catches a single
	 * batch large enough to blow past the cap before the interval comes round.
	 */
	private maybeTrim(type: string): void {
		const entry = this.stateFor(type)
		const overCap = entry.count > this.capFor(type) + CAP_SLACK
		if (entry.insertsSinceTrim < this.trimEvery && !overCap) return
		this.trim(type)
	}

	/** Applies both limits to one type; whichever cuts deeper wins. */
	trim(type: string): number {
		const entry = this.stateFor(type)
		entry.insertsSinceTrim = 0

		const cap = this.capFor(type)
		const row = this.cutoffStatement.get(type, cap) as { cursor: number } | null
		// -1 is below the first AUTOINCREMENT rowid, so it matches nothing.
		const cutoffCursor = row?.cursor ?? -1

		const maxAge = this.maxAgeFor(type)
		const minTime = maxAge > 0 ? this.now() - maxAge : -1

		this.trimCount += 1
		this.trimStatement.run(type, cutoffCursor, minTime)

		// `Statement.run().changes` counts trigger-driven writes to the FTS shadow
		// tables too, so it cannot tell us how many events actually went. One
		// indexed count per trim (not per insert) is the honest measurement.
		const after = this.countStatement.get(type) as { n: number }
		const removed = Math.max(entry.count - after.n, 0)
		entry.count = after.n
		entry.dropped += removed
		return removed
	}

	/**
	 * Applies retention to every type currently stored. Run at startup so a DB
	 * untouched for months is clean before it answers its first query.
	 */
	sweep(): number {
		let removed = 0
		for (const type of this.knownTypes()) removed += this.trim(type)
		return removed
	}

	private knownTypes(): string[] {
		const rows = this.db.query('SELECT DISTINCT type FROM events').all() as Array<{ type: string }>
		const types = new Set(rows.map((row) => row.type))
		for (const type of this.state.keys()) types.add(type)
		return [...types]
	}

	search(input: SearchQuery = {}): SearchResult {
		const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
		const where: string[] = []
		const params: SQLQueryBindings[] = []
		let from = 'events e'

		if (input.query?.trim()) {
			if (this.fts) {
				from = 'events e JOIN events_fts ON events_fts.rowid = e.cursor'
				where.push('events_fts MATCH ?')
				params.push(ftsPhrase(input.query.trim()))
			} else {
				where.push("e.content LIKE ? ESCAPE '\\'")
				params.push(`%${escapeLike(input.query.trim())}%`)
			}
		}
		if (input.types && input.types.length > 0) {
			where.push(`e.type IN (${input.types.map(() => '?').join(', ')})`)
			params.push(...input.types)
		}
		if (input.userId) {
			where.push('e.user_id = ?')
			params.push(input.userId)
		}
		if (input.since !== undefined) {
			where.push('e.received_at >= ?')
			params.push(input.since)
		}
		if (input.until !== undefined) {
			where.push('e.received_at <= ?')
			params.push(input.until)
		}

		const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
		const total = this.db
			.query(`SELECT COUNT(*) AS n FROM ${from}${clause}`)
			.get(...params) as { n: number }
		const rows = this.db
			.query(
				`SELECT e.cursor, e.received_at, e.type, e.user_id, e.content
				 FROM ${from}${clause} ORDER BY e.cursor DESC LIMIT ?`
			)
			.all(...params, limit) as RawRow[]

		return { events: rows.map(decodeRow), totalMatches: total.n, limit }
	}

	/** Events strictly after `cursor`, oldest-first so a poller can replay in order. */
	after(cursor: number, types?: string[], limit = DEFAULT_LIMIT): VRChatEvent[] {
		const capped = Math.min(Math.max(limit, 1), MAX_LIMIT)
		const params: SQLQueryBindings[] = [cursor]
		let clause = 'WHERE cursor > ?'
		if (types && types.length > 0) {
			clause += ` AND type IN (${types.map(() => '?').join(', ')})`
			params.push(...types)
		}
		const rows = this.db
			.query(
				`SELECT cursor, received_at, type, user_id, content FROM events
				 ${clause} ORDER BY cursor ASC LIMIT ?`
			)
			.all(...params, capped) as RawRow[]
		return rows.map(decodeRow)
	}

	/** Highest cursor issued so far, for a caller starting an incremental poll. */
	latestCursor(): number {
		const row = this.db.query('SELECT MAX(cursor) AS cursor FROM events').get() as {
			cursor: number | null
		}
		return row.cursor ?? 0
	}

	stats(): TypeStats[] {
		const now = this.now()
		const rows = this.db
			.query(
				`SELECT type, COUNT(*) AS n, MIN(received_at) AS oldest, MAX(received_at) AS newest
				 FROM events GROUP BY type`
			)
			.all() as Array<{ type: string; n: number; oldest: number; newest: number }>

		const byType = new Map(rows.map((row) => [row.type, row]))
		const types = new Set([...byType.keys(), ...this.state.keys()])

		return [...types]
			.sort()
			.map((type) => {
				const row = byType.get(type)
				const stored = row?.n ?? 0
				const cap = this.capFor(type)
				const maxAge = this.maxAgeFor(type)

				// The count cap only bounds the window once the type is actually full;
				// until then the age ceiling (if any) is what will bound it.
				const countCutoff = stored >= cap ? this.cutoffTime(type, cap) : null
				const ageCutoff = maxAge > 0 ? now - maxAge : null

				let binding: BindingLimit = 'none'
				if (countCutoff !== null && (ageCutoff === null || countCutoff >= ageCutoff)) {
					binding = 'count'
				} else if (ageCutoff !== null) {
					binding = 'age'
				}

				return {
					type,
					stored,
					countCap: cap,
					maxAgeMs: maxAge,
					oldestReceivedAt: row?.oldest ?? null,
					newestReceivedAt: row?.newest ?? null,
					dropped: this.state.get(type)?.dropped ?? 0,
					binding
				}
			})
	}

	/** `received_at` of the oldest row the count cap would keep for this type. */
	private cutoffTime(type: string, cap: number): number | null {
		if (cap <= 0) return null
		const row = this.db
			.query(
				'SELECT received_at FROM events WHERE type = ?1 ORDER BY cursor DESC LIMIT 1 OFFSET ?2'
			)
			.get(type, cap - 1) as { received_at: number } | null
		return row?.received_at ?? null
	}

	close(): void {
		this.db.close()
	}
}

interface RawRow {
	cursor: number
	received_at: number
	type: string
	user_id: string | null
	content: string
}

function decodeRow(row: RawRow): VRChatEvent {
	let content: unknown = null
	try {
		content = JSON.parse(row.content)
	} catch {
		// A row written by an older/foreign writer; hand back the raw text rather
		// than dropping the event entirely.
		content = row.content
	}
	return {
		cursor: row.cursor,
		receivedAt: row.received_at,
		type: row.type,
		userId: row.user_id,
		content
	}
}

/**
 * Wraps free text as a single FTS5 prefix phrase. Treating the whole query as
 * one phrase makes it injection-proof (no bare `OR`/`NEAR` from user input) and
 * keeps multi-word queries meaning what they look like.
 */
function ftsPhrase(query: string): string {
	return `"${query.replaceAll('"', '""')}"*`
}

function escapeLike(query: string): string {
	return query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}
