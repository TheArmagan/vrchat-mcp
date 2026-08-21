/**
 * Agent-driven field projection (PLAN §9).
 *
 * The server never curates response fields; the caller does, per call, through
 * `_responseKeys`. A hand-picked field list guesses what matters and is wrong
 * for whoever needed the other field — and it would have to be maintained for
 * ~250 operations against a moving spec. The agent knows what it wants on this
 * call, so it says so.
 *
 * Two invariants make that trade safe:
 *
 * 1. **Shape is preserved.** Objects stay nested, arrays stay arrays with their
 *    order and length intact. The agent gets a smaller version of the same
 *    structure, so a path learned on one call still works on the next.
 * 2. **Nothing fails silently.** A path that matches nothing is reported back
 *    in `_unmatched`, and `_availableKeys` ships on every projected response,
 *    so one retry lands it instead of the agent staring at `{}`.
 *
 * Pure and dependency-free: no I/O, no SDK, no config. Everything here is a
 * function of its arguments so the whole module is unit-testable offline.
 */

/** Meta key: paths from `_responseKeys` that selected nothing. */
export const UNMATCHED_KEY = '_unmatched'

/** Meta key: names the caller can ask for on the next call. */
export const AVAILABLE_KEYS_KEY = '_availableKeys'

/**
 * Envelope field used when meta cannot be attached in place — i.e. the
 * projection is an array or a scalar, or the payload itself already owns one of
 * the meta key names.
 */
export const RESULT_KEY = '_result'

/** Upper bound on `_availableKeys` entries, so discovery never becomes the payload. */
export const AVAILABLE_KEYS_CAP = 50

/** How many array elements are sampled when collecting an array's element keys. */
const ARRAY_SAMPLE = 20

/** Returned by the matchers when a pattern selected nothing at this node. */
const NO_MATCH = Symbol('no-match')

/** Returned by the exclusion walk when a node should disappear entirely. */
const DELETE = Symbol('delete')

type PlainObject = Record<string, unknown>

function isPlainObject(value: unknown): value is PlainObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Structural clone limited to JSON shapes. `structuredClone` would also copy
 * Maps, Dates and cycles that can never appear in a parsed HTTP response, and
 * would throw on the odd non-cloneable value; a plain walk cannot.
 */
function clone<T>(value: T): T {
	if (Array.isArray(value)) return value.map(clone) as unknown as T
	if (isPlainObject(value)) {
		const out: PlainObject = {}
		for (const [key, entry] of Object.entries(value)) out[key] = clone(entry)
		return out as T
	}
	return value
}

/**
 * Merges one pattern's projection into the accumulated result. Objects merge
 * key-wise; arrays merge element-wise by index so that `items.*.id` and
 * `items.*.name` land in the *same* elements rather than producing two arrays.
 */
function merge(target: unknown, source: unknown): unknown {
	if (isPlainObject(target) && isPlainObject(source)) {
		const out: PlainObject = { ...target }
		for (const [key, value] of Object.entries(source)) {
			out[key] = key in out ? merge(out[key], value) : value
		}
		return out
	}
	if (Array.isArray(target) && Array.isArray(source)) {
		const length = Math.max(target.length, source.length)
		const out = new Array<unknown>(length)
		for (let i = 0; i < length; i++) {
			const a = i < target.length ? target[i] : null
			const b = i < source.length ? source[i] : null
			// A null placeholder means "this element matched nothing" — the other
			// side's value, if any, is strictly more informative.
			out[i] = a === null ? b : b === null ? a : merge(a, b)
		}
		return out
	}
	return source
}

/** Splits `a.*.b` into segments; empty segments are dropped so `a..b` == `a.b`. */
function segments(path: string): string[] {
	return path.split('.').filter((segment) => segment.length > 0)
}

/**
 * Selects `segs` out of `value`, rebuilding the same shape around whatever
 * matched. Returns `NO_MATCH` when the path hit nothing at all — the caller
 * turns that into `_unmatched` rather than an empty result.
 */
function select(value: unknown, segs: string[]): unknown | typeof NO_MATCH {
	if (segs.length === 0) return clone(value)

	const [head, ...rest] = segs as [string, ...string[]]

	if (head === '**') {
		// Trailing `**` means "everything below here", at any depth.
		if (rest.length === 0) return clone(value)
		// A `**` with more behind it searches this level and every deeper one,
		// unioning the hits so shape is still preserved on the way down.
		let found: unknown = NO_MATCH
		const here = select(value, rest)
		if (here !== NO_MATCH) found = here
		const children = Array.isArray(value)
			? value.map((entry, index) => [String(index), entry] as const)
			: isPlainObject(value)
				? Object.entries(value)
				: []
		for (const [key, child] of children) {
			const deep = select(child, segs)
			if (deep === NO_MATCH) continue
			const wrapped = Array.isArray(value) ? sparseArray(value.length, Number(key), deep) : { [key]: deep }
			found = found === NO_MATCH ? wrapped : merge(found, wrapped)
		}
		return found
	}

	if (head === '*') {
		if (Array.isArray(value)) {
			// Length and order are load-bearing: an index the agent saw once must
			// still be that element next call, so misses become null placeholders
			// instead of collapsing the array.
			const out = new Array<unknown>(value.length)
			let matched = false
			for (let i = 0; i < value.length; i++) {
				const picked = select(value[i], rest)
				if (picked === NO_MATCH) {
					out[i] = null
					continue
				}
				matched = true
				out[i] = picked
			}
			return matched ? out : NO_MATCH
		}
		if (isPlainObject(value)) {
			// Object keys are names, not positions, so a key that matches nothing
			// is simply absent — dropping it is the projection doing its job.
			const out: PlainObject = {}
			let matched = false
			for (const [key, entry] of Object.entries(value)) {
				const picked = select(entry, rest)
				if (picked === NO_MATCH) continue
				matched = true
				out[key] = picked
			}
			return matched ? out : NO_MATCH
		}
		return NO_MATCH
	}

	if (Array.isArray(value)) {
		// A numeric segment indexes an array; anything else needs an explicit `*`,
		// so a typo reads as "no match" rather than silently fanning out.
		if (!/^\d+$/.test(head)) return NO_MATCH
		const index = Number(head)
		if (index >= value.length) return NO_MATCH
		const picked = select(value[index], rest)
		if (picked === NO_MATCH) return NO_MATCH
		return sparseArray(value.length, index, picked)
	}

	if (isPlainObject(value)) {
		if (!Object.hasOwn(value, head)) return NO_MATCH
		const picked = select(value[head], rest)
		if (picked === NO_MATCH) return NO_MATCH
		return { [head]: picked }
	}

	return NO_MATCH
}

/** An array of `length` nulls with one real value, so indices keep their meaning. */
function sparseArray(length: number, index: number, value: unknown): unknown[] {
	const out = new Array<unknown>(length).fill(null)
	out[index] = value
	return out
}

/**
 * Removes `segs` from `value`. Exclusions are subtractive, so a path that
 * matches nothing is a no-op — it is never reported as unmatched, since
 * "already absent" is exactly the state the caller asked for.
 */
function exclude(value: unknown, segs: string[]): unknown | typeof DELETE {
	if (segs.length === 0) return DELETE

	const [head, ...rest] = segs as [string, ...string[]]
	// `**` under an exclusion means "and everything below it", which is the same
	// as dropping the node itself.
	if (head === '**') return DELETE

	if (Array.isArray(value)) {
		if (head === '*') {
			return value.map((entry) => {
				const kept = exclude(entry, rest)
				return kept === DELETE ? null : kept
			})
		}
		if (!/^\d+$/.test(head)) return value
		const index = Number(head)
		if (index >= value.length) return value
		const out = [...value]
		const kept = exclude(out[index], rest)
		out[index] = kept === DELETE ? null : kept
		return out
	}

	if (isPlainObject(value)) {
		const out: PlainObject = {}
		for (const [key, entry] of Object.entries(value)) {
			if (head !== '*' && key !== head) {
				out[key] = entry
				continue
			}
			const kept = exclude(entry, rest)
			if (kept !== DELETE) out[key] = kept
		}
		return out
	}

	return value
}

/**
 * The names a caller can ask for next, derived from the *raw* payload — the
 * projection may have dropped the very key they were looking for.
 *
 * Array element keys come back as `*.name` rather than `name`, because that is
 * the form that actually works as a `_responseKeys` entry.
 */
export function availableKeys(value: unknown): string[] {
	const names: string[] = []
	const seen = new Set<string>()
	const push = (name: string) => {
		if (seen.has(name)) return
		seen.add(name)
		names.push(name)
	}

	if (Array.isArray(value)) {
		for (const entry of value.slice(0, ARRAY_SAMPLE)) {
			if (!isPlainObject(entry)) continue
			for (const key of Object.keys(entry)) push(`*.${key}`)
		}
	} else if (isPlainObject(value)) {
		for (const key of Object.keys(value)) push(key)
	}

	if (names.length <= AVAILABLE_KEYS_CAP) return names
	return [...names.slice(0, AVAILABLE_KEYS_CAP), `+${names.length - AVAILABLE_KEYS_CAP} more`]
}

/**
 * Attaches the discovery meta without ever shadowing real payload data.
 *
 * Meta lands inline when the projection is a plain object that does not already
 * own one of the meta names. Otherwise — an array or scalar projection, or a
 * genuine `_unmatched`/`_availableKeys` field in the payload — the projection
 * is nested under `_result` and the meta sits beside it. The payload's own
 * fields are therefore never overwritten, moved, or dropped; only the nesting
 * changes, and it changes deterministically.
 */
function withMeta(projected: unknown, source: unknown, unmatched: string[]): unknown {
	const meta: PlainObject = { [AVAILABLE_KEYS_KEY]: availableKeys(source) }
	if (unmatched.length > 0) meta[UNMATCHED_KEY] = unmatched

	const collides =
		isPlainObject(projected) &&
		(Object.hasOwn(projected, AVAILABLE_KEYS_KEY) || Object.hasOwn(projected, UNMATCHED_KEY))

	if (isPlainObject(projected) && !collides) return { ...projected, ...meta }
	return { [RESULT_KEY]: projected, ...meta }
}

/**
 * Projects `value` down to `keys`.
 *
 * `["*"]` — the default, and what an omitted or empty `keys` means — returns
 * the input by reference, byte-identical. The raw response stays reachable and
 * nothing is ever hidden; that is what makes agent-side narrowing safe to
 * default on.
 *
 * Include patterns union. Exclusions (`!path`) apply afterwards, so
 * `["*", "!description"]` reads as "raw minus this".
 */
export function project(value: unknown, keys?: string[]): unknown {
	const patterns = (keys ?? []).map((key) => key.trim()).filter(Boolean)
	const includes = patterns.filter((key) => !key.startsWith('!'))
	const excludes = patterns.filter((key) => key.startsWith('!')).map((key) => key.slice(1))

	// The escape hatch: no narrowing and no subtraction means the caller gets the
	// untouched response, identical byte for byte.
	const rawOnly = includes.length === 0 || includes.every((key) => key === '*')
	if (rawOnly && excludes.length === 0) return value

	const unmatched: string[] = []
	let projected: unknown = NO_MATCH

	for (const pattern of includes) {
		// A bare `*` is the whole payload, including scalars, where walking one
		// level down would find nothing to iterate.
		const picked = pattern === '*' ? clone(value) : select(value, segments(pattern))
		if (picked === NO_MATCH) {
			unmatched.push(pattern)
			continue
		}
		projected = projected === NO_MATCH ? picked : merge(projected, picked)
	}

	if (projected === NO_MATCH) projected = rawOnly ? clone(value) : {}

	for (const pattern of excludes) {
		const kept = exclude(projected, segments(pattern))
		projected = kept === DELETE ? {} : kept
	}

	return withMeta(projected, value, unmatched)
}

/**
 * The `_responseKeys` blurb for generated and hand-written tool descriptions.
 * Lives here so the syntax is documented next to the code that implements it
 * and cannot drift from it.
 */
export const RESPONSE_KEYS_DESCRIPTION = [
	'Fields to return, as dot paths. Narrowing this is how you avoid burning context on a fat',
	'World or User object. Default ["*"] returns the raw response untouched.',
	'Syntax: "id" top-level | "author.displayName" nested | "*.id" from every element of an',
	'array or object | "items.*.name" from every element of items | "unityPackages.*.**"',
	'everything below each element | "!description" excludes (combine with "*" for raw-minus).',
	'Shape is preserved — arrays stay arrays, order and length intact.',
	`Every response carries ${AVAILABLE_KEYS_KEY} (names only, capped at ${AVAILABLE_KEYS_CAP});`,
	`paths that match nothing come back in ${UNMATCHED_KEY} instead of silently returning empty.`
].join(' ')

/** Appends the spec's known top-level response fields, when codegen has them. */
export function describeResponseKeys(responseKeys: readonly string[] = []): string {
	if (responseKeys.length === 0) return RESPONSE_KEYS_DESCRIPTION
	const known = responseKeys.slice(0, AVAILABLE_KEYS_CAP).join(', ')
	return `${RESPONSE_KEYS_DESCRIPTION} Top-level fields for this operation: ${known}.`
}

/**
 * Alias kept for `src/registry.ts`, which names this help text `PROJECTION_HELP`
 * when it splices it into every generated tool description.
 */
export const PROJECTION_HELP = RESPONSE_KEYS_DESCRIPTION
