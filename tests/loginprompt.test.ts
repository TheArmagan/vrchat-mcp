/**
 * A parked login must report itself immediately.
 *
 * The failure this guards against is silent: the tool call simply sits there
 * until the broker's timeout, five minutes later, having never told anyone a
 * code was wanted. Nobody can answer a prompt they were not shown.
 */

import { describe, expect, test } from 'bun:test'

import { describeError } from '../src/errors.ts'
import { twoFactorPrompt } from '../src/vrchat/twofactor.ts'
import type { PendingTwoFactor } from '../src/types.ts'

function pending(method: PendingTwoFactor['method']): PendingTwoFactor {
	return { requestId: 'ab12cd34', method, expiresAt: Date.now() + 60_000 }
}

describe('two-factor prompt', () => {
	test('names the request and the tool that clears it', () => {
		const prompt = twoFactorPrompt(pending('totp'))

		expect(prompt).toContain('ab12cd34')
		expect(prompt).toContain('vrchat_submitTwoFactorCode')
		expect(prompt).toContain('authenticator')
	})

	test('email prompts cover the new-location link, not just a code', () => {
		// VRChat reports the new-location check as an ordinary emailOtp request,
		// so the prompt is the only place the two cases can be told apart. A user
		// sent a confirmation link would otherwise hunt for a code that is not
		// in the message, and the login would sit parked until it expired.
		const prompt = twoFactorPrompt(pending('emailOtp'))

		expect(prompt).toContain('vrchat_retryLogin')
		expect(prompt).toContain('somewhere new')
		expect(prompt).toContain('link')
	})

	test('an unknown method still explains both paths', () => {
		// Falling back to the code-only wording here would strand exactly the
		// users whose method we could not determine.
		const prompt = twoFactorPrompt(pending('unknown'))

		expect(prompt).toContain('vrchat_retryLogin')
	})

	test('totp prompts stay short, since no link is ever involved', () => {
		expect(twoFactorPrompt(pending('totp'))).not.toContain('vrchat_retryLogin')
	})

	test('names the tool to retry when one is given', () => {
		expect(twoFactorPrompt(pending('totp'), 'vrchat__getBalance')).toContain('vrchat__getBalance')
	})
})

describe('verification-link challenges', () => {
	test('a 401 from a new location is not reported as an expired session', () => {
		// This exact wording reached a user as "session expired — call
		// vrchat_authStatus", which is both wrong and a dead end: the session was
		// fine and no amount of re-auth clears it.
		const detail = describeError({
			status: 401,
			message: "It looks like you're logging in from somewhere new! Check your email for a message from VRChat."
		})

		expect(detail.status).toBe(401)
		expect(detail.hint).toContain('vrchat_retryLogin')
		expect(detail.hint).toContain('LINK')
		expect(detail.hint).not.toContain('session expired')
	})

	test('a 429 from too many places is not reported as rate limiting', () => {
		// VRChat reuses 429 for an auth challenge. Reading it as throttling tells
		// the agent to wait, and waiting never clears it.
		const detail = describeError({
			status: 429,
			message: 'Logging in from too many places? Check your email for verification link'
		})

		expect(detail.hint).toContain('vrchat_retryLogin')
		expect(detail.hint).toContain('session slot')
		expect(detail.hint).not.toContain('backing off')
	})

	test('a genuine 429 still reads as rate limiting', () => {
		const detail = describeError({ status: 429, message: 'Too many requests' })

		expect(detail.hint).toContain('rate limit')
		expect(detail.hint).not.toContain('vrchat_retryLogin')
	})

	test('a genuine 401 still reads as an expired session', () => {
		expect(describeError({ status: 401, message: 'Missing Credentials' }).hint).toContain(
			'vrchat_authStatus'
		)
	})
})
