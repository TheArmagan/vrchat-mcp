/**
 * Unknown properties have to survive the round trip.
 *
 * The VRChat spec is community-maintained and openly incomplete in places:
 * `createProductListingDirect` documents its own body as "based on observed
 * fields and may be incomplete", and the API wants a field the spec does not
 * list. A schema that strips what it does not recognise makes that endpoint
 * impossible to call, and does it invisibly: the request goes out without the
 * field and comes back with the identical error, so the caller cannot tell
 * their workaround was discarded.
 */

import { describe, expect, test } from 'bun:test'

import { operationsById } from '../src/generated/operations.ts'
import { inputSchemaFor, splitArguments } from '../src/registry.ts'
import { classifyRequest } from '../src/tools/request.ts'

const listing = operationsById.createProductListingDirect!

describe('the spec admits it is incomplete', () => {
	test('createProductListingDirect is the endpoint in question', () => {
		expect(listing.description.toLowerCase()).toContain('may be incomplete')
	})
})

describe('unknown properties reach the request', () => {
	test('an undocumented body field is forwarded, not dropped', () => {
		const { body } = splitArguments(listing, {
			displayName: 'Thing',
			productIds: ['prod_1'],
			// Not in the spec. The API asks for it anyway.
			products: [{ productId: 'prod_1' }]
		})

		expect(body).toMatchObject({ products: [{ productId: 'prod_1' }] })
	})

	test('documented fields still land where they belong', () => {
		const { path, query, body } = splitArguments(operationsById.getUser!, { userId: 'usr_1' })

		expect(path).toEqual({ userId: 'usr_1' })
		expect(query).toEqual({})
		expect(body).toBeUndefined()
	})

	test('extras are named, so the caller can see what was passed through', () => {
		const { extras } = splitArguments(listing, { displayName: 'x', products: [] })

		expect(extras).toEqual(['products'])
	})

	test('an operation with no body sends extras as query parameters', () => {
		// The only other place a GET could want them. Dropping them here would
		// leave read endpoints with the same problem writes had.
		const { query, body } = splitArguments(operationsById.getUser!, {
			userId: 'usr_1',
			someNewFilter: 'yes'
		})

		expect(body).toBeUndefined()
		expect(query).toEqual({ someNewFilter: 'yes' })
	})

	test('undefined values are not forwarded as keys', () => {
		const { extras } = splitArguments(listing, { displayName: 'x', products: undefined })

		expect(extras).toEqual([])
	})

	test('the registered schema keeps unknown keys instead of stripping them', () => {
		// Zod strips by default, which is what made the workaround impossible:
		// the field vanished before the request was built, so the API returned
		// the same error and nothing looked wrong.
		const parsed = inputSchemaFor(listing).parse({
			displayName: 'Thing',
			products: [{ productId: 'prod_1' }]
		}) as Record<string, unknown>

		expect(parsed.products).toEqual([{ productId: 'prod_1' }])
	})

	test('an observed body does not enforce its guessed required list', () => {
		// The spec says this body is "based on observed fields", so its
		// `required` list is observation too. Enforcing it blocks the workaround
		// that makes the endpoint callable at all.
		expect(inputSchemaFor(listing).safeParse({ products: [] }).success).toBe(true)
	})

	test('a properly specified body still enforces its required fields', () => {
		// The relaxation is driven by the spec's own wording, not applied
		// everywhere, so ordinary endpoints keep their guarantees.
		expect(inputSchemaFor(operationsById.getUser!).safeParse({}).success).toBe(false)
	})
})

describe('raw request classification', () => {
	test('method decides the ordinary cases', () => {
		expect(classifyRequest('get', '/users/usr_1')).toBe('read')
		expect(classifyRequest('post', '/listing')).toBe('write')
		expect(classifyRequest('put', '/products/prod_1')).toBe('write')
		expect(classifyRequest('delete', '/products/prod_1')).toBe('destructive')
	})

	test('money and admin paths outrank the method', () => {
		// Without an operationId there is no override list, so the path is the
		// only signal, and it has to win. A GET under /tilia is still money.
		expect(classifyRequest('get', '/user/usr_1/tilia/kyc')).toBe('money')
		expect(classifyRequest('post', '/economy/purchase/listing')).toBe('money')
		expect(classifyRequest('post', '/feedback/moderationReports')).toBe('admin')
	})

	test('a raw delete is gated exactly like the generated one', () => {
		expect(classifyRequest('delete', '/products/prod_1')).toBe(
			operationsById.deleteProduct!.kind
		)
	})
})
