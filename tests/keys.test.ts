/**
 * Asking for keys, rather than being told every time.
 *
 * The key list used to ride along on every projected response. That solved
 * discovery by charging every successful call for the benefit of the occasional
 * one that needed help. These tests pin the replacement: nothing on success,
 * everything on a miss, and a tool for asking deliberately.
 */

import { describe, expect, test } from 'bun:test'

import { operationsById } from '../src/generated/operations.ts'
import { AVAILABLE_KEYS_KEY, keyOutline, project, UNMATCHED_KEY } from '../src/project.ts'
import world from './fixtures/world.json' with { type: 'json' }

type Bag = Record<string, unknown>

const raw = world as unknown as Bag

describe('meta is no longer a tax on every call', () => {
	test('a hit costs nothing beyond the fields asked for', () => {
		const result = project(raw, ['id', 'name']) as Bag

		expect(Object.keys(result).sort()).toEqual(['id', 'name'])
	})

	test('narrowing is measurably cheaper than it used to be', () => {
		// The old behaviour appended up to 50 key names to this same response.
		// For a two-field projection that was most of the payload.
		const size = JSON.stringify(project(raw, ['id'])).length

		expect(size).toBeLessThan(120)
	})

	test('a miss still explains itself, because that is the dead end', () => {
		const result = project(raw, ['nope']) as Bag

		expect(result[UNMATCHED_KEY]).toEqual(['nope'])
		expect(result[AVAILABLE_KEYS_KEY]).toContain('name')
	})
})

describe('the spec answers most questions for free', () => {
	test('codegen already stored the response fields', () => {
		// This is why the common case needs no API call at all.
		expect(operationsById.getBalance?.responseKeys).toContain('balance')
		expect(operationsById.getCurrentUser?.responseKeys).toContain('displayName')
	})
})

describe('keyOutline', () => {
	test('keeps names and types, drops every value', () => {
		const outline = keyOutline({ id: 'usr_1', visits: 12, active: true }) as Bag

		expect(outline).toEqual({ id: 'string', visits: 'number', active: 'boolean' })
	})

	test('describes an array by one element, not all of them', () => {
		// VRChat listings are homogeneous, so outlining every element would just
		// repeat the same shape at the caller's expense.
		const outline = keyOutline([{ id: 'a' }, { id: 'b' }, { id: 'c' }]) as Bag

		expect(outline['<array>']).toBe(3)
		expect(outline['*']).toEqual({ id: 'string' })
	})

	test('stops at the requested depth', () => {
		const deep = { a: { b: { c: { d: 1 } } } }

		expect(keyOutline(deep, 1)).toEqual({ a: 'object' })
		expect(keyOutline(deep, 2)).toEqual({ a: { b: 'object' } })
	})

	test('an empty array says so rather than claiming no shape', () => {
		expect(keyOutline([])).toEqual({ '<array>': 'empty' })
	})

	test('null is reported as null, not object', () => {
		expect(keyOutline({ thumbnail: null })).toEqual({ thumbnail: 'null' })
	})

	test('outlining a real World costs less than fetching one', () => {
		const rawSize = JSON.stringify(raw).length
		const shallow = JSON.stringify(keyOutline(raw, 1)).length
		const nested = JSON.stringify(keyOutline(raw, 2)).length

		// Measured on this fixture: depth 1 is 73% smaller, depth 2 is 50%. Worth
		// stating plainly rather than claiming more. An outline of a 47-field
		// object costs about a kilobyte whatever you do, and depth 2 is the price
		// of being able to see nested paths like author.displayName.
		expect(shallow).toBeLessThan(rawSize / 3)
		expect(nested).toBeLessThan(rawSize / 1.9)
	})
})

describe('a live call can pay for itself', () => {
	test('outline and data come from one response, not two requests', () => {
		// Without this the caller learns the shape, then has to fetch the same
		// resource again to actually use it. The request is already paid for.
		const outline = keyOutline(raw, 1)
		const data = project(raw, ['id', 'name'])

		expect(outline).toHaveProperty('id')
		expect(data).toEqual({ id: raw.id, name: raw.name })
	})

	test('asking for nothing stays outline-only', () => {
		// The default has to remain cheap, or the tool re-creates the problem it
		// was added to solve.
		expect(project(raw, []) as unknown).toBe(raw)
	})
})
