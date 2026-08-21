/**
 * Shared contracts for vrchat-mcp.
 *
 * Every module in this project codes against these types. They are the seam
 * between the generated tool table, the registry, the VRChat client stack and
 * the event pipeline — do not change a shape here without updating callers.
 */

/**
 * Safety classification for a generated operation. Drives which env gate must
 * be set before the tool is registered (see `src/registry.ts`).
 */
export type OperationKind = 'read' | 'write' | 'destructive' | 'money' | 'admin'

/**
 * One VRChat API operation, emitted by `scripts/generate-tools.ts` into
 * `src/generated/operations.ts`. One entry becomes one MCP tool named
 * `vrchat__<operationId>` when it passes the registry's gates.
 */
export interface Operation {
	/** Spec operationId, verbatim. Also the SDK method name. */
	operationId: string
	/** First tag from the spec, lowercased (e.g. `economy`, `users`). */
	tag: string
	/**
	 * Every tag this operation answers to, `tag` included.
	 *
	 * Beyond the spec's own tags we add narrower synthetic ones, because some
	 * spec tags are too coarse to filter on usefully: `economy` covers running a
	 * storefront, reading balances, buying things and the payment processor all
	 * at once, so `VRCHAT_MCP_TAGS=economy` is close to no filter at all for a
	 * creator who only manages products. `VRCHAT_MCP_TAGS` matches any of these.
	 */
	tags: string[]
	method: 'get' | 'post' | 'put' | 'patch' | 'delete'
	/** Templated path, e.g. `/users/{userId}`. */
	path: string
	summary: string
	/** Longer prose from the spec, already trimmed. May be empty. */
	description: string
	kind: OperationKind
	/** Parameter names by location, so the handler can reassemble the request. */
	params: {
		path: string[]
		query: string[]
		/** Body property names, or `null` when the op takes no body. */
		body: string[] | null
	}
	/** True when the op accepts `n`/`offset` and the handler should echo `nextOffset`. */
	paginated: boolean
	/**
	 * Body fields the spec declares as `format: binary`.
	 *
	 * The agent supplies a local file path for each; the registry reads the file
	 * and swaps in a `File` before the SDK builds the multipart body. Inlining
	 * the bytes as base64 would put a whole PNG in the tool arguments, which
	 * costs more context than the rest of the call put together.
	 */
	binaryFields: string[]
	/** Top-level response field names from the spec, for the tool description. */
	responseKeys: string[]
	/** Zod schema for the merged path+query+body arguments (no `_responseKeys`). */
	inputSchema: import('zod').ZodType
}

/** Which two-factor method VRChat is asking for. */
export type TwoFactorMethod = 'emailOtp' | 'totp' | 'otp' | 'unknown'

/** A login parked waiting on a code from the user. */
export interface PendingTwoFactor {
	requestId: string
	method: TwoFactorMethod
	/** Epoch ms when this request stops being resolvable. */
	expiresAt: number
}

/** Snapshot of the rate limiter, surfaced through `vrchat_authStatus`. */
export interface LimiterStatus {
	rps: number
	/** Calls currently waiting for a token. */
	queueDepth: number
	/** True while paused by an upstream 429. */
	backingOff: boolean
	/** Epoch ms the backoff pause ends, or null when not backing off. */
	backoffUntil: number | null
}

/** A normalized pipeline event, after the double-encoding is undone. */
export interface VRChatEvent {
	/** Monotonic rowid from SQLite; the cursor agents poll with. */
	cursor: number
	receivedAt: number
	type: string
	/** Extracted from the payload when present, for cheap filtering. */
	userId: string | null
	/** Fully decoded content — never a JSON string. */
	content: unknown
}

/** Structured error detail carried in every `isError` tool result. */
export interface ToolErrorDetail {
	/** HTTP status, or null for local failures (timeouts, config errors). */
	status: number | null
	/** VRChat's own message, or ours for local failures. */
	message: string
	/** What the agent should do about it. */
	hint: string
}
