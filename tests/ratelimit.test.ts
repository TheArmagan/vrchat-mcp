import { describe, expect, test } from 'bun:test'
import { RateLimiter, RateLimitTimeoutError, type LimiterClock } from '../src/vrchat/ratelimit.ts'

/**
 * Virtual clock: `sleep` parks on a timer that only fires when the test moves
 * time forward, so a four-second drain costs no real seconds.
 */
class FakeClock implements LimiterClock {
	current = 0
	private timers: { at: number; fire: () => void }[] = []

	now(): number {
		return this.current
	}

	sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			this.timers.push({ at: this.current + ms, fire: resolve })
		})
	}

	/** Advances to `current + ms`, firing due timers in order and letting the code they wake run. */
	async advance(ms: number): Promise<void> {
		const target = this.current + ms
		for (;;) {
			const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0]
			if (!due) break
			this.timers.splice(this.timers.indexOf(due), 1)
			this.current = Math.max(this.current, due.at)
			due.fire()
			await settle()
		}
		this.current = target
		await settle()
	}
}

/** Lets every pending microtask (and any freshly scheduled sleep) register. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0))
}

function headers(values: Record<string, string> = {}) {
	return { get: (name: string) => values[name.toLowerCase()] ?? null }
}

describe('RateLimiter', () => {
	test('drains 100 queued calls at ~20/s with none dropped', async () => {
		const clock = new FakeClock()
		const limiter = new RateLimiter({ rps: 20, maxQueueWaitMs: 60_000, clock })

		const completedAt: number[] = []
		const calls = Array.from({ length: 100 }, () =>
			limiter.schedule(async () => {
				completedAt.push(clock.now())
			})
		)

		await settle()
		// One second of burst capacity is available immediately, nothing more.
		expect(completedAt.length).toBe(20)

		await clock.advance(1_000)
		expect(completedAt.length).toBe(40)

		await clock.advance(3_000)
		const results = await Promise.allSettled(calls)

		expect(results.every((result) => result.status === 'fulfilled')).toBe(true)
		expect(completedAt.length).toBe(100)
		// 20 burst + 80 accrued at 20/s = four seconds of accrual.
		expect(completedAt[99]).toBeGreaterThanOrEqual(3_950)
		expect(completedAt[99]).toBeLessThanOrEqual(4_050)
		expect(limiter.status().queueDepth).toBe(0)
	})

	test('a 429 with Retry-After pauses every in-flight caller and resumes without a stampede', async () => {
		const clock = new FakeClock()
		const limiter = new RateLimiter({ rps: 2, maxQueueWaitMs: 120_000, clock })

		const completedAt: number[] = []
		const calls = Array.from({ length: 6 }, () =>
			limiter.schedule(async () => {
				completedAt.push(clock.now())
			})
		)

		await settle()
		expect(completedAt.length).toBe(2)

		limiter.noteResponse({ status: 429, headers: headers({ 'retry-after': '5' }) })
		expect(limiter.status().backingOff).toBe(true)
		expect(limiter.status().backoffUntil).toBe(5_000)

		// Nothing moves during the pause, even though tokens would have accrued.
		await clock.advance(4_999)
		expect(completedAt.length).toBe(2)

		await clock.advance(2_001)
		await Promise.all(calls)

		expect(completedAt.length).toBe(6)
		const resumed = completedAt.slice(2)
		// Serialized by the bucket at 2/s, not released together at the resume instant.
		expect(resumed.every((at) => at >= 5_000)).toBe(true)
		expect(new Set(resumed).size).toBe(resumed.length)
		expect(resumed[3]! - resumed[0]!).toBeGreaterThanOrEqual(1_400)
		expect(limiter.status().backingOff).toBe(false)
	})

	test('a 429 without Retry-After backs off exponentially, capped', async () => {
		const clock = new FakeClock()
		const limiter = new RateLimiter({ rps: 5, clock, backoffBaseMs: 1_000, backoffMaxMs: 4_000 })

		limiter.noteResponse({ status: 429, headers: headers() })
		expect(limiter.status().backoffUntil).toBe(1_000)

		limiter.noteResponse({ status: 429, headers: headers() })
		expect(limiter.status().backoffUntil).toBe(2_000)

		limiter.noteResponse({ status: 429, headers: headers() })
		limiter.noteResponse({ status: 429, headers: headers() })
		expect(limiter.status().backoffUntil).toBe(4_000)

		// A clean response clears the ladder so one blip doesn't compound forever.
		limiter.noteResponse({ status: 200, headers: headers() })
		await clock.advance(4_000)
		limiter.noteResponse({ status: 429, headers: headers() })
		expect(limiter.status().backoffUntil).toBe(5_000)
	})

	test('a call exceeding the max wait rejects instead of hanging', async () => {
		const clock = new FakeClock()
		const limiter = new RateLimiter({ rps: 1, maxQueueWaitMs: 600, clock })

		let ran = false
		const first = limiter.schedule(async () => 'immediate')
		const late = limiter.schedule(async () => {
			ran = true
			return 'late'
		})
		const rejection = late.catch((error: unknown) => error)

		await settle()
		expect(await first).toBe('immediate')

		await clock.advance(700)
		const error = await rejection

		expect(error).toBeInstanceOf(RateLimitTimeoutError)
		expect((error as RateLimitTimeoutError).waitedMs).toBeGreaterThanOrEqual(600)
		expect(ran).toBe(false)
	})

	test('a timed-out caller does not block the ones behind it', async () => {
		const clock = new FakeClock()
		const limiter = new RateLimiter({ rps: 1, maxQueueWaitMs: 500, clock })

		const done: string[] = []
		void limiter.schedule(async () => void done.push('a'))
		const doomed = limiter.schedule(async () => void done.push('b')).catch(() => 'timed-out')
		const survivor = limiter.schedule(async () => void done.push('c')).catch(() => 'timed-out')

		await settle()
		await clock.advance(600)

		expect(await doomed).toBe('timed-out')
		expect(await survivor).toBe('timed-out')
		expect(done).toEqual(['a'])
		expect(limiter.status().queueDepth).toBe(0)
	})
})
