/**
 * Build-time codegen: VRChat OpenAPI spec -> `src/generated/operations.ts`.
 *
 * Run `bun run generate` to pull upstream `vrchatapi/specification@main`, bundle
 * it, and re-emit the tool table. Run `bun run generate --offline` to rebuild
 * from the committed `spec/openapi.bundled.json` with no network at all.
 *
 * The bundle is committed alongside the generated file so every run produces
 * two reviewable diffs — the spec change and the tool change — and a surprising
 * tool edit can be traced back to the upstream commit that caused it.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonSchemaToZod } from 'json-schema-to-zod'
import { VRChat } from 'vrchat'
import type { OperationKind } from '../src/types.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SPEC_PATH = join(ROOT, 'spec/openapi.bundled.json')
const VERSION_PATH = join(ROOT, 'spec/VERSION.json')
const OUT_PATH = join(ROOT, 'src/generated/operations.ts')

const REPO = 'vrchatapi/specification'
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

type HttpMethod = (typeof HTTP_METHODS)[number]
type Json = Record<string, any>

/** The projection argument the registry appends to every generated tool. */
const PROJECTION_ARG = '_responseKeys'

/** Conservative page size; the spec's own defaults run as high as 100. */
const PAGE_SIZE = 25

const log = (message: string) => process.stderr.write(`${message}\n`)

function fail(message: string): never {
	log(`\nERROR  ${message}`)
	process.exit(1)
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Ops whose blast radius is larger than their HTTP verb implies, plus the
 * DELETEs that are worth naming explicitly so the list stays auditable.
 *
 * Both the plan-era names and their current upstream spellings are listed: the
 * spec renames operations, and an entry that no longer resolves is harmless
 * while a missing one silently downgrades an op to `write`.
 */
const DESTRUCTIVE = new Set([
	'deleteUser',
	'banGroupMember',
	'kickGroupMember',
	'moderateUser',
	'deleteProduct',
	'deleteProductListing',
	'deleteProductListingDirect',
	'deleteAllUserPersistence',
	'deleteAllUserPersistenceData',
	'deleteUserPersistence',
	'closeInstance',
	'clearAllPlayerModerations',
	'unmoderateUser'
])

/** Anything that can move real money or bind the account to a payout agreement. */
const MONEY = new Set([
	'purchaseProductListing',
	'getEconomyPayouts',
	'updateTiliaTosAgreementStatus',
	'updateTiliaTos',
	'createProduct',
	'createProductListing',
	'createProductListingDirect',
	'updateProduct',
	'updateProductListing',
	'updateProductListingDirect'
])

/** Paths under the payment processor; caught by path so renames can't leak one. */
const MONEY_PATH = /tilia|kyc|payout/i

/**
 * Admin-only and account-lifecycle ops. Kept in the generated table so coverage
 * stays 1:1 with the spec and this denylist is reviewable, but registered only
 * under `VRCHAT_MCP_ALLOW_ADMIN=1`.
 */
const ADMIN = new Set([
	'getAdminAssetBundle',
	'updateAssetReviewNotes',
	'deleteUser',
	'registerUserAccount',
	'confirmEmail',
	'resendEmailConfirmation',
	'getCss',
	'getCSS',
	'getJavaScript'
])

/** Moderation reporting and global avatar moderation, by path rather than by name. */
const ADMIN_PATH = /moderationReports|avatarmoderations/i

function classify(operationId: string, method: HttpMethod, path: string): OperationKind {
	if (ADMIN.has(operationId) || ADMIN_PATH.test(path)) return 'admin'
	if (MONEY.has(operationId) || MONEY_PATH.test(path)) return 'money'
	if (DESTRUCTIVE.has(operationId) || method === 'delete') return 'destructive'
	return method === 'get' ? 'read' : 'write'
}

// ---------------------------------------------------------------------------
// Spec acquisition
// ---------------------------------------------------------------------------

/** Recursively key-sorted JSON, so an upstream reordering is not a diff. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical)
	if (value === null || typeof value !== 'object') return value
	const sorted: Json = {}
	for (const key of Object.keys(value as Json).sort()) sorted[key] = canonical((value as Json)[key])
	return sorted
}

function serialize(value: unknown): string {
	return `${JSON.stringify(canonical(value), null, '\t')}\n`
}

async function run(command: string[], cwd: string): Promise<void> {
	const proc = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
	const [, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited
	])
	if (code !== 0) fail(`\`${command.join(' ')}\` exited ${code}\n${stderr.trim()}`)
}

interface SpecVersion {
	sha: string
	fetchedAt: string
	contentHash: string
}

async function fetchSpec(): Promise<{ spec: Json; version: SpecVersion }> {
	log(`fetching ${REPO}@main …`)
	const head = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
		headers: { accept: 'application/vnd.github+json', 'user-agent': 'vrchat-mcp-codegen' }
	})
	if (!head.ok) fail(`GitHub API ${head.status} ${head.statusText} resolving ${REPO}@main`)
	const sha = ((await head.json()) as Json).sha as string
	if (!/^[0-9a-f]{40}$/.test(sha ?? '')) fail(`GitHub returned a malformed commit sha: ${sha}`)

	const work = await mkdtemp(join(tmpdir(), 'vrchat-spec-'))
	try {
		const tarball = await fetch(`https://codeload.github.com/${REPO}/tar.gz/${sha}`)
		if (!tarball.ok) fail(`tarball download failed: ${tarball.status} ${tarball.statusText}`)
		const archive = join(work, 'repo.tar.gz')
		await writeFile(archive, Buffer.from(await tarball.arrayBuffer()))
		await run(['tar', '-xzf', 'repo.tar.gz'], work)

		// codeload prefixes every entry with `<repo>-<sha>/`.
		const repoDir = join(work, `specification-${sha}`)
		const bundled = join(work, 'bundled.json')
		await run(
			['bunx', 'redocly', 'bundle', 'openapi/openapi.yaml', '-o', bundled, '--ext', 'json'],
			repoDir
		)

		const spec = JSON.parse(await readFile(bundled, 'utf8')) as Json
		const text = serialize(spec)
		const version: SpecVersion = {
			sha,
			fetchedAt: new Date().toISOString(),
			contentHash: `sha256:${createHash('sha256').update(text).digest('hex')}`
		}
		await mkdir(join(ROOT, 'spec'), { recursive: true })
		await writeFile(SPEC_PATH, text)
		await writeFile(VERSION_PATH, serialize(version))
		return { spec: JSON.parse(text) as Json, version }
	} finally {
		await rm(work, { recursive: true, force: true })
	}
}

async function loadSpec(): Promise<{ spec: Json; version: SpecVersion }> {
	const spec = JSON.parse(await readFile(SPEC_PATH, 'utf8')) as Json
	const version = JSON.parse(await readFile(VERSION_PATH, 'utf8')) as SpecVersion
	return { spec, version }
}

// ---------------------------------------------------------------------------
// $ref resolution
// ---------------------------------------------------------------------------

/**
 * Inlines every `#/components/...` pointer. The bundle is already flat across
 * files but keeps internal pointers, and `json-schema-to-zod` renders an
 * unresolved `$ref` as `z.any()`, which would quietly erase whole request
 * bodies. A pointer already on the current expansion stack becomes `{}` so a
 * self-referential schema (a group inside a group) degrades to `z.any()`
 * instead of recursing forever.
 */
function makeResolver(spec: Json) {
	function pointer(ref: string): unknown {
		if (!ref.startsWith('#/')) fail(`external $ref survived bundling: ${ref}`)
		let node: any = spec
		for (const part of ref.slice(2).split('/')) {
			node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')]
			if (node === undefined) fail(`dangling $ref: ${ref}`)
		}
		return node
	}

	function deref(node: unknown, stack: Set<string> = new Set()): any {
		if (Array.isArray(node)) return node.map((entry) => deref(entry, stack))
		if (node === null || typeof node !== 'object') return node

		const ref = (node as Json).$ref
		if (typeof ref === 'string') {
			if (stack.has(ref)) return {}
			stack.add(ref)
			const resolved = deref(pointer(ref), stack)
			stack.delete(ref)
			const rest = { ...(node as Json) }
			delete rest.$ref
			return Object.keys(rest).length > 0 ? { ...resolved, ...deref(rest, stack) } : resolved
		}

		const out: Json = {}
		for (const [key, value] of Object.entries(node as Json)) out[key] = deref(value, stack)
		return out
	}

	return { deref }
}

// ---------------------------------------------------------------------------
// Schema emission
// ---------------------------------------------------------------------------

/** OpenAPI keywords `json-schema-to-zod` does not understand and would trip on. */
const NON_SCHEMA_KEYS = ['example', 'examples', 'xml', 'externalDocs', 'discriminator']

function cleanSchema(schema: Json): Json {
	const out: Json = {}
	for (const [key, value] of Object.entries(schema)) {
		if (NON_SCHEMA_KEYS.includes(key)) continue
		out[key] = value
	}
	return out
}

function toZod(schema: Json): string {
	return jsonSchemaToZod(cleanSchema(schema), {
		module: 'none',
		noImport: true,
		zodVersion: 4
	})
}

interface Field {
	name: string
	source: string
}

/**
 * Merges path, query and body properties into one flat object shape. Agents get
 * a single argument list; the handler splits it back apart using `op.params`.
 */
function buildFields(
	operationId: string,
	parameters: Json[],
	body: { schema: Json | null; required: boolean }
): {
	fields: Field[]
	params: { path: string[]; query: string[]; body: string[] | null }
	binaryFields: string[]
} {
	const fields: Field[] = []
	const seen = new Map<string, string>()
	const params = { path: [] as string[], query: [] as string[], body: null as string[] | null }
	const binaryFields: string[] = []

	const push = (name: string, origin: string, schema: Json, required: boolean) => {
		const previous = seen.get(name)
		if (previous !== undefined) {
			log(`  WARN  ${operationId}: ${origin} arg \`${name}\` shadowed by ${previous}`)
			return
		}
		seen.set(name, origin)

		// A `format: binary` field is a file. Advertising it as base64 would make
		// the agent inline the whole payload into the tool call; a path lets the
		// server, which runs on the same machine, read the bytes itself.
		if (origin === 'body' && schema.type === 'string' && schema.format === 'binary') {
			binaryFields.push(name)
			const detail = String(schema.description ?? '').trim()
			fields.push({
				name,
				source: `z.string().describe(${quote(
					`Path to a local file to upload.${detail ? ` ${detail}` : ''} Give an absolute path, or one relative to the server's working directory. Do not paste file contents.`
				)})${required ? '' : '.optional()'}`
			})
			return
		}

		const source = toZod(schema)
		// `.default()` already makes the input optional; stacking `.optional()`
		// on top would erase the default from the advertised schema.
		const suffix = required || source.includes('.default(') ? '' : '.optional()'
		fields.push({ name, source: `${source}${suffix}` })
	}

	// Path first: it wins every collision, since the URL cannot be built without it.
	const byLocation = (location: string) => parameters.filter((p) => p.in === location)

	for (const parameter of byLocation('path')) {
		params.path.push(parameter.name)
		push(parameter.name, 'path', describe(parameter), true)
	}

	if (body.schema) {
		const properties = (body.schema.properties ?? {}) as Json
		const names = Object.keys(properties)
		params.body = names
		const requiredBody = new Set<string>(
			Array.isArray(body.schema.required) ? body.schema.required : []
		)
		for (const name of names) {
			push(name, 'body', properties[name] as Json, body.required && requiredBody.has(name))
		}
	}

	for (const parameter of byLocation('query')) {
		params.query.push(parameter.name)
		push(parameter.name, 'query', describe(parameter), Boolean(parameter.required))
	}

	return { fields, params, binaryFields }
}

/** OpenAPI hangs the description off the parameter, not its schema. */
function describe(parameter: Json): Json {
	const schema: Json = { ...((parameter.schema ?? { type: 'string' }) as Json) }
	if (parameter.description && !schema.description) schema.description = parameter.description
	return schema
}

/** The `n`/`offset` pair is the whole of VRChat's pagination convention. */
function paginationSchema(parameter: Json): Json {
	const schema = describe(parameter)
	if (parameter.name !== 'n') return schema
	const max = typeof schema.maximum === 'number' ? schema.maximum : 100
	const base = String(parameter.description ?? 'The number of objects to return.').trim()
	return { ...schema, default: PAGE_SIZE, description: `${base} Max ${max}. One page per call.` }
}

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/** Top-level field names of the 200 body, so the tool description can list them. */
function responseKeys(operation: Json, deref: (node: unknown) => any): string[] {
	const ok = operation.responses?.['200'] ?? operation.responses?.['201']
	if (!ok) return []
	const schema = deref(ok).content?.['application/json']?.schema
	if (!schema) return []
	const target = schema.type === 'array' ? schema.items : schema
	const properties = target?.properties
	return properties ? Object.keys(properties).sort() : []
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

interface Emitted {
	operationId: string
	tag: string
	method: HttpMethod
	path: string
	summary: string
	description: string
	kind: OperationKind
	params: { path: string[]; query: string[]; body: string[] | null }
	paginated: boolean
	binaryFields: string[]
	responseKeys: string[]
	fields: Field[]
}

function quote(value: string): string {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
}

function list(values: string[]): string {
	return values.length === 0 ? '[]' : `[${values.map(quote).join(', ')}]`
}

function render(op: Emitted): string {
	const shape = op.fields.map((f) => `\t\t\t${quote(f.name)}: ${f.source}`).join(',\n')
	return [
		'\t{',
		`\t\toperationId: ${quote(op.operationId)},`,
		`\t\ttag: ${quote(op.tag)},`,
		`\t\tmethod: ${quote(op.method)},`,
		`\t\tpath: ${quote(op.path)},`,
		`\t\tsummary: ${quote(op.summary)},`,
		`\t\tdescription: ${quote(op.description)},`,
		`\t\tkind: ${quote(op.kind)},`,
		`\t\tparams: { path: ${list(op.params.path)}, query: ${list(op.params.query)}, body: ${
			op.params.body === null ? 'null' : list(op.params.body)
		} },`,
		`\t\tpaginated: ${op.paginated},`,
		`		binaryFields: ${list(op.binaryFields)},`,
		`\t\tresponseKeys: ${list(op.responseKeys)},`,
		shape ? `\t\tinputSchema: z.object({\n${shape}\n\t\t})` : '\t\tinputSchema: z.object({})',
		'\t}'
	].join('\n')
}

function emit(ops: Emitted[], version: SpecVersion): string {
	return [
		'/**',
		' * DO NOT EDIT BY HAND — generated by `scripts/generate-tools.ts`.',
		' *',
		` * Spec: ${REPO}@${version.sha}`,
		` * Bundle: ${version.contentHash}`,
		' *',
		' * Run `bun run generate` to refresh from upstream, or',
		' * `bun run generate --offline` to rebuild from the committed bundle.',
		' */',
		'',
		"import { z } from 'zod'",
		"import type { Operation } from '../types.ts'",
		'',
		'export const operations: Operation[] = [',
		ops.map(render).join(',\n'),
		']',
		'',
		'/** Lookup by spec operationId — the same string the tool name carries. */',
		'export const operationsById: Record<string, Operation> = Object.fromEntries(',
		'\toperations.map((operation) => [operation.operationId, operation])',
		')',
		''
	].join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function previousIds(): Promise<Set<string>> {
	try {
		const text = await readFile(OUT_PATH, 'utf8')
		return new Set([...text.matchAll(/operationId: '([^']+)'/g)].map((m) => m[1]!))
	} catch {
		return new Set()
	}
}

async function previousSha(): Promise<string> {
	try {
		return (JSON.parse(await readFile(VERSION_PATH, 'utf8')) as SpecVersion).sha
	} catch {
		return '(none)'
	}
}

/** Every method reachable on a constructed client, without constructing one. */
function sdkMethods(): Set<string> {
	const names = new Set<string>()
	let proto = VRChat.prototype as object | null
	while (proto && proto !== Object.prototype) {
		for (const name of Object.getOwnPropertyNames(proto)) names.add(name)
		proto = Object.getPrototypeOf(proto)
	}
	return names
}

async function main(): Promise<void> {
	const offline = process.argv.includes('--offline')
	const before = await previousIds()
	const beforeSha = await previousSha()

	const { spec, version } = offline ? await loadSpec() : await fetchSpec()
	const { deref } = makeResolver(spec)

	const ops: Emitted[] = []
	const problems: string[] = []

	for (const path of Object.keys(spec.paths ?? {}).sort()) {
		const item = spec.paths[path] as Json
		for (const method of HTTP_METHODS) {
			const operation = item[method] as Json | undefined
			if (!operation) continue

			const operationId = String(operation.operationId ?? '')
			// A blank or underscore-led id would render `vrchat__` or `vrchat___x`,
			// breaking the invariant that one underscore means hand-written.
			if (!/^[a-z][A-Za-z0-9]*$/.test(operationId)) {
				problems.push(`${method.toUpperCase()} ${path}: unusable operationId ${quote(operationId)}`)
				continue
			}

			const parameters = deref([...(item.parameters ?? []), ...(operation.parameters ?? [])]) as Json[]
			const names = new Set(parameters.map((p) => p.name))
			const paginated = names.has('n') && names.has('offset')

			const content = deref(operation.requestBody ?? null)?.content ?? {}
			const bodySchema = (content['application/json'] ?? content['multipart/form-data'])?.schema ?? null

			const { fields, params, binaryFields } = buildFields(
				operationId,
				parameters.map((p) => (paginated ? { ...p, schema: paginationSchema(p) } : p)),
				{ schema: bodySchema, required: Boolean(operation.requestBody?.required) }
			)

			if (fields.some((field) => field.name === PROJECTION_ARG)) {
				problems.push(`${operationId} declares a real \`${PROJECTION_ARG}\` parameter`)
			}

			ops.push({
				operationId,
				tag: String((operation.tags ?? ['untagged'])[0]).toLowerCase(),
				method,
				path,
				summary: String(operation.summary ?? operationId),
				description: String(operation.description ?? '').trim(),
				kind: classify(operationId, method, path),
				params,
				paginated,
				binaryFields,
				responseKeys: responseKeys(operation, deref),
				fields
			})
		}
	}

	if (problems.length > 0) fail(`codegen invariants violated:\n  - ${problems.join('\n  - ')}`)

	const duplicates = ops.map((o) => o.operationId).filter((id, i, all) => all.indexOf(id) !== i)
	if (duplicates.length > 0) fail(`duplicate operationIds: ${[...new Set(duplicates)].join(', ')}`)

	ops.sort((a, b) => a.tag.localeCompare(b.tag) || a.operationId.localeCompare(b.operationId))

	await mkdir(join(ROOT, 'src/generated'), { recursive: true })
	await writeFile(OUT_PATH, emit(ops, version))

	// --- summary ---------------------------------------------------------
	const after = new Set(ops.map((o) => o.operationId))
	const added = [...after].filter((id) => !before.has(id))
	const removed = [...before].filter((id) => !after.has(id))

	log('')
	log(`spec  ${beforeSha.slice(0, 8)} -> ${version.sha.slice(0, 8)}${offline ? ' (offline)' : ''}`)
	log(`ops   ${ops.length} total · +${added.length} · -${removed.length}`)
	if (added.length > 0) log(`      added:   ${added.join(', ')}`)
	if (removed.length > 0) log(`      removed: ${removed.join(', ')}`)

	const byTag = new Map<string, number>()
	const byKind = new Map<string, number>()
	for (const op of ops) {
		byTag.set(op.tag, (byTag.get(op.tag) ?? 0) + 1)
		byKind.set(op.kind, (byKind.get(op.kind) ?? 0) + 1)
	}
	log('')
	for (const [tag, count] of [...byTag].sort((a, b) => b[1] - a[1])) {
		log(`  ${tag.padEnd(18)}${String(count).padStart(4)}`)
	}
	log('')
	log(`  ${[...byKind].map(([k, c]) => `${k}=${c}`).join(' · ')}`)
	log(`  paginated=${ops.filter((o) => o.paginated).length}`)

	// Not a hard failure: an unmatched id is a gap to route through a raw-request
	// fallback later, not a reason to refuse to emit the table.
	const methods = sdkMethods()
	const unmatched = ops.filter((op) => !methods.has(op.operationId)).map((op) => op.operationId)
	if (unmatched.length > 0) {
		log('')
		log(`  !! ${unmatched.length} operationIds have NO matching vrchat SDK method:`)
		for (const id of unmatched) log(`     - ${id}`)
	}
	log('')
}

await main()
