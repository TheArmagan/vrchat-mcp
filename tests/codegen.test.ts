/**
 * Guards the generated tool table. Offline: it only imports the committed
 * `src/generated/operations.ts`, so it fails on a bad regeneration rather than
 * on upstream being down.
 */

import { describe, expect, test } from 'bun:test'
import { operations, operationsById } from '../src/generated/operations.ts'
import type { Operation } from '../src/types.ts'

/** Counts the plan calls out by name; a drift here means upstream moved. */
const EXPECTED_TAG_COUNTS: Record<string, number> = {
	economy: 41,
	inventory: 15,
	props: 8,
	prints: 5,
	groups: 51,
	users: 28
}

function countByTag(tag: string): number {
	return operations.filter((operation) => operation.tag === tag).length
}

describe('coverage', () => {
	test('the whole spec surface is emitted', () => {
		expect(operations.length).toBeGreaterThanOrEqual(250)
		expect(operations.length).toBe(297)
	})

	test('every operation is reachable by id', () => {
		expect(Object.keys(operationsById).length).toBe(operations.length)
		expect(operationsById.getCurrentUser?.operationId).toBe('getCurrentUser')
	})

	for (const [tag, expected] of Object.entries(EXPECTED_TAG_COUNTS)) {
		test(`tag ${tag} has ${expected} operations`, () => {
			expect(countByTag(tag)).toBe(expected)
		})
	}
})

describe('naming invariant', () => {
	test('no generated tool collapses to a single underscore', () => {
		// `vrchat_<x>` is reserved for hand-written tools; the separator is the
		// only signal of provenance, so it must never be ambiguous.
		for (const operation of operations) {
			const name = `vrchat__${operation.operationId}`
			expect(name.startsWith('vrchat__')).toBe(true)
			expect(/^vrchat_[^_]/.test(name)).toBe(false)
			expect(operation.operationId).toMatch(/^[a-z][A-Za-z0-9]*$/)
		}
	})

	test('operationIds are unique', () => {
		expect(new Set(operations.map((o) => o.operationId)).size).toBe(operations.length)
	})
})

describe('schemas', () => {
	test('every input schema parses without throwing', () => {
		for (const operation of operations) {
			expect(() => operation.inputSchema.safeParse({})).not.toThrow()
		}
	})

	test('no operation declares a real _responseKeys parameter', () => {
		// The registry appends its own `_responseKeys`; a real one would be shadowed
		// and a genuine API argument would silently vanish.
		for (const operation of operations) {
			const declared = [
				...operation.params.path,
				...operation.params.query,
				...(operation.params.body ?? [])
			]
			expect(declared).not.toContain('_responseKeys')
		}
	})

	test('path params are required and present in the schema', () => {
		const op = operationsById.getUser as Operation
		expect(op.params.path).toEqual(['userId'])
		expect(op.inputSchema.safeParse({}).success).toBe(false)
		expect(op.inputSchema.safeParse({ userId: 'usr_x' }).success).toBe(true)
	})
})

describe('pagination', () => {
	test('paginated ops carry both n and offset', () => {
		for (const operation of operations.filter((o) => o.paginated)) {
			expect(operation.params.query).toContain('n')
			expect(operation.params.query).toContain('offset')
		}
	})

	test('n defaults to 25 rather than the spec default', () => {
		const parsed = (operationsById.searchWorlds as Operation).inputSchema.parse({}) as {
			n: number
		}
		expect(parsed.n).toBe(25)
	})
})

describe('kind classification', () => {
	const cases: Record<string, string> = {
		deleteUser: 'admin',
		getCSS: 'admin',
		submitModerationReport: 'admin',
		purchaseProductListing: 'money',
		getUserTiliaKyc: 'money',
		getEconomyPayouts: 'money',
		getCurrentUser: 'read',
		getBalance: 'read',
		deleteProduct: 'destructive',
		closeInstance: 'destructive',
		updateUser: 'write',
		// Managing your own storefront spends nothing and earns nothing, so it
		// is an ordinary write. Filing it under `money` meant a creator could
		// not rename their own product without also granting purchase rights.
		createProduct: 'write',
		updateProduct: 'write',
		createProductListingDirect: 'write',
		updateProductListingDirect: 'write'
	}

	for (const [operationId, kind] of Object.entries(cases)) {
		test(`${operationId} is ${kind}`, () => {
			expect(operationsById[operationId]?.kind).toBe(kind as Operation['kind'])
		})
	}

	test('every kind is one of the five known values', () => {
		const known = new Set(['read', 'write', 'destructive', 'money', 'admin'])
		for (const operation of operations) expect(known.has(operation.kind)).toBe(true)
	})
})

describe('the store tag', () => {
	test('narrows economy down to the storefront', () => {
		// `economy` is one tag over the storefront, wallet balances, purchase
		// history and the payment processor, so filtering on it barely narrows
		// anything for a creator who only manages products.
		const store = Object.values(operationsById).filter((op) => op.tags.includes('store'))
		const economy = Object.values(operationsById).filter((op) => op.tags.includes('economy'))

		expect(store.length).toBeGreaterThan(0)
		expect(store.length).toBeLessThan(economy.length)
	})

	test('covers the full product and listing lifecycle', () => {
		for (const id of [
			'listUserProducts',
			'createProduct',
			'updateProduct',
			'deleteProduct',
			'createProductListingDirect',
			'updateProductListingDirect',
			'deleteProductListingDirect',
			'getProductListings'
		]) {
			expect(operationsById[id]?.tags).toContain('store')
		}
	})

	test('leaves the wallet and payment processor out of it', () => {
		for (const id of ['getBalance', 'getUserTiliaKyc', 'getEconomyPayouts', 'getTiliaStatus']) {
			expect(operationsById[id]?.tags).not.toContain('store')
		}
	})

	test('keeps the spec tag as primary, so nothing leaves economy', () => {
		expect(operationsById.updateProduct?.tag).toBe('economy')
		expect(operationsById.updateProduct?.tags).toContain('economy')
	})
})
