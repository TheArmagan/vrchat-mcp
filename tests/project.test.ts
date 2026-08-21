import { describe, expect, test } from 'bun:test'
import {
	AVAILABLE_KEYS_CAP,
	AVAILABLE_KEYS_KEY,
	RESULT_KEY,
	UNMATCHED_KEY,
	availableKeys,
	describeResponseKeys,
	project
} from '../src/project.ts'
import world from './fixtures/world.json' with { type: 'json' }

type Bag = Record<string, unknown>

const raw = world as unknown as Bag

/** Strips the discovery meta so a projection can be compared to the payload. */
function withoutMeta(value: unknown): Bag {
	const { [AVAILABLE_KEYS_KEY]: _keys, [UNMATCHED_KEY]: _unmatched, ...rest } = value as Bag
	return rest
}

function bytes(value: unknown): number {
	return JSON.stringify(value)!.length
}

describe('the raw escape hatch', () => {
	test('["*"] returns the payload byte-identical', () => {
		const result = project(raw, ['*'])
		expect(result).toBe(raw)
		expect(JSON.stringify(result)).toBe(JSON.stringify(raw))
	})

	test('an omitted or empty keys argument means the same thing', () => {
		expect(JSON.stringify(project(raw))).toBe(JSON.stringify(raw))
		expect(JSON.stringify(project(raw, []))).toBe(JSON.stringify(raw))
	})

	test('raw passthrough carries no meta keys at all', () => {
		expect(Object.hasOwn(project(raw, ['*']) as Bag, AVAILABLE_KEYS_KEY)).toBe(false)
	})
})

describe('selection', () => {
	test('top-level fields', () => {
		const result = withoutMeta(project(raw, ['id', 'name']))
		expect(result).toEqual({ id: raw.id, name: raw.name })
	})

	test('a nested path stays nested rather than flattening', () => {
		const result = withoutMeta(project(raw, ['author.displayName']))
		expect(result).toEqual({ author: { displayName: 'PubKeeper' } })
		expect(result).not.toHaveProperty('displayName')
	})

	test('"*.id" pulls a field from every element of a top-level array', () => {
		const list = [
			{ id: 'a', name: 'first', bulk: 'x'.repeat(200) },
			{ id: 'b', name: 'second', bulk: 'y'.repeat(200) },
			{ id: 'c', name: 'third', bulk: 'z'.repeat(200) }
		]
		const result = project(list, ['*.id']) as Bag
		// An array projection cannot carry meta in place without JSON dropping it,
		// so it arrives under `_result` with the array itself untouched.
		expect(result[RESULT_KEY]).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
	})

	test('"*.id" also walks a top-level object of objects', () => {
		const map = { one: { id: 1, extra: true }, two: { id: 2, extra: false } }
		expect(withoutMeta(project(map, ['*.id']))).toEqual({ one: { id: 1 }, two: { id: 2 } })
	})

	test('"items.*.name" unions with a sibling pattern into the same elements', () => {
		const page = {
			items: [
				{ id: 'i1', name: 'Alpha', description: 'long...' },
				{ id: 'i2', name: 'Beta', description: 'long...' }
			],
			total: 2
		}
		const result = withoutMeta(project(page, ['items.*.id', 'items.*.name']))
		expect(result).toEqual({
			items: [
				{ id: 'i1', name: 'Alpha' },
				{ id: 'i2', name: 'Beta' }
			]
		})
	})

	test('array order and length survive projection', () => {
		const result = withoutMeta(project(raw, ['unityPackages.*.platform']))
		const packages = result.unityPackages as Bag[]
		expect(packages).toHaveLength((raw.unityPackages as unknown[]).length)
		expect(packages.map((entry) => entry.platform)).toEqual([
			'standalonewindows',
			'android',
			'standalonewindows'
		])
	})

	test('"**" below an element takes everything at any depth', () => {
		const result = withoutMeta(project(raw, ['unityPackages.*.**']))
		expect(result.unityPackages).toEqual(raw.unityPackages)
		expect(result).not.toHaveProperty('description')
	})

	test('a bare "**" reproduces the whole payload, projected', () => {
		const result = project(raw, ['**'])
		expect(withoutMeta(result)).toEqual(raw)
		expect((result as Bag)[AVAILABLE_KEYS_KEY]).toContain('id')
	})
})

describe('exclusion', () => {
	test('["*", "!description"] is raw minus that field', () => {
		const result = withoutMeta(project(raw, ['*', '!description']))
		expect(result).not.toHaveProperty('description')
		expect(Object.keys(result).sort()).toEqual(
			Object.keys(raw)
				.filter((key) => key !== 'description')
				.sort()
		)
		expect(result.unityPackages).toEqual(raw.unityPackages)
	})

	test('exclusion reaches into every array element', () => {
		const result = withoutMeta(project(raw, ['unityPackages.*.**', '!unityPackages.*.assetUrl']))
		for (const entry of result.unityPackages as Bag[]) {
			expect(entry).not.toHaveProperty('assetUrl')
			expect(entry).toHaveProperty('platform')
		}
	})

	test('an exclusion that matches nothing is a silent no-op', () => {
		const result = withoutMeta(project(raw, ['id', '!notAField']))
		expect(result).toEqual({ id: raw.id })
	})
})

describe('discovery', () => {
	test('an unmatched path returns _unmatched and _availableKeys, never an empty object', () => {
		const result = project(raw, ['authorDisplayName']) as Bag
		expect(result[UNMATCHED_KEY]).toEqual(['authorDisplayName'])
		const keys = result[AVAILABLE_KEYS_KEY] as string[]
		expect(keys).toContain('authorName')
		expect(keys).toContain('author')
		expect(Object.keys(result).length).toBeGreaterThan(0)
	})

	test('a partial miss still returns what did match', () => {
		const result = project(raw, ['id', 'nope']) as Bag
		expect(result.id).toBe(raw.id)
		expect(result[UNMATCHED_KEY]).toEqual(['nope'])
	})

	test('_availableKeys ships on every projected response', () => {
		expect((project(raw, ['id']) as Bag)[AVAILABLE_KEYS_KEY]).toContain('visits')
	})

	test('array element keys are listed in usable "*.field" form', () => {
		const result = project([{ id: 1, name: 'x' }], ['*.id']) as Bag
		expect(result[AVAILABLE_KEYS_KEY]).toEqual(['*.id', '*.name'])
	})

	test('_availableKeys is capped and names-only', () => {
		const wide: Bag = {}
		for (let i = 0; i < 80; i++) wide[`field${i}`] = i
		const keys = availableKeys(wide)
		expect(keys).toHaveLength(AVAILABLE_KEYS_CAP + 1)
		expect(keys.at(-1)).toBe(`+${80 - AVAILABLE_KEYS_CAP} more`)
	})

	test('a payload owning a meta key keeps it; the meta moves into an envelope', () => {
		const collide = { id: 'x', [AVAILABLE_KEYS_KEY]: ['payload-owned'] }
		const result = project(collide, ['id', AVAILABLE_KEYS_KEY]) as Bag
		expect((result[RESULT_KEY] as Bag)[AVAILABLE_KEYS_KEY]).toEqual(['payload-owned'])
		expect(result[AVAILABLE_KEYS_KEY]).toEqual(['id', AVAILABLE_KEYS_KEY])
	})

	test('the tool description documents the syntax and the meta keys', () => {
		const text = describeResponseKeys(['id', 'name'])
		expect(text).toContain(AVAILABLE_KEYS_KEY)
		expect(text).toContain(UNMATCHED_KEY)
		expect(text).toContain('Top-level fields for this operation: id, name.')
	})
})

describe('the point of the exercise', () => {
	test('projection measurably shrinks the payload', () => {
		const full = bytes(raw)
		const narrow = bytes(project(raw, ['id', 'name', 'author.displayName']))
		expect(narrow).toBeLessThan(full)
		// The fat fields are the reason this exists; a token trim would not do.
		expect(narrow).toBeLessThan(full / 2)
	})

	test('subtracting the fat fields shrinks the raw response', () => {
		// Discovery meta has a fixed cost, so subtraction has to clear it before it
		// shows up as a saving — dropping one short field can legitimately not.
		const trimmed = project(raw, ['*', '!description', '!unityPackages'])
		expect(bytes(trimmed)).toBeLessThan(bytes(raw))
		expect(withoutMeta(trimmed)).not.toHaveProperty('description')
	})

	test('projection never mutates the payload it was given', () => {
		const before = JSON.stringify(raw)
		project(raw, ['*', '!description'])
		project(raw, ['unityPackages.*.id'])
		expect(JSON.stringify(raw)).toBe(before)
	})
})
