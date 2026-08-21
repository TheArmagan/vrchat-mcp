/**
 * Offline coverage for the event store and the ingest normalizer.
 *
 * Everything here seeds SQLite directly — no live socket, no credentials. The
 * two durability cases are the only ones that touch disk.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { EventHistory, FTS5_AVAILABLE, type HistoryOptions } from '../src/vrchat/history.ts'
import { extractUserId, normalizeMessage } from '../src/vrchat/events.ts'

const SCRATCH = join(
	process.env.TEMP ?? '.',
	'claude',
	'C--Users-armagan-Documents-GitHub-vrchat-mcp',
	'c1f55d7c-f4e6-4844-97c4-1cdbf454a14a',
	'scratchpad',
	// Per-process directory: a leftover file from an interrupted run would
	// otherwise double the row counts the durability tests assert on.
	`history-tests-${process.pid}`
)

const DAY = 86_400_000
const created: EventHistory[] = []
const tempFiles: string[] = []

function makeHistory(options: HistoryOptions = {}, path = ':memory:'): EventHistory {
	const history = new EventHistory(path, {
		history: { default: 1000, overrides: {} },
		maxAge: { default: 0, overrides: {} },
		...options
	})
	created.push(history)
	return history
}

function tempPath(name: string): string {
	mkdirSync(SCRATCH, { recursive: true })
	const path = join(SCRATCH, name)
	tempFiles.push(path)
	return path
}

function seed(
	history: EventHistory,
	type: string,
	count: number,
	extra: { receivedAt?: number; userId?: string | null; content?: unknown } = {}
) {
	const rows = Array.from({ length: count }, (_, index) => ({
		receivedAt: extra.receivedAt ?? Date.now(),
		type,
		userId: extra.userId ?? null,
		content: extra.content ?? { index, type }
	}))
	return history.insertMany(rows)
}

function statsFor(history: EventHistory, type: string) {
	const entry = history.stats().find((row) => row.type === type)
	if (!entry) throw new Error(`no stats for ${type}`)
	return entry
}

afterAll(() => {
	for (const history of created) {
		try {
			history.close()
		} catch {
			// Already closed by the test that owned it.
		}
	}
	try {
		rmSync(SCRATCH, { recursive: true, force: true })
	} catch {
		// Windows can hold a WAL handle briefly after close; leftover temp files
		// are not worth failing a suite over.
	}
})

describe('FTS5 availability', () => {
	test('the shipped search path is pinned', () => {
		// This build has FTS5, so search must be the virtual-table path. If this
		// ever flips, the LIKE fallback takes over and this assertion is the alarm.
		expect(FTS5_AVAILABLE).toBe(true)
		expect(makeHistory().fts).toBe(true)
	})
})

describe('per-type retention', () => {
	test('a chatty type cannot evict a rare one', () => {
		const history = makeHistory()
		seed(history, 'friend-location', 1500)
		seed(history, 'economy-update', 5)

		expect(statsFor(history, 'friend-location').stored).toBe(1000)
		// A global cap of 1000 would have evicted every economy-update here.
		expect(statsFor(history, 'economy-update').stored).toBe(5)
	})

	test('per-type overrides apply only to their own type', () => {
		const history = makeHistory({
			history: { default: 1000, overrides: { 'friend-location': 200 } }
		})
		seed(history, 'friend-location', 1500)
		seed(history, 'economy-update', 5)

		expect(statsFor(history, 'friend-location').stored).toBe(200)
		expect(statsFor(history, 'friend-location').countCap).toBe(200)
		expect(statsFor(history, 'economy-update').countCap).toBe(1000)
		expect(statsFor(history, 'economy-update').stored).toBe(5)
	})

	test('drop counts are reported per type', () => {
		const history = makeHistory({ history: { default: 100, overrides: {} } })
		seed(history, 'friend-online', 250)
		const stats = statsFor(history, 'friend-online')

		expect(stats.stored).toBe(100)
		expect(stats.dropped).toBe(150)
	})
})

describe('age ceiling', () => {
	test('drops stale events even when the count cap was never reached', () => {
		const now = Date.now()
		const history = makeHistory({
			maxAge: { default: 7 * DAY, overrides: {} },
			now: () => now
		})
		seed(history, 'notification', 10, { receivedAt: now - 30 * DAY })
		seed(history, 'notification', 10, { receivedAt: now })
		history.sweep()

		const stats = statsFor(history, 'notification')
		expect(stats.stored).toBe(10)
		expect(stats.oldestReceivedAt).toBe(now)
		expect(stats.binding).toBe('age')
	})

	test('a ceiling of 0 disables the sweep entirely', () => {
		const now = Date.now()
		const history = makeHistory({ maxAge: { default: 0, overrides: {} }, now: () => now })
		seed(history, 'notification', 10, { receivedAt: now - 365 * DAY })
		history.sweep()

		const stats = statsFor(history, 'notification')
		expect(stats.stored).toBe(10)
		expect(stats.maxAgeMs).toBe(0)
		expect(stats.binding).toBe('none')
	})

	test('whichever limit bites first wins, and stats names it', () => {
		const now = Date.now()

		// Count binds: 300 fresh events against a cap of 100 and a wide ceiling.
		const byCount = makeHistory({
			history: { default: 100, overrides: {} },
			maxAge: { default: 30 * DAY, overrides: {} },
			now: () => now
		})
		seed(byCount, 'friend-location', 300, { receivedAt: now })
		expect(statsFor(byCount, 'friend-location').stored).toBe(100)
		expect(statsFor(byCount, 'friend-location').binding).toBe('count')

		// Age binds: well under the cap, but half the rows are past the ceiling.
		const byAge = makeHistory({
			history: { default: 1000, overrides: {} },
			maxAge: { default: DAY, overrides: {} },
			now: () => now
		})
		seed(byAge, 'friend-location', 20, { receivedAt: now - 10 * DAY })
		seed(byAge, 'friend-location', 20, { receivedAt: now })
		byAge.sweep()
		expect(statsFor(byAge, 'friend-location').stored).toBe(20)
		expect(statsFor(byAge, 'friend-location').binding).toBe('age')
	})
})

describe('trim scheduling', () => {
	test('trims on a threshold rather than once per insert', () => {
		const history = makeHistory({ history: { default: 1000, overrides: {} }, trimEvery: 100 })
		const before = history.trimCount
		for (let index = 0; index < 1000; index += 1) seed(history, 'friend-location', 1)

		const trims = history.trimCount - before
		expect(trims).toBeGreaterThan(0)
		// One trim per insert would be 1000; the threshold keeps it near 10.
		expect(trims).toBeLessThanOrEqual(20)
	})

	test('a single oversized batch is trimmed without waiting for the threshold', () => {
		const history = makeHistory({ history: { default: 50, overrides: {} }, trimEvery: 10_000 })
		seed(history, 'friend-location', 500)
		expect(statsFor(history, 'friend-location').stored).toBe(50)
	})
})

describe('startup sweep and durability', () => {
	test('reopening the file keeps history queryable', () => {
		const path = tempPath('durable.db')
		const first = new EventHistory(path, {
			history: { default: 1000, overrides: {} },
			maxAge: { default: 0, overrides: {} }
		})
		seed(first, 'economy-update', 3, { userId: 'usr_persist' })
		first.close()

		const second = new EventHistory(path, {
			history: { default: 1000, overrides: {} },
			maxAge: { default: 0, overrides: {} }
		})
		created.push(second)
		expect(second.search({ types: ['economy-update'] }).totalMatches).toBe(3)
		expect(second.search({ userId: 'usr_persist' }).events).toHaveLength(3)
	})

	test('the age sweep runs at startup, before the first query', () => {
		const now = Date.now()
		const path = tempPath('stale.db')
		const first = new EventHistory(path, {
			history: { default: 1000, overrides: {} },
			maxAge: { default: 0, overrides: {} }
		})
		seed(first, 'notification', 10, { receivedAt: now - 90 * DAY })
		seed(first, 'notification', 2, { receivedAt: now })
		first.close()

		// A fresh process with a 7d ceiling over a DB untouched for months.
		const second = new EventHistory(path, {
			history: { default: 1000, overrides: {} },
			maxAge: { default: 7 * DAY, overrides: {} },
			now: () => now
		})
		created.push(second)
		expect(second.search({ types: ['notification'] }).totalMatches).toBe(2)
	})
})

describe('search', () => {
	const now = Date.now()

	function searchFixture(): EventHistory {
		const history = makeHistory()
		history.insertMany([
			{
				receivedAt: now - 3 * DAY,
				type: 'friend-online',
				userId: 'usr_alpha',
				content: { userId: 'usr_alpha', location: 'wrld_pancakes' }
			},
			{
				receivedAt: now - 2 * DAY,
				type: 'friend-offline',
				userId: 'usr_beta',
				content: { userId: 'usr_beta', location: 'offline' }
			},
			{
				receivedAt: now - DAY,
				type: 'economy-update',
				userId: null,
				content: { balance: 42, note: 'tilia payout settled' }
			},
			{
				receivedAt: now,
				type: 'notification',
				userId: 'usr_alpha',
				content: { id: 'not_1', senderUserId: 'usr_alpha', message: 'wanna hang out' }
			}
		])
		return history
	}

	test('filters by type', () => {
		const found = searchFixture().search({ types: ['friend-online', 'friend-offline'] })
		expect(found.events.map((event) => event.type)).toEqual(['friend-offline', 'friend-online'])
	})

	test('filters by userId', () => {
		const found = searchFixture().search({ userId: 'usr_alpha' })
		expect(found.totalMatches).toBe(2)
	})

	test('filters by since and until', () => {
		const history = searchFixture()
		expect(history.search({ since: now - DAY }).totalMatches).toBe(2)
		expect(history.search({ until: now - 2 * DAY }).totalMatches).toBe(2)
		expect(history.search({ since: now - 2 * DAY, until: now - DAY }).totalMatches).toBe(2)
	})

	test('free text matches inside the decoded content', () => {
		const history = searchFixture()
		expect(history.search({ query: 'pancakes' }).totalMatches).toBe(1)
		expect(history.search({ query: 'tilia payout' }).totalMatches).toBe(1)
		// Ids survive tokenization intact rather than splitting on the underscore.
		expect(history.search({ query: 'usr_beta' }).totalMatches).toBe(1)
		expect(history.search({ query: 'nothing-matches-this' }).totalMatches).toBe(0)
	})

	test('results are newest-first', () => {
		const found = searchFixture().search({})
		expect(found.events[0]?.type).toBe('notification')
		expect(found.events.at(-1)?.type).toBe('friend-online')
	})

	test('content comes back decoded, never as a JSON string', () => {
		const found = searchFixture().search({ types: ['economy-update'] })
		expect(found.events[0]?.content).toEqual({ balance: 42, note: 'tilia payout settled' })
	})

	test('limit is capped and totalMatches exposes the truncation', () => {
		const history = makeHistory()
		seed(history, 'friend-location', 400)

		const found = history.search({ limit: 5000 })
		expect(found.limit).toBe(200)
		expect(found.events).toHaveLength(200)
		expect(found.totalMatches).toBe(400)
	})

	test('after() replays forward from a cursor', () => {
		const history = makeHistory()
		const stored = seed(history, 'friend-online', 5)
		const cursor = stored[1]!.cursor
		const events = history.after(cursor)

		expect(events).toHaveLength(3)
		expect(events[0]!.cursor).toBeGreaterThan(cursor)
		expect(history.latestCursor()).toBe(stored.at(-1)!.cursor)
	})
})

describe('burst performance', () => {
	test('a few thousand rows insert as batches, not one fsync each', () => {
		const history = makeHistory({ history: { default: 5000, overrides: {} } })
		const started = performance.now()
		for (let batch = 0; batch < 40; batch += 1) seed(history, 'friend-location', 100)
		const elapsed = performance.now() - started

		expect(statsFor(history, 'friend-location').stored).toBe(4000)
		expect(elapsed).toBeLessThan(3000)
	})
})

describe('double-decoding normalizer', () => {
	test('undoes the stringified content field once', () => {
		const message = normalizeMessage(
			JSON.stringify({
				type: 'friend-online',
				content: JSON.stringify({ userId: 'usr_9f3', user: { id: 'usr_9f3' } })
			})
		)

		expect(message?.type).toBe('friend-online')
		expect(message?.content).toEqual({ userId: 'usr_9f3', user: { id: 'usr_9f3' } })
		expect(typeof message?.content).not.toBe('string')
		expect(message?.userId).toBe('usr_9f3')
	})

	test('keeps a bare id payload instead of dropping the event', () => {
		// The SDK's own handler throws on this frame and loses it silently.
		const message = normalizeMessage(
			JSON.stringify({ type: 'see-notification', content: 'not_01234567' })
		)

		expect(message?.type).toBe('see-notification')
		expect(message?.content).toBe('not_01234567')
		expect(message?.userId).toBeNull()
	})

	test('rejects malformed frames rather than throwing', () => {
		expect(normalizeMessage('not json at all')).toBeNull()
		expect(normalizeMessage(JSON.stringify({ content: 'orphan' }))).toBeNull()
	})

	test('extracts the subject user id from the shapes VRChat actually sends', () => {
		expect(extractUserId({ userId: 'usr_a' })).toBe('usr_a')
		expect(extractUserId({ senderUserId: 'usr_b' })).toBe('usr_b')
		expect(extractUserId({ user: { id: 'usr_c' } })).toBe('usr_c')
		// A notification id is not a user id.
		expect(extractUserId({ id: 'not_d' })).toBeNull()
		expect(extractUserId('not_e')).toBeNull()
	})
})
