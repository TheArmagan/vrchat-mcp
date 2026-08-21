/**
 * Shared token bucket for every outbound VRChat request.
 *
 * One agent turn can fan 250 generated tools out faster than VRChat tolerates,
 * so generated tools *and* the auth flow funnel through a single instance of
 * this limiter. The clock is injectable purely so the tests can drive minutes
 * of queueing in milliseconds.
 */

import type { LimiterStatus } from '../types.ts'
import { config } from '../config.ts'

/** Rejected to a caller that sat behind the bucket longer than the max wait. */
export class RateLimitTimeoutError extends Error {
	readonly waitedMs: number

	constructor(waitedMs: number) {
		super(
			`Rate limited locally: waited ${waitedMs}ms behind the ${config.appName} request budget without getting a slot.`
		)
		this.name = 'RateLimitTimeoutError'
		this.waitedMs = waitedMs
	}
}

/** The two time primitives the bucket needs, so tests can supply a fake clock. */
export interface LimiterClock {
	now(): number
	sleep(ms: number): Promise<void>
}

/** Structural stand-in for `Response`, so tests need not build a real one. */
export interface RateLimitedResponse {
	status: number
	headers: { get(name: string): string | null }
}

export interface LimiterOptions {
	/** Sustained requests per second; also the burst capacity. */
	rps?: number
	maxQueueWaitMs?: number
	/** First backoff step when a 429 arrives with no `Retry-After`. */
	backoffBaseMs?: number
	/** Ceiling for the doubling backoff, so a broken upstream can't park us forever. */
	backoffMaxMs?: number
	clock?: LimiterClock
}

const realClock: LimiterClock = {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

interface Waiter {
	deadline: number
	enqueuedAt: number
	grant: () => void
	fail: (reason: unknown) => void
}

export class RateLimiter {
	private readonly rps: number
	private readonly maxQueueWaitMs: number
	private readonly backoffBaseMs: number
	private readonly backoffMaxMs: number
	private readonly clock: LimiterClock

	private tokens: number
	private lastRefill: number
	private readonly queue: Waiter[] = []
	private pumping = false
	private pausedUntil = 0
	/** Consecutive 429s, so a header-less upstream gets exponential backoff. */
	private strikes = 0

	constructor(options: LimiterOptions = {}) {
		this.rps = Math.max(1, options.rps ?? config.rps)
		this.maxQueueWaitMs = options.maxQueueWaitMs ?? config.maxQueueWaitMs
		this.backoffBaseMs = options.backoffBaseMs ?? 1_000
		this.backoffMaxMs = options.backoffMaxMs ?? 60_000
		this.clock = options.clock ?? realClock

		this.tokens = this.rps
		this.lastRefill = this.clock.now()
	}

	/**
	 * Runs `fn` once the bucket has a token for it. Rejects with
	 * `RateLimitTimeoutError` rather than hanging when the wait runs long.
	 */
	async schedule<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire()
		return fn()
	}

	private acquire(): Promise<void> {
		const enqueuedAt = this.clock.now()
		return new Promise<void>((resolve, reject) => {
			this.queue.push({
				enqueuedAt,
				deadline: enqueuedAt + this.maxQueueWaitMs,
				grant: resolve,
				fail: reject
			})
			void this.pump()
		})
	}

	/**
	 * Drains the queue. Exactly one pump runs at a time, which is what makes the
	 * bucket global: a 429 pause stalls the single drainer, so every queued
	 * caller resumes together in FIFO order instead of stampeding.
	 */
	private async pump(): Promise<void> {
		if (this.pumping) return
		this.pumping = true

		try {
			while (this.queue.length > 0) {
				const now = this.clock.now()
				this.expire(now)
				if (this.queue.length === 0) break

				if (now < this.pausedUntil) {
					await this.clock.sleep(this.untilNextEvent(now, this.pausedUntil - now))
					continue
				}

				this.refill(now)
				if (this.tokens >= 1) {
					this.tokens -= 1
					this.queue.shift()!.grant()
					continue
				}

				const untilToken = Math.ceil(((1 - this.tokens) / this.rps) * 1_000)
				await this.clock.sleep(this.untilNextEvent(now, untilToken))
			}
		} finally {
			this.pumping = false
			// A waiter enqueued while the last sleep was resolving would otherwise
			// sit in the queue with nobody draining it.
			if (this.queue.length > 0) void this.pump()
		}
	}

	/** Never sleep past the head waiter's deadline, or a timeout fires late. */
	private untilNextEvent(now: number, preferredMs: number): number {
		const head = this.queue[0]
		const untilDeadline = head ? head.deadline - now : preferredMs
		return Math.max(1, Math.min(preferredMs, untilDeadline))
	}

	private expire(now: number): void {
		while (this.queue.length > 0 && now >= this.queue[0]!.deadline) {
			const waiter = this.queue.shift()!
			waiter.fail(new RateLimitTimeoutError(now - waiter.enqueuedAt))
		}
	}

	private refill(now: number): void {
		const elapsed = now - this.lastRefill
		if (elapsed <= 0) return
		this.tokens = Math.min(this.rps, this.tokens + (elapsed / 1_000) * this.rps)
		this.lastRefill = now
	}

	/**
	 * Feed every upstream response here. A 429 pauses the whole bucket; anything
	 * else clears the backoff ladder so a single blip doesn't compound.
	 */
	noteResponse(response: RateLimitedResponse): void {
		if (response.status !== 429) {
			this.strikes = 0
			return
		}

		this.strikes += 1
		const retryAfter = parseRetryAfter(response.headers.get('retry-after'), this.clock.now())
		const backoff = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (this.strikes - 1))
		this.pauseFor(retryAfter ?? backoff)
	}

	/** Pauses every caller, queued or arriving, for at least `ms`. */
	pauseFor(ms: number): void {
		if (ms <= 0) return
		const now = this.clock.now()
		this.pausedUntil = Math.max(this.pausedUntil, now + ms)
		// Burn the bucket and restart accrual at the resume instant, so the pause
		// doesn't silently bank a full burst to release all at once.
		this.tokens = 0
		this.lastRefill = this.pausedUntil
		void this.pump()
	}

	status(): LimiterStatus {
		const backingOff = this.clock.now() < this.pausedUntil
		return {
			rps: this.rps,
			queueDepth: this.queue.length,
			backingOff,
			backoffUntil: backingOff ? this.pausedUntil : null
		}
	}
}

/** `Retry-After` is either delta-seconds or an HTTP date; both are legal. */
function parseRetryAfter(raw: string | null, now: number): number | null {
	if (!raw) return null

	const seconds = Number(raw.trim())
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000)

	const at = Date.parse(raw)
	return Number.isNaN(at) ? null : Math.max(0, at - now)
}

let shared: RateLimiter | undefined

/** The one bucket every VRChat request shares. */
export function getLimiter(): RateLimiter {
	shared ??= new RateLimiter()
	return shared
}
