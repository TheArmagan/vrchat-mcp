import { describe, expect, test } from 'bun:test'
import { describeError, hintForStatus, toToolError } from '../src/errors.ts'
import type { ToolErrorDetail } from '../src/types.ts'

/** Stands in for the SDK's `VRChatError`: status getter plus a sync body helper. */
class FakeVRChatError extends Error {
	constructor(
		readonly statusCode: number,
		private readonly body: string
	) {
		super(`VRChat API error: ${statusCode}`)
		this.name = 'VRChatError'
	}

	toResponseContent() {
		return { error: { message: this.body, status_code: this.statusCode } }
	}
}

/** The `{ data, error, response }` shape a `throwOnError: false` call resolves to. */
function fieldsResult(status: number, message: string) {
	return {
		data: undefined,
		error: { error: { message, status_code: status } },
		response: new Response(null, { status })
	}
}

function textOf(result: ReturnType<typeof toToolError>): ToolErrorDetail {
	const first = result.content[0]
	expect(first?.type).toBe('text')
	return JSON.parse((first as { text: string }).text) as ToolErrorDetail
}

describe('status hints', () => {
	const cases: Array<[number, string]> = [
		[401, 'vrchat_authStatus'],
		[403, 'insufficient permissions'],
		[404, 'check the id'],
		[429, 'retry shortly'],
		[400, 'Check the arguments against the tool schema'],
		[500, 'VRChat-side failure'],
		[503, 'VRChat-side failure']
	]

	for (const [status, fragment] of cases) {
		test(`${status} produces an isError result with status, message and hint`, () => {
			const result = toToolError(new FakeVRChatError(status, `"failure ${status}"`))
			expect(result.isError).toBe(true)
			const detail = textOf(result)
			expect(detail.status).toBe(status)
			expect(detail.message).toBe(`failure ${status}`)
			expect(detail.hint).toContain(fragment)
		})
	}

	test('the 400 hint points at the way out when the spec is wrong', () => {
		// Parts of the VRChat spec are documented upstream as incomplete, so a
		// 400 is as likely to mean "the schema is wrong" as "you are". The hint
		// has to say so, or the agent keeps rewriting a correct call.
		const detail = textOf(toToolError(new FakeVRChatError(400, '"bad"')))

		expect(detail.hint).toContain('vrchat_request')
		expect(detail.hint).toContain('extra properties are passed through')
	})

	test('an unrecognized 4xx falls back to the malformed-request hint', () => {
		expect(hintForStatus(418)).toBe(hintForStatus(400))
	})
})

describe('input shapes', () => {
	test('VRChatError: status from the getter, message from the body', () => {
		const detail = describeError(new FakeVRChatError(401, '"Missing Credentials"'))
		expect(detail).toEqual({
			status: 401,
			message: 'Missing Credentials',
			hint: hintForStatus(401)
		})
	})

	test('a throwOnError:false result', () => {
		const detail = describeError(fieldsResult(404, '"World not found"'))
		expect(detail.status).toBe(404)
		expect(detail.message).toBe('World not found')
		expect(detail.hint).toContain('check the id')
	})

	test('a result whose body is a bare object without the error wrapper', () => {
		const detail = describeError({
			data: undefined,
			error: { message: 'Too Many Requests' },
			response: new Response(null, { status: 429 })
		})
		expect(detail.status).toBe(429)
		expect(detail.message).toBe('Too Many Requests')
	})

	test('a bare Response', () => {
		const detail = describeError(new Response(null, { status: 403, statusText: 'Forbidden' }))
		expect(detail).toEqual({ status: 403, message: 'Forbidden', hint: hintForStatus(403) })
	})

	test('a generic Error keeps its message and reports no status', () => {
		const detail = describeError(new Error('socket hang up'))
		expect(detail.status).toBeNull()
		expect(detail.message).toBe('socket hang up')
	})

	test('a thrown string', () => {
		const detail = describeError('something broke')
		expect(detail).toEqual({ status: null, message: 'something broke', hint: hintForStatus(null) })
	})

	test('undefined still yields a usable detail rather than throwing', () => {
		expect(describeError(undefined).message).toBe('unknown error')
		expect(describeError(null).status).toBeNull()
	})

	test('the limiter timeout is matched by name, not by import', () => {
		const timeout = Object.assign(new Error('waited 30000ms for a token'), {
			name: 'RateLimitTimeoutError'
		})
		const detail = describeError(timeout)
		expect(detail.status).toBeNull()
		expect(detail.hint).toBe('queued behind the local rate limiter — retry')
	})

	test('a code-tagged limiter timeout maps the same way', () => {
		const detail = describeError({ code: 'RATE_LIMIT_TIMEOUT', message: 'gave up waiting' })
		expect(detail.hint).toBe('queued behind the local rate limiter — retry')
		expect(detail.message).toBe('gave up waiting')
	})

	test('a status with no message still says something concrete', () => {
		expect(describeError(new Response(null, { status: 500, statusText: '' })).message).toBe('HTTP 500')
	})
})

describe('nothing leaks', () => {
	test('a real stack never reaches the result', () => {
		const error = new Error('boom')
		expect(error.stack).toContain('errors.test')
		const serialized = JSON.stringify(toToolError(error))
		expect(serialized).not.toMatch(/at\s+\S+\.ts:/)
		expect(serialized).not.toContain('errors.test')
		expect(serialized).not.toContain('.ts:')
	})

	test('a message that embeds a stack is cut at the first frame', () => {
		const detail = describeError('failed to fetch\n    at doThing (/home/someone/src/x.ts:12:3)')
		expect(detail.message).toBe('failed to fetch')
	})

	test('an oversized message is truncated', () => {
		const detail = describeError('x'.repeat(5000))
		expect(detail.message.length).toBeLessThanOrEqual(501)
		expect(detail.message.endsWith('…')).toBe(true)
	})

	test('an error whose body helper throws is still reported', () => {
		const broken = {
			statusCode: 403,
			toResponseContent: () => {
				throw new Error('malformed')
			},
			message: 'Forbidden'
		}
		const detail = describeError(broken)
		expect(detail.status).toBe(403)
		expect(detail.message).toBe('Forbidden')
	})
})
