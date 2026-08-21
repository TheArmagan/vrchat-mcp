import { describe, expect, test } from 'bun:test'
import { TwoFactorBroker, twoFactorPrompt } from '../src/vrchat/twofactor.ts'

const SECRET_CODE = '424242'

/** Captures stderr so the "never log the code" rule can be asserted, not assumed. */
async function captureStderr(fn: () => Promise<void> | void): Promise<string> {
	const original = console.error
	let captured = ''
	console.error = (...args: unknown[]) => {
		captured += args.map(String).join(' ') + '\n'
	}
	try {
		await fn()
	} finally {
		console.error = original
	}
	return captured
}

describe('TwoFactorBroker', () => {
	test('requestCode parks until submitCode resolves it', async () => {
		const broker = new TwoFactorBroker({ timeoutMs: 5_000 })
		broker.noteMethods(['emailOtp'])

		const parked = broker.requestCode()
		let settled = false
		void parked.then(() => {
			settled = true
		})

		await Promise.resolve()
		expect(settled).toBe(false)

		const status = broker.status()
		expect(status.state).toBe('awaiting_code')
		expect(status.pending?.method).toBe('emailOtp')

		const result = broker.submitCode(status.pending!.requestId, SECRET_CODE)
		expect(result.ok).toBe(true)
		expect(await parked).toBe(SECRET_CODE)
		expect(broker.status().state).toBe('idle')
	})

	test('derives the method from the login response array', () => {
		const broker = new TwoFactorBroker({ timeoutMs: 5_000 })

		broker.noteMethods(['totp', 'otp'])
		void broker.requestCode().catch(() => {})
		expect(broker.status().pending?.method).toBe('totp')

		// The SDK retries login on 401, so a parked request can learn its method late.
		broker.noteMethods(['emailOtp'])
		expect(broker.status().pending?.method).toBe('emailOtp')

		broker.cancel()
	})

	test('an unknown requestId is rejected with a clear message, not silently accepted', async () => {
		const broker = new TwoFactorBroker({ timeoutMs: 5_000 })
		const parked = broker.requestCode()
		const real = broker.status().pending!.requestId

		const result = broker.submitCode('deadbeef', SECRET_CODE)
		expect(result.ok).toBe(false)
		expect(result.message).toContain('deadbeef')
		expect(result.message).toContain(real)
		expect(broker.status().state).toBe('awaiting_code')

		broker.cancel()
		await expect(parked).rejects.toThrow()
	})

	test('expiry rejects rather than hanging forever', async () => {
		const broker = new TwoFactorBroker({ timeoutMs: 20 })
		const parked = broker.requestCode()

		await expect(parked).rejects.toThrow(/expired/i)
		expect(broker.status().state).toBe('idle')
	})

	test('a second submit after resolution is rejected', async () => {
		const broker = new TwoFactorBroker({ timeoutMs: 5_000 })
		const parked = broker.requestCode()
		const requestId = broker.status().pending!.requestId

		expect(broker.submitCode(requestId, SECRET_CODE).ok).toBe(true)
		await parked

		const second = broker.submitCode(requestId, SECRET_CODE)
		expect(second.ok).toBe(false)
		expect(second.message).toMatch(/no two-factor request is pending/i)
	})

	test('an empty code is refused and leaves the request re-submittable', async () => {
		const broker = new TwoFactorBroker({ timeoutMs: 5_000 })
		const parked = broker.requestCode()
		const requestId = broker.status().pending!.requestId

		expect(broker.submitCode(requestId, '   ').ok).toBe(false)
		expect(broker.status().state).toBe('awaiting_code')

		expect(broker.submitCode(requestId, ` ${SECRET_CODE} `).ok).toBe(true)
		expect(await parked).toBe(SECRET_CODE)
	})

	test('the code never reaches stderr', async () => {
		const broker = new TwoFactorBroker({ timeoutMs: 5_000 })

		const captured = await captureStderr(async () => {
			const parked = broker.requestCode()
			const requestId = broker.status().pending!.requestId
			broker.submitCode(requestId, SECRET_CODE)
			await parked
			broker.submitCode(requestId, SECRET_CODE)
		})

		expect(captured).not.toContain(SECRET_CODE)
		// The request is announced, so absence isn't just an empty capture.
		expect(captured).toMatch(/two-factor code requested/i)
	})

	test('the prompt names the method and the requestId the agent must echo', () => {
		const prompt = twoFactorPrompt(
			{ requestId: 'a1b2c3d4', method: 'emailOtp', expiresAt: Date.now() + 1_000 },
			'vrchat__getCurrentUser'
		)

		expect(prompt).toContain('emailed')
		expect(prompt).toContain('a1b2c3d4')
		expect(prompt).toContain('vrchat_submitTwoFactorCode')
		expect(prompt).toContain('vrchat__getCurrentUser')
	})
})
