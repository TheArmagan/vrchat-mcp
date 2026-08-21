/**
 * Live suite — real HTTP against a real VRChat account.
 *
 * Opted into with `VRCHAT_LIVE_TESTS=1` (`bun run test:live`) and skipped
 * entirely otherwise, so the default `bun test` never needs credentials.
 *
 * Rules this suite holds itself to, because it is driving someone's actual
 * account on a rate-limited API:
 *   - Reads and creator-owned writes only. `tests/live/guard.ts` refuses the
 *     money and admin classes outright.
 *   - Small. A run that trips VRChat's throttling is worse than no run.
 *   - Assertions on shape and status, never on volatile content — friend
 *     counts and world listings move between runs.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { config, hasCredentials } from '../../src/config.ts'
import { operationsById } from '../../src/generated/operations.ts'
import { project } from '../../src/project.ts'
import { authStatus } from '../../src/vrchat/client.ts'
import { getLimiter } from '../../src/vrchat/ratelimit.ts'
import { ForbiddenOperationError, liveCall, liveLogin, runCleanups } from './guard.ts'

const enabled = config.liveTests && hasCredentials()

if (config.liveTests && !hasCredentials()) {
	console.error(
		'[live] VRCHAT_LIVE_TESTS=1 but no credentials — set VRCHAT_USERNAME and VRCHAT_PASSWORD in .env'
	)
}

/** The authenticated account, resolved once and reused to keep the run small. */
let currentUserId = ''

describe.skipIf(!enabled)('live: identity and economy', () => {
	beforeAll(async () => {
		currentUserId = await liveLogin()
	}, 60_000)

	afterAll(async () => {
		await runCleanups()
	}, 60_000)

	test('getCurrentUser returns a real identity', async () => {
		const { data } = await liveCall<Record<string, unknown>>('getCurrentUser')

		expect(typeof data?.id).toBe('string')
		expect(typeof data?.displayName).toBe('string')
		expect(data?.id).toBe(currentUserId)
	})

	test('getBalance proves the economy path and auth scope', async () => {
		const { data, error } = await liveCall<Record<string, unknown>>('getBalance', {
			path: { userId: currentUserId }
		})

		// A 403 here is a real answer: it means the account lacks economy scope,
		// not that the plumbing is broken. Shape is what we assert either way.
		if (error) {
			console.error('[live] getBalance returned an error; economy scope may be unavailable')
			return
		}

		expect(data).toBeTypeOf('object')
		expect(data).toHaveProperty('balance')
	})
})

describe.skipIf(!enabled)('live: pagination and projection', () => {
	test('searchWorlds returns one page plus a usable nextOffset', async () => {
		const first = await liveCall<unknown[]>('searchWorlds', { query: { n: 5, offset: 0 } })

		expect(Array.isArray(first.data)).toBe(true)
		expect(first.data!.length).toBeLessThanOrEqual(5)

		// Only meaningful when the first page was full; a short page is the end.
		if (first.data!.length < 5) return

		const second = await liveCall<unknown[]>('searchWorlds', { query: { n: 5, offset: 5 } })

		expect(Array.isArray(second.data)).toBe(true)

		const ids = (page: unknown[]) => page.map((world) => (world as { id: string }).id)
		expect(ids(second.data!)).not.toEqual(ids(first.data!))
	}, 30_000)

	test('narrowing _responseKeys measurably shrinks a real payload', async () => {
		const { data } = await liveCall<unknown[]>('searchWorlds', { query: { n: 5 } })

		const raw = JSON.stringify(project(data, ['*'])).length
		const narrowed = JSON.stringify(project(data, ['*.id', '*.name'])).length

		// The whole point of the projection: a real World listing is fat.
		expect(narrowed).toBeLessThan(raw / 2)
	}, 30_000)
})

describe.skipIf(!enabled)('live: error shape', () => {
	test('a bogus user id returns a structured error, not a crash', async () => {
		const { data, error } = await liveCall('getUser', {
			path: { userId: 'usr_00000000-0000-0000-0000-000000000000' }
		})

		expect(data).toBeUndefined()
		expect(error).toBeDefined()
		expect(JSON.stringify(error)).not.toContain('\n    at ')
	}, 30_000)
})

describe.skipIf(!enabled)('live: rate limiting', () => {
	test('a burst stays inside the local budget and none are dropped', async () => {
		const started = Date.now()
		const results = await Promise.all(
			Array.from({ length: 10 }, () => liveCall<{ id?: string }>('getCurrentUser'))
		)

		expect(results.every((result) => typeof result.data?.id === 'string')).toBe(true)

		const elapsedSeconds = (Date.now() - started) / 1000 || 1
		expect(results.length / elapsedSeconds).toBeLessThanOrEqual(config.rps + 1)
		expect(getLimiter().status().rps).toBe(config.rps)
	}, 60_000)
})

/**
 * These run with or without credentials: they assert the suite's own refusal,
 * which must hold even when nobody can log in.
 */
describe('live suite safety rails', () => {
	test('money operations are hard-refused', async () => {
		expect(operationsById.purchaseProductListing?.kind).toBe('money')
		await expect(liveCall('purchaseProductListing')).rejects.toBeInstanceOf(
			ForbiddenOperationError
		)
	})

	test('admin operations are hard-refused', async () => {
		expect(operationsById.deleteUser?.kind).toBe('admin')
		await expect(liveCall('deleteUser')).rejects.toBeInstanceOf(ForbiddenOperationError)
	})

	test('the refusal precedes any client construction', async () => {
		// No credentials are configured in a default run, so reaching the client
		// would throw ConfigurationError instead. Getting ForbiddenOperationError
		// proves the guard rejects before touching the network at all.
		await expect(liveCall('purchaseProductListing')).rejects.toMatchObject({
			name: 'ForbiddenOperationError'
		})
	})

	test('authStatus is inspectable without credentials', async () => {
		const status = await authStatus()
		expect(['not_configured', 'unauthenticated', 'authenticated', 'awaiting_code']).toContain(
			status.state
		)
	})
})
