/**
 * VRChat pipeline websocket: ingest, normalization, waiters.
 *
 * Nothing here runs at import time — the socket only opens when
 * `VRCHAT_MCP_WEBSOCKET=1` and something calls `startEventPipeline`.
 *
 * We drive the socket ourselves rather than consuming `vrchat.pipeline`'s
 * events, for three reasons the SDK cannot give us:
 *  1. `VRChatWebsocket` calls `JSON.parse` on `content` unconditionally, so
 *     `see-notification` / `hide-notification` (which carry a bare id, not JSON)
 *     throw inside its handler and are dropped silently.
 *  2. It emits per type on a plain EventEmitter, so there is no way to observe
 *     types you did not enumerate — and no way to see the raw frame.
 *  3. It builds its `ws` options inline with no agent/proxy seam, which would
 *     leak the real IP on the event stream while the REST side looks proxied.
 */

import { config } from '../config.ts'
import type { VRChatEvent } from '../types.ts'
import { EventHistory, type EventInput } from './history.ts'

const PIPELINE_URL = 'wss://pipeline.vrchat.cloud/'

/** Events kept in RAM to serve `_wait` and short polls without touching disk. */
const TAIL_SIZE = 256

const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 60_000

/** Events buffered before a flush; a `friend-location` burst writes as one txn. */
const FLUSH_SIZE = 64
const FLUSH_INTERVAL_MS = 250

export type ConnectionState = 'disabled' | 'disconnected' | 'connecting' | 'connected'

/**
 * The slice of the VRChat SDK client this module needs. Kept structural so
 * `client.ts` owns the client and this module owns the socket.
 */
export interface EventClientLike {
	authenticate(): Promise<unknown>
	pipeline: {
		authenticate(authToken: string): Promise<void> | void
		close(): void
	}
}

/** A pipeline frame after the double-encoding is undone. */
export interface NormalizedMessage {
	type: string
	content: unknown
	userId: string | null
}

/**
 * Undoes VRChat's double encoding exactly once, at ingest.
 *
 * Most frames are `{"type":"friend-online","content":"{\"userId\":\"usr_…\"}"}`
 * — `content` is stringified JSON needing a second parse. `see-notification` and
 * `hide-notification` instead carry a bare notification id, which is not valid
 * JSON; those must survive as the plain string rather than being thrown away.
 * After this function no consumer ever sees a JSON string inside JSON.
 */
export function normalizeMessage(raw: string): NormalizedMessage | null {
	let frame: unknown
	try {
		frame = JSON.parse(raw)
	} catch {
		return null
	}
	if (typeof frame !== 'object' || frame === null) return null

	const { type, content } = frame as { type?: unknown; content?: unknown }
	if (typeof type !== 'string' || type.length === 0) return null

	let decoded: unknown = content ?? null
	if (typeof content === 'string') {
		try {
			decoded = JSON.parse(content)
		} catch {
			// Bare-id payload (`see-notification`), not malformed JSON.
			decoded = content
		}
	}

	return { type, content: decoded, userId: extractUserId(decoded) }
}

/** Pulls the subject user id out of a decoded payload for the indexed column. */
export function extractUserId(content: unknown): string | null {
	if (typeof content !== 'object' || content === null) return null
	const record = content as Record<string, unknown>

	const direct = record.userId ?? record.senderUserId ?? record.receiverUserId
	if (typeof direct === 'string') return direct

	const user = record.user
	if (typeof user === 'object' && user !== null) {
		const id = (user as Record<string, unknown>).id
		if (typeof id === 'string') return id
	}

	// `id` is only a user id when it is shaped like one; a notification's `id` is not.
	const id = record.id
	if (typeof id === 'string' && id.startsWith('usr_')) return id

	return null
}

interface Waiter {
	types: Set<string> | null
	resolve: (events: VRChatEvent[]) => void
	timer: ReturnType<typeof setTimeout>
}

export class EventPipeline {
	readonly history: EventHistory
	readonly subscribed: string[]

	private state: ConnectionState = config.websocket ? 'disconnected' : 'disabled'
	private socket: WebSocket | null = null
	private client: EventClientLike | null = null
	private authToken: string | null = null
	private attempts = 0
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private flushTimer: ReturnType<typeof setTimeout> | null = null
	private stopped = false
	private lastError: string | null = null

	private readonly pending: EventInput[] = []
	private readonly tail: VRChatEvent[] = []
	private readonly waiters = new Set<Waiter>()

	constructor(history: EventHistory = new EventHistory()) {
		this.history = history
		this.subscribed = config.wsEvents
	}

	get connectionState(): ConnectionState {
		return this.state
	}

	/**
	 * Takes over the SDK's pipeline: every `authenticate()` hands us the fresh
	 * cookie instead of opening the SDK's own (unproxied, session-slot-burning)
	 * socket. The patch is permanent by design — the SDK re-authenticates from its
	 * 401 interceptor, and a restored method would silently open a direct socket.
	 */
	async start(client: EventClientLike): Promise<void> {
		if (!config.websocket) return
		this.stopped = false
		this.client = client

		client.pipeline.close()
		client.pipeline.authenticate = (authToken: string) => {
			this.onAuthToken(authToken)
			return Promise.resolve()
		}

		try {
			await client.authenticate()
		} catch (reason) {
			this.lastError = describe(reason)
			console.error('[events] initial authentication failed:', this.lastError)
			this.scheduleReconnect()
		}
	}

	private onAuthToken(authToken: string): void {
		const changed = authToken !== this.authToken
		this.authToken = authToken
		if (this.stopped) return
		// A re-auth mid-session means the old cookie is dead; reconnect on the new one.
		if (changed || this.state === 'disconnected') this.connect()
	}

	private connect(): void {
		if (this.stopped || !this.authToken) return
		if (this.state === 'connecting' || this.state === 'connected') this.closeSocket()

		const url = new URL(PIPELINE_URL)
		url.searchParams.set('authToken', this.authToken)
		this.state = 'connecting'

		let socket: WebSocket
		try {
			socket = new WebSocket(url, {
				headers: { 'User-Agent': userAgent() },
				// Bun's WebSocket takes `proxy` directly; the SDK's `fetch` override
				// does not cover this connection.
				...(config.proxy ? { proxy: config.proxy } : {})
			})
		} catch (reason) {
			this.lastError = config.proxy ? 'pipeline proxy unreachable' : describe(reason)
			console.error('[events] websocket construction failed:', this.lastError)
			this.state = 'disconnected'
			this.scheduleReconnect()
			return
		}

		this.socket = socket
		socket.addEventListener('open', () => {
			this.state = 'connected'
			this.attempts = 0
			this.lastError = null
			console.error(`[events] pipeline connected (${this.subscribed.length} types subscribed)`)
		})
		socket.addEventListener('message', (event) => {
			this.ingest(typeof event.data === 'string' ? event.data : String(event.data))
		})
		socket.addEventListener('error', () => {
			// The close handler owns reconnection; `error` only carries the reason.
			this.lastError = config.proxy ? 'pipeline socket error (proxy configured)' : 'pipeline socket error'
		})
		socket.addEventListener('close', (event) => {
			this.state = 'disconnected'
			this.socket = null
			if (this.stopped) return
			// 1006/4xxx after an expired cookie: ask the SDK for a fresh one, which
			// comes back through the patched `pipeline.authenticate`.
			if (event.code === 1008 || event.code === 4001) void this.reauthenticate()
			else this.scheduleReconnect()
		})
	}

	private async reauthenticate(): Promise<void> {
		if (!this.client) return this.scheduleReconnect()
		try {
			await this.client.authenticate()
		} catch (reason) {
			this.lastError = describe(reason)
			this.scheduleReconnect()
		}
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer) return
		const delay = Math.min(BACKOFF_MIN_MS * 2 ** this.attempts, BACKOFF_MAX_MS)
		this.attempts += 1
		// Jitter so a dropped VRChat edge does not get every client back at once.
		const jittered = delay * (0.5 + Math.random() * 0.5)
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			if (this.authToken) this.connect()
			else void this.reauthenticate()
		}, jittered)
	}

	/** Public for tests and for replaying a frame captured elsewhere. */
	ingest(raw: string): VRChatEvent | null {
		const message = normalizeMessage(raw)
		if (!message) return null
		return this.record(message)
	}

	private record(message: NormalizedMessage): VRChatEvent | null {
		// Filtering at ingest, not at query time: an unsubscribed type must never
		// consume a retention slot or disk.
		if (!this.subscribed.includes(message.type)) return null

		const input: EventInput = {
			receivedAt: Date.now(),
			type: message.type,
			userId: message.userId,
			content: message.content
		}

		// The cursor is only known after the row lands, and waiters/tail need one,
		// so a matched waiter forces an immediate flush instead of waiting.
		this.pending.push(input)
		const urgent = this.pending.length >= FLUSH_SIZE || this.hasWaiterFor(message.type)
		if (urgent) {
			const flushed = this.flush()
			return flushed.find((event) => event.type === message.type) ?? null
		}
		this.scheduleFlush()
		return null
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null
			this.flush()
		}, FLUSH_INTERVAL_MS)
	}

	flush(): VRChatEvent[] {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer)
			this.flushTimer = null
		}
		if (this.pending.length === 0) return []

		const batch = this.pending.splice(0, this.pending.length)
		let stored: VRChatEvent[]
		try {
			stored = this.history.insertMany(batch)
		} catch (reason) {
			console.error('[events] failed to persist batch:', describe(reason))
			return []
		}

		for (const event of stored) {
			this.tail.push(event)
			this.notify(event)
		}
		if (this.tail.length > TAIL_SIZE) this.tail.splice(0, this.tail.length - TAIL_SIZE)
		return stored
	}

	private hasWaiterFor(type: string): boolean {
		for (const waiter of this.waiters) {
			if (!waiter.types || waiter.types.has(type)) return true
		}
		return false
	}

	private notify(event: VRChatEvent): void {
		for (const waiter of [...this.waiters]) {
			if (waiter.types && !waiter.types.has(event.type)) continue
			this.waiters.delete(waiter)
			clearTimeout(waiter.timer)
			waiter.resolve([event])
		}
	}

	/** Resolves with the first matching event, or empty at timeout — not an error. */
	wait(types: string[] | undefined, timeoutMs: number): Promise<VRChatEvent[]> {
		return new Promise((resolve) => {
			const waiter: Waiter = {
				types: types && types.length > 0 ? new Set(types) : null,
				resolve,
				timer: setTimeout(() => {
					this.waiters.delete(waiter)
					resolve([])
				}, timeoutMs)
			}
			this.waiters.add(waiter)
		})
	}

	/** Most recent events still in RAM, newest last. */
	recentTail(types?: string[], limit = 50): VRChatEvent[] {
		const filtered =
			types && types.length > 0 ? this.tail.filter((event) => types.includes(event.type)) : this.tail
		return filtered.slice(-limit)
	}

	status() {
		return {
			state: this.state,
			enabled: config.websocket,
			proxied: Boolean(config.proxy),
			subscribedTypes: this.subscribed,
			lastError: this.lastError,
			latestCursor: this.history.latestCursor(),
			search: this.history.fts ? ('fts5' as const) : ('like' as const),
			types: this.history.stats()
		}
	}

	private closeSocket(): void {
		const socket = this.socket
		this.socket = null
		try {
			socket?.close()
		} catch {
			// Already closing; nothing useful to do about it.
		}
	}

	stop(): void {
		this.stopped = true
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		this.reconnectTimer = null
		this.flush()
		this.closeSocket()
		for (const waiter of [...this.waiters]) {
			clearTimeout(waiter.timer)
			this.waiters.delete(waiter)
			waiter.resolve([])
		}
		this.state = config.websocket ? 'disconnected' : 'disabled'
	}
}

let pipeline: EventPipeline | null = null

/** Lazily created so importing this module never opens a DB or a socket. */
export function getEventPipeline(): EventPipeline {
	pipeline ??= new EventPipeline()
	return pipeline
}

/** Wired from the server entry point once the SDK client exists. */
export async function startEventPipeline(client: EventClientLike): Promise<void> {
	if (!config.websocket) return
	await getEventPipeline().start(client)
}

export function stopEventPipeline(): void {
	pipeline?.stop()
}

function userAgent(): string {
	const contact = config.contact ? ` ${config.contact}` : ''
	return `${config.appName}/${config.appVersion}${contact}`
}

function describe(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason)
}
