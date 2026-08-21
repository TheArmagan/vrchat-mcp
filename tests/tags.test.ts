/**
 * Tag filtering.
 *
 * Two failure modes are covered here because both look identical from the
 * outside: an empty tool list. One is asking for everything and getting
 * nothing; the other is a typo silently matching no operations.
 */

import { describe, expect, test } from 'bun:test'

import { parseTagFilter } from '../src/config.ts'
import { knownTags } from '../src/registry.ts'

describe('the everything sentinel', () => {
	test('collapses to no filter, the same as unset', () => {
		// An MCP client config is a JSON object of strings, so removing a key is
		// often more awkward than changing its value. `everything` is the way to
		// say "no filter" without emptying the setting.
		expect(parseTagFilter(new Set(['everything']))).toBeNull()
	})

	test('accepts the spellings people actually try', () => {
		for (const value of ['all', '*']) {
			expect(parseTagFilter(new Set([value]))).toBeNull()
		}
	})

	test('wins when mixed with real tags', () => {
		// Asking for everything and something is still everything; the
		// alternative is silently ignoring half the setting.
		expect(parseTagFilter(new Set(['store', 'everything']))).toBeNull()
	})

	test('leaves an ordinary filter alone', () => {
		expect(parseTagFilter(new Set(['store', 'users']))).toEqual(new Set(['store', 'users']))
	})

	test('unset stays unset', () => {
		expect(parseTagFilter(null)).toBeNull()
	})
})

describe('known tags', () => {
	test('covers the spec tags plus the synthetic ones', () => {
		const tags = knownTags()

		expect(tags).toContain('economy')
		expect(tags).toContain('worlds')
		expect(tags).toContain('store')
	})

	test('none of the sentinels is a real tag', () => {
		// If VRChat ever shipped a tag called `all`, the sentinel would shadow it.
		const tags = new Set(knownTags())

		for (const sentinel of ['everything', 'all', '*']) {
			expect(tags.has(sentinel)).toBe(false)
		}
	})
})
