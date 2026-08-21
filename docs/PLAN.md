# VRChat MCP Server — Full API Coverage (incl. Creator Economy)

## Context

`vrchat-mcp` is currently a bare `bun init` scaffold: `package.json` (no deps beyond
`@types/bun`), `src/index.ts`, `tsconfig.json`, stock Bun README. Nothing MCP-related exists.

The goal is an MCP server exposing **the entire VRChat API surface** — ~250 operations across
18 tags — with first-class coverage of the creator-economy stack (Economy 41 ops, Inventory 15,
Props 8, Prints 5). Hand-writing 250 tools is not viable and would rot against a
community-maintained spec that moves, so **tools are generated from the VRChat OpenAPI
specification at build time** and committed.

Decisions locked in with the user:

- **Transport:** local **stdio only**. Runs as a subprocess of Claude Code / Claude Desktop.
  No HTTP endpoint, no OAuth resource server; credentials stay in local env.
- **Stack:** **Bun + official MCP TypeScript SDK v2**.
- **Tool shape:** 1:1 generated tool per operation, filterable by tag via `VRCHAT_MCP_TAGS`.
- **Write safety:** read-only by default; writes and money-moving ops behind explicit env flags.
- **2FA:** support both TOTP (unattended, via `totpSecret`) and **email OTP**, where the server
  pauses the in-flight call, asks the user for the emailed code, and a second tool supplies it.
- **WebSocket:** opt-in, event-filtered, surfaced through poll/wait tools, with a searchable
  local SQLite history retaining the last 1000 events **per event type**.
- **Rate limiting:** token bucket at **20 req/s**, plus whole-bucket pause on upstream 429.
- **Spec:** codegen fetches the latest upstream spec on each `generate` run.
- **Tool naming:** camelCase throughout. Generated tools take a **double** underscore
  (`vrchat__getBalance`), hand-written ones a **single** one (`vrchat_authStatus`) — the
  separator itself says whether a tool came from the spec.
- **Pagination:** one page per call, next offset echoed back; no hidden multi-request loops.
- **Responses:** always raw upstream, projected by an agent-supplied `response_keys` with
  wildcard support. `["*"]` (the default) means the untouched payload. No server-side curation.
- **Admin ops:** excluded unless `VRCHAT_MCP_ALLOW_ADMIN=1`.
- **Login:** lazy, on first API call — never at startup.
- **Errors:** `isError` results carrying status, message, and an actionable hint.
- **Data files:** project-local `.vrchat-mcp/`, gitignored.
- **Proxy:** optional HTTP/SOCKS proxy for all API and WebSocket traffic, from `.env`.
- **Testing:** offline unit tests plus **live integration tests** against a real account.

## Toolchain decisions (and why)

| Concern | Choice | Notes |
|---|---|---|
| Protocol SDK | `@modelcontextprotocol/server@^2` | v2.0.0 stable 2026-07-27, implements the stateless `2026-07-28` spec. ESM-only, Node 20+ (Bun qualifies). The v1 `@modelcontextprotocol/sdk` (1.30.0) is the legacy path. |
| Schemas | `zod@^4` | v2 accepts any Standard Schema validator; Zod v4 is what the official docs use. |
| VRChat API | `vrchat@^2.22` (official `vrchatapi-javascript`) | Handles the mandatory descriptive User-Agent via its `application` block, TOTP 2FA via `totpSecret`, and session persistence via Keyv. CJS with `.mjs` export conditions — fine under Bun. |
| Session store | `keyv-file` | Persists the auth cookie so relaunches skip login. |
| Event history | `bun:sqlite` (built in) | Durable, searchable store for WebSocket events. No dependency, no native build step — the main reason to stay on Bun rather than `better-sqlite3` on Node. |
| Spec source | `vrchatapi/specification` → `redocly bundle` | Bundle `openapi/openapi.yaml` (it `$ref`s `openapi/components/`) into one JSON for codegen. |
| Schema conversion | `json-schema-to-zod` (build-time) | Emits Zod v4 source from each operation's OpenAPI parameter/body schemas. |
| Debugging | `@modelcontextprotocol/inspector` via `npx` | Web UI + TUI + scriptable CLI from one binary. |
| Runtime/tests | Bun (`bun run`, `bun test`) | No extra test runner. |
| Distribution | `bun run` / npm bin — **not** `bun build --compile` | Compiling the MCP SDK to a single binary has known module-resolution breakage. |

Explicitly **not** used: FastMCP (still on the legacy `2025-11-25` revision), `mcp-framework`,
`xmcp`. For a stdio server the official SDK is minimal boilerplate, and a framework only adds
spec-lag risk.

## Architecture

```
scripts/generate-tools.ts     # build-time: spec -> src/generated/operations.ts
spec/openapi.bundled.json     # COMMITTED snapshot of upstream main
spec/VERSION.json             # upstream SHA + fetch timestamp + content hash
src/generated/operations.ts   # COMMITTED, DO NOT EDIT BY HAND (~250 entries)
src/vrchat/client.ts          # memoized authed VRChat SDK client
src/vrchat/twofactor.ts       # pending-code broker (email OTP + TOTP)
src/vrchat/ratelimit.ts       # 20 req/s token bucket + 429 backoff
src/vrchat/events.ts          # websocket client + waiter registry
src/vrchat/history.ts         # bun:sqlite event store, 1000-event retention + search
src/tools/auth.ts             # hand-written vrchat_submitTwoFactorCode / vrchat_authStatus
src/tools/events.ts           # vrchat_eventsRecent / _eventsWait / _eventsSearch / _eventsStatus
src/registry.ts               # filtering + registration of generated ops as MCP tools
src/project.ts                # response_keys path projection (wildcards, discovery)
src/index.ts                  # serveStdio entry point
```

### 0. Project docs

Copy this plan to `docs/PLAN.md` in the repo (so it travels with the code rather than living
in a session directory) and create `PROGRESS.md` at the root as the running status log —
checklist of the steps below, what's done, what's blocked, and any decision made during
implementation that diverges from this plan. Update `PROGRESS.md` as each step lands.

### 1. Dependencies

```
bun add @modelcontextprotocol/server zod vrchat keyv-file
bun add -d @types/bun @redocly/cli json-schema-to-zod
```

Keep `"type": "module"`. Add scripts: `generate` (codegen), `start`
(`bun run src/index.ts`), `inspect` (`npx @modelcontextprotocol/inspector bun run src/index.ts`).

Create `.vrchat-mcp/` for runtime data (session + events DB) and **gitignore it immediately** —
the session file is an auth credential. Do this before the first login, not after.

### 2. `scripts/generate-tools.ts` — the codegen

Fetches the **latest** upstream spec on every run: download `vrchatapi/specification` at `main`
and `redocly bundle openapi/openapi.yaml` into a single JSON (the root file `$ref`s
`openapi/components/`).

**Store what was fetched.** Write the bundled spec to `spec/openapi.bundled.json` and
**commit it**, alongside a `spec/VERSION.json` recording the upstream commit SHA, fetch
timestamp, and a content hash. That single move solves the drift problem:

- Every `generate` produces two reviewable diffs — the spec itself and the tools derived from
  it. A surprising tool change can be traced to the exact upstream edit that caused it.
- `bun run generate --offline` regenerates from the stored bundle with no network, so builds
  are reproducible and CI never depends on upstream being up or sane.
- A bad upstream commit is reverted with `git revert`, not by waiting for someone to fix
  `main`.
- Mirror the SHA into a header comment of `src/generated/operations.ts` so a generated file
  always names the spec version it came from.

Print a summary on each run — operations added, removed, changed, and the SHA moved from/to —
so drift is stated, not just diffable. Treat a run that rewrites hundreds of tools as a signal
to inspect upstream before committing.

Then, for **every** operation, emit an entry:

```ts
{ operationId, tag, method, path, summary,
  inputSchema,                    // zod object merging path + query + body params
  kind: 'read' | 'write' | 'destructive' | 'money' }
```

Classification rules:
- `read` — GET.
- `write` — POST/PUT/PATCH.
- `destructive` — DELETE, plus an explicit override list (`deleteUser`, `banGroupMember`,
  `kickGroupMember`, `moderateUser`, `deleteProduct`, `deleteProductListing`,
  `deleteAllUserPersistence`, `closeInstance`, …).
- `money` — explicit list: `purchaseProductListing`, `getEconomyPayouts`,
  `updateTiliaTosAgreementStatus`, `createProduct`, `createProductListing`,
  `updateProduct`, `updateProductListing`, plus anything under Tilia/KYC/payout paths.
- `admin` — admin-only and account-lifecycle ops: `getAdminAssetBundle`,
  `updateAssetReviewNotes`, `deleteUser`, `registerUserAccount`, `confirmEmail`,
  `resendEmailConfirmation`, moderation-report and global-avatar-moderation ops, plus
  `getCss` / `getJavaScript`. Kept in the generated file (so coverage stays 1:1 and the
  denylist is auditable) but registered only under `VRCHAT_MCP_ALLOW_ADMIN=1`. Most of these
  403 for a normal account anyway; `deleteUser` is the one that must never be an accident.

**Pagination:** where an operation takes `n`/`offset`, give `n` a conservative default (25)
and a documented max. Handlers return the page plus the `nextOffset` to continue with —
never loop internally. A hidden auto-paginate would burn the 20 req/s budget and a large
slice of context inside what looks to the agent like one call.

Flatten path params (`{userId}`) into the input schema and reassemble at call time.
Output is committed so runtime never touches the network to boot, and spec drift shows up
as a reviewable diff.

**Verify before building on it:** confirm the SDK exposes each spec `operationId` as a
camelCase method (`vrchat.getCurrentUser`, `vrchat.searchWorlds`, `vrchat.createInstance`
all match). Codegen should assert coverage and report any operationId with no matching
method, so gaps route to a raw-request fallback instead of failing silently.

### 3. `src/vrchat/client.ts`

Lazily-initialized, memoized SDK client:

```ts
new VRChat({
  application: { name: 'vrchat-mcp', version, contact: process.env.VRCHAT_CONTACT },
  authentication: { credentials: { username, password, totpSecret } },
  keyv: new KeyvFile({ filename: '.vrchat-mcp/session.json' }),
})
```

**Login is lazy** — nothing authenticates at startup. The server boots instantly, `tools/list`
works with no credentials at all, and login (with any 2FA prompt) happens on the first tool
call that needs it. This matters for stdio, which respawns on every client start: an eager
login would fire on each launch, and a 2FA prompt at boot has no tool call to attach itself to.

Env: `VRCHAT_USERNAME`, `VRCHAT_PASSWORD`, `VRCHAT_TOTP_SECRET` (optional), `VRCHAT_CONTACT`.
Missing username/password is reported as a clear tool error on first use (not a startup
crash), so the server stays inspectable without credentials. A descriptive contact in the
User-Agent is mandatory — VRChat 403s generic agents.

`totpSecret` is set only when `VRCHAT_TOTP_SECRET` is present. `twoFactorCode` is **always**
wired to the broker below, so an account on email OTP (or on TOTP with no stored secret)
still works.

**Proxy support.** The VRChat SDK config accepts a **fetch override**, which is the clean
insertion point: when `VRCHAT_MCP_PROXY` is set (`http://`, `https://`, `socks5://`, with
optional `user:pass@`), wrap `fetch` so every API request goes through it.

```ts
const proxy = process.env.VRCHAT_MCP_PROXY
new VRChat({
  /* … */
  fetch: proxy ? (url, init) => fetch(url, { ...init, proxy }) : undefined,
})
```

- Bun's native `fetch` takes a `proxy` option directly — no `undici`/agent plumbing for
  HTTP(S). **Verify Bun's SOCKS support in the installed version**; if `socks5://` isn't
  handled natively, fall back to `socks-proxy-agent` behind the same env var, so the
  configuration surface doesn't change either way.
- **The WebSocket needs proxying separately** — a `fetch` override does not cover it. Pass an
  agent to the `ws` client so pipeline traffic uses the same proxy. Easy to miss, and the
  failure mode is a server that looks proxied while leaking its real IP on the event stream.
- On proxy connection failure, fail with a clear "proxy unreachable" error rather than
  silently falling back to a direct connection — for anyone using this for IP separation, a
  silent fallback is the worst outcome.
- Never log the proxy URL: it may embed credentials.

### 4. `src/vrchat/twofactor.ts` — the pending-code broker

The SDK's `authentication.credentials.twoFactorCode` accepts an **async function returning a
Promise**. That is the hook: instead of resolving from a secret, it parks on a deferred that
a second MCP tool resolves.

```ts
twoFactorCode: async (method) => brokerRequestCode(method)   // 'emailOtp' | 'totp'
```

`brokerRequestCode`:
1. Creates a deferred, stores it as the single `pending` request with the 2FA method, a
   `requestId`, and a timeout (default 5 min → reject with a re-try-me message).
2. Returns that promise. Login stays parked; **no code is ever guessed or fabricated.**
3. `submitCode(requestId, code)` resolves it; login continues and the Keyv session persists,
   so this happens at most once per machine until the session expires.

*Confirm during implementation:* whether the SDK passes the 2FA method into the
`twoFactorCode` callback. VRChat's login response reports `requiresTwoFactorAuth`
(`["emailOtp"]` vs `["totp","otp"]`); if the callback doesn't surface it, read it from the
login response or the SDK's auth events, since the prompt text must tell the user whether to
check their **email** or their **authenticator app**. Falling back to a vague "enter your 2FA
code" is the acceptable last resort.

**Single-flight lock.** Every generated tool goes through `getClient()`, so a burst of
concurrent calls during an unauthenticated cold start must not trigger N logins or N
competing prompts. Guard login with one in-flight promise; callers 2..N await the same one.

**How the user is asked** — two paths, both implemented:

- *Baseline (works on every client):* the in-flight tool call returns a non-fatal result
  telling the agent auth is blocked, which 2FA method is in play, and to ask the user for
  the code then call `vrchat_submitTwoFactorCode`. This is the path the user specified, and it
  is the fallback whenever MRTR is unavailable.
  ```
  vrchat__getBalance  -> "Login paused: VRChat emailed a 6-digit code to your address.
                         Ask the user for it, then call vrchat_submitTwoFactorCode
                         { requestId: 'a1b2', code: '123456' }, then retry this call."
  ```
- *Preferred (spec `2026-07-28`):* return an `InputRequiredResult`
  (`resultType: "input_required"`) carrying an elicitation for the code plus `requestState`.
  The client collects it and re-issues the original call with `inputResponses` — the user
  gets a proper input box and **the original tool call completes on its own**, no manual
  retry. Detect support via the negotiated protocol revision and fall back to the baseline
  otherwise.

### 5. `src/tools/auth.ts` — hand-written auth tools

Registered unconditionally, ignoring the tag and write gates (they are not VRChat API
operations and are useless to gate):

- `vrchat_submitTwoFactorCode({ requestId, code })` — resolves the broker deferred. Returns
  whether login then succeeded, and on success names the tool the agent should retry.
  Rejects an unknown/expired `requestId` with a clear message rather than hanging.
- `vrchat_authStatus()` — reports authenticated / awaiting-code (with method) / not
  configured, plus which env gates are active. This is the first thing to call when
  anything behaves oddly.
- `vrchat_logout()` — clears the Keyv session, for re-auth without deleting files by hand.

Never log the code, the password, or the TOTP secret — including to stderr.

### 6. `src/vrchat/ratelimit.ts` — 20 req/s token bucket + 429 backoff

Every outbound VRChat request — generated tools **and** the auth flow — passes through one
shared limiter. An agent can fan 250 tools out fast enough to get the account throttled or
flagged, so this is not optional.

- Token bucket, capacity/refill tuned to **20 req/s** sustained, configurable via
  `VRCHAT_MCP_RPS` (default 20) for tightening if VRChat complains.
- Over-budget calls **queue and wait** transparently, with a per-call max wait (default 30s)
  after which the tool returns a clear "rate limited locally, retry" result rather than hanging.
- On an upstream **429**, pause the entire bucket for `Retry-After` (fall back to exponential
  backoff when the header is absent), then resume. One 429 must not become a stampede of
  concurrent retries — the pause is global, not per-call.
- Emit limiter state through `vrchat_authStatus` (queue depth, whether backing off) so a
  slow-feeling session is diagnosable.

### 7. `src/vrchat/events.ts` + `src/tools/events.ts` — WebSocket

**Opt-in and filtered.** `VRCHAT_MCP_WEBSOCKET=1` enables the socket at all;
`VRCHAT_MCP_WS_EVENTS` (comma-separated) selects event types, defaulting to a low-noise set
(`notification`, `notification-v2`, `economy-update`, `friend-online`, `friend-offline`,
`instance-queue-ready`). Off by default — an idle always-on socket burns a session slot, and
`friend-location` / `friend-update` will otherwise drown the buffer.

Connect via the SDK's `vrchat/websocket` export, reusing the authenticated session (the
pipeline endpoint takes the auth cookie and the same descriptive User-Agent). Reconnect with
exponential backoff; re-auth through the normal client on cookie expiry.

**Gotcha:** most pipeline messages are **double-encoded** — the `content` field is stringified
JSON needing a second parse (`see-notification` / `hide-notification` carry bare IDs instead).
Normalize this once at ingest so tools never hand the agent a JSON string inside JSON.

**History store (`src/vrchat/history.ts`).** Events are high-volume, so an in-memory buffer
is the wrong home for anything the agent might want to look back at. Persist to local SQLite
via **`bun:sqlite`** — built into Bun, so zero added dependency and no native build step.

```sql
CREATE TABLE events (
  cursor      INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,          -- epoch ms
  type        TEXT    NOT NULL,
  user_id     TEXT,                      -- extracted when present, for cheap filtering
  content     TEXT    NOT NULL           -- decoded JSON
);
CREATE INDEX idx_events_type_cursor ON events(type, cursor DESC);  -- serves per-type trim + filter
CREATE INDEX idx_events_received ON events(received_at);
```

- File lives beside the session: `.vrchat-mcp/events.db`, WAL mode, path overridable with
  `VRCHAT_MCP_DB`. Gitignored along with the rest of `.vrchat-mcp/`.
- **Retention: 1000 events per event type**, not 1000 total. Each type keeps its own window,
  so a chatty type (`friend-location`) can never evict a rare, valuable one
  (`economy-update`) — which a single global cap would do within minutes.
  ```sql
  DELETE FROM events
   WHERE type = ?1
     AND cursor <= (SELECT cursor FROM events WHERE type = ?1
                     ORDER BY cursor DESC LIMIT 1 OFFSET ?2)
  ```
  `idx_events_type_cursor` makes this an index scan. Run it per type on a threshold (e.g.
  every 100 inserts of that type, or when its count exceeds cap + slack) rather than on
  every row, to keep the hot path cheap.
- Cap is `VRCHAT_MCP_HISTORY` (default 1000, applies to every type), with optional per-type
  overrides — `VRCHAT_MCP_HISTORY=1000,friend-location:200,economy-update:5000` — so noisy
  and precious types can be tuned independently.
- **Age ceiling alongside the count cap.** `VRCHAT_MCP_HISTORY_MAX_AGE` (default 30d, accepts
  `7d` / `12h` / `0` to disable) drops anything older regardless of count, with the same
  per-type override syntax. Count alone lets a rarely-fired type sit on months-old events that
  read as current; age alone lets a burst blow up the DB. Whichever limit bites first wins:
  ```sql
  DELETE FROM events WHERE type = ?1 AND (cursor <= :cutoffCursor OR received_at < :minTime)
  ```
  `received_at` is already indexed. Run the age sweep on the same threshold as the count trim,
  plus once at startup so a long gap between sessions is cleaned before the first query.
- Total rows are therefore bounded by `types × cap` and by the age window. With the default
  event set that's a few thousand rows: trivial for SQLite, but worth stating so the DB size
  isn't a surprise.
- Writes are batched/transactional — high-frequency bursts like `friend-location` must not
  mean one fsync per event.
- Free-text search over `content` via an **FTS5** virtual table kept in sync by triggers,
  falling back to indexed `LIKE` if FTS5 turns out unavailable in the Bun build. Verify this
  early; it decides the search implementation.
- History survives restarts, so `vrchat_eventsSearch` can answer "what happened while I was
  away" — a live-only buffer cannot.

A small in-memory tail of recent events stays in `events.ts` purely to serve `_wait` and
cursor polling without touching disk; SQLite is the durable record.

Tools (registered only when the socket is enabled):
- `vrchat_eventsRecent({ types?, since?, limit? })` — events after a cursor, newest cursor
  returned so the agent can poll incrementally without re-reading.
- `vrchat_eventsWait({ types?, timeoutMs? })` — resolves on the first matching event or
  returns empty at timeout. Cap `timeoutMs` (default 30s, max 120s) so a call can't outlive
  the client's own request timeout.
- `vrchat_eventsSearch({ query?, types?, userId?, since?, until?, limit? })` — the history
  query surface. `query` is free-text over decoded content; the rest are indexed filters.
  Default `limit` 50, hard cap ~200, newest-first, with a total match count so the agent
  knows when it's seeing a slice.
- `vrchat_eventsStatus()` — connected / disconnected / disabled, subscribed types, and a
  **per-type** breakdown: stored count, effective count cap and age ceiling, oldest retained
  timestamp, rows dropped, and **which limit is currently binding** (count or age). Per-type is
  what makes the window legible — "I have 1000 `friend-location` back to 20 minutes ago, but
  `economy-update` back to last week." Silent trimming otherwise reads as "nothing happened."

Event tools take `response_keys` like any other tool, projecting the decoded payload.

Because retention is per-type, the high-frequency types (`friend-location`, `friend-update`)
are safe to subscribe to — they churn only their own window and cannot starve anything else.

### 8. `src/registry.ts` — filtering + registration

Register a generated op only if it passes every gate:

- **Tag gate:** `VRCHAT_MCP_TAGS` (comma-separated, e.g. `economy,inventory,users`).
  Unset = all tags.
- **Write gate:** `read` always registers. `write`/`destructive` require
  `VRCHAT_MCP_ALLOW_WRITES=1`. `money` additionally requires `VRCHAT_MCP_ALLOW_PURCHASES=1`.
- **Admin gate:** `admin` requires `VRCHAT_MCP_ALLOW_ADMIN=1`, independent of the write gate.

**Tool names: `vrchat__<operationId>`** — double underscore, operationId verbatim:
`vrchat__getBalance`, `vrchat__createProductListing`, `vrchat__getUserTiliaKyc`. No case
transform, so a tool name is directly searchable in the VRChat docs and codegen can't
manufacture collisions from a lossy rename.

Hand-written tools use a **single** underscore and the same camelCase:
`vrchat_authStatus`, `vrchat_submitTwoFactorCode`, `vrchat_logout`, `vrchat_eventsRecent`,
`vrchat_eventsWait`, `vrchat_eventsSearch`, `vrchat_eventsStatus`. The separator carries the
meaning — one underscore is server-provided, two is straight from the spec — so provenance is
visible at a glance without a naming table, and the generated namespace can never collide with
a hand-written name. Codegen should assert this invariant (no generated tool may emit a
single-underscore name).

Set MCP annotations — `readOnlyHint` on reads, `destructiveHint` on destructive/money/admin —
so clients that surface them can prompt, as defense in depth on top of the env gates.

One shared handler: build `{ path, query, body }` from validated args, pass through the rate
limiter, call the SDK method with `throwOnError: false`, then project the raw response through
`response_keys`.

Codegen adds `response_keys` (default `["*"]`) and the pagination inputs to every generated
tool's schema, and must keep them from colliding with a real VRChat parameter of the same
name — assert this, since a silent shadow would drop a genuine API argument.

**Error shape** — every failure returns an MCP `isError` result with structured detail: HTTP
status, VRChat's own message, and an actionable hint so the agent can self-correct instead of
the user reading logs:

| Status | Hint |
|---|---|
| 401 | session expired — call `vrchat_authStatus`, re-auth may need a 2FA code |
| 403 | insufficient permissions (or an admin-only endpoint on a normal account) |
| 404 | resource not found — check the id |
| 429 | upstream rate limit; the limiter is backing off, retry shortly |
| local timeout | queued behind the local rate limiter — retry |

Never let a raw exception or stack trace reach the transcript.

### 9. `src/project.ts` — agent-driven field projection

**No server-side curation.** Responses are always the raw upstream payload, projected down to
exactly what the caller asked for. Every tool takes:

```ts
response_keys: string[]   // default ["*"] — the full raw response
```

This inverts the usual trimming approach, and it's the better trade: a hand-curated field list
guesses what matters and is wrong for whoever needed the other field, and it has to be
maintained for 250 operations against a moving spec. The agent knows what it's looking for on
this call; it should say so.

**Path syntax** — dot paths over the JSON, with wildcards:

| Pattern | Meaning |
|---|---|
| `["*"]` | the whole raw response, unprojected |
| `["id", "name"]` | those top-level fields |
| `["author.displayName"]` | nested path |
| `["*.id"]` | `id` from every element of a top-level array or object |
| `["items.*.id", "items.*.name"]` | those fields from every element of `items` |
| `["unityPackages.*.**"]` | everything below each element (`**` = any depth) |
| `["!description"]` | leading `!` excludes; combines with `["*"]` to mean "raw minus this" |

Projection **preserves shape** — objects stay nested, arrays stay arrays and keep their order
and length. The agent gets a smaller version of the same structure, not a flattened bag, so
paths it learned on one call still work on the next.

**Discovery matters more than the projection itself.** An agent can't ask for keys it doesn't
know exist, and a silently-empty result is the failure mode that makes this design worse than
trimming:

- If a requested path matches nothing, don't return empty — return `_unmatched: ["…"]` plus
  `_availableKeys`, the top-level key names (and, for arrays, the element's keys). One
  retry lands it.
- Include `_availableKeys` on every projected response by default, capped and names-only. It's
  small next to the fields themselves and removes the guess-and-retry cycle.
- Where the spec has a response schema, put the top-level field names into the tool
  description at codegen time, so the common case needs no discovery round-trip at all.

Applies uniformly to generated tools **and** the event tools — pipeline payloads are fat too.

`["*"]` as the default keeps the server honest: the raw response is always reachable and
nothing is hidden. The tool description should say plainly that narrowing `response_keys` is
how you avoid burning context on a `World` or `User` object.

### 10. `src/index.ts`

```ts
serveStdio(() => {
  const server = new McpServer({ name: 'vrchat', version: '0.1.0' })
  registerAuthTools(server)        // always
  registerEventTools(server)       // only when VRCHAT_MCP_WEBSOCKET=1
  registerGeneratedTools(server)   // tag + write + admin gated
  return server
})
```

**Critical for stdio:** stdout is the JSON-RPC channel. Every log/diagnostic goes to stderr
(`console.error`) — one stray `console.log` corrupts the protocol stream.

### 11. `.env.example` + README

Document every env var — `VRCHAT_USERNAME`, `VRCHAT_PASSWORD`, `VRCHAT_TOTP_SECRET`,
`VRCHAT_CONTACT`, `VRCHAT_MCP_TAGS`, `VRCHAT_MCP_ALLOW_WRITES`,
`VRCHAT_MCP_ALLOW_PURCHASES`, `VRCHAT_MCP_ALLOW_ADMIN`, `VRCHAT_MCP_RPS`,
`VRCHAT_MCP_WEBSOCKET`, `VRCHAT_MCP_WS_EVENTS`, `VRCHAT_MCP_HISTORY`,
`VRCHAT_MCP_HISTORY_MAX_AGE`, `VRCHAT_MCP_DB`, `VRCHAT_MCP_PROXY`, `VRCHAT_LIVE_TESTS` — plus
the User-Agent/contact requirement, the email-OTP flow (`vrchat_submitTwoFactorCode`), and
registration: `claude mcp add vrchat -- bun run <abs-path>/src/index.ts`.

Document the proxy format (`http://`, `socks5://`, optional `user:pass@`) and that it covers
both API and WebSocket traffic. Document how to run the live suite and what it will and won't
touch.

`.gitignore` must cover `.env` and `.vrchat-mcp/`.

## Verification

**Testing strategy:** two suites.

- **`bun test`** *(offline)* — codegen, gating, the limiter (fake clock), history retention
  and search, `response_keys` projection, error mapping. No network, no credentials.
- **`bun test:live`** *(live)* — real HTTP calls against a real account, opted in by
  `VRCHAT_LIVE_TESTS=1` and skipped otherwise so the default run never needs credentials.

Rules for the live suite, which is hitting a real account on a rate-limited API:

- **Reads and creator-owned writes only.** Never call anything under the money or admin
  classification — no `purchaseProductListing`, no `deleteUser`. A test suite must not be
  able to spend money.
- Route through the same 20 req/s limiter as production and keep the suite small; a test run
  that trips VRChat's throttling is worse than no test run.
- Any write must clean up after itself (create → assert → delete) and be tagged so stray
  artifacts are identifiable in-game.
- Use a dedicated account where possible, credentials from `.env` only, never committed.
- Assert on shape and status, not on volatile content — friend counts and world listings move.

Steps below are marked *(offline)* or *(live)* accordingly.

1. *(offline)* `bun run generate` — regenerates `src/generated/operations.ts`; confirm ~250 operations
   and that the Economy tag yields 41, Inventory 15, Props 8, Prints 5.
2. `bun test` — codegen unit tests: every op has a valid Zod schema; `kind` classification
   matches the override lists; `git diff --exit-code src/generated` is clean on a
   re-run (deterministic output).
3. *(offline)* `bun run src/index.ts` — starts, silent on stdout. Then start it **with no
   credentials set** and confirm `tools/list` still works: that proves login is lazy.
4. *(live)* `npx @modelcontextprotocol/inspector bun run src/index.ts` — call
   `vrchat__getCurrentUser` for a real identity, then `vrchat__getBalance` to prove the
   Economy path and auth scope work. Check a paginated call (`vrchat__searchWorlds`) returns
   ~25 results plus a usable `nextOffset`, and compare the payload with
   `response_keys: ["*"]` against `["*.id", "*.name"]` to see the projection actually bite.
5. *(offline)* Gate checks via Inspector CLI — `tools/list` needs no credentials, since login
   is lazy:
   - default env → no `vrchat__deleteProduct`, no `vrchat__purchaseProductListing`,
     no `vrchat__deleteUser`
   - `VRCHAT_MCP_ALLOW_WRITES=1` → `vrchat__deleteProduct` appears; the other two do not
   - `+ VRCHAT_MCP_ALLOW_PURCHASES=1` → `vrchat__purchaseProductListing` appears;
     `vrchat__deleteUser` still does not
   - `+ VRCHAT_MCP_ALLOW_ADMIN=1` → `vrchat__deleteUser` appears (the three gates are
     independent — verify each in isolation, not just cumulatively)
   - `VRCHAT_MCP_TAGS=economy` → only Economy tools listed
   ```
   npx @modelcontextprotocol/inspector --cli bun run src/index.ts --method tools/list
   ```
6. *(live)* **Email-OTP flow**, with `VRCHAT_TOTP_SECRET` unset and no persisted session:
   - call `vrchat__getCurrentUser` → returns the paused-login result with a `requestId`,
     and a real code lands in the account's inbox
   - `vrchat_authStatus` → reports `awaiting_code`, method `emailOtp`
   - `vrchat_submitTwoFactorCode` with the emailed code → login succeeds
   - retry `vrchat__getCurrentUser` → real data
   - a bad code returns a clear failure and leaves the request re-submittable; an expired
     `requestId` is rejected, not hung
7. *(live)* **Concurrency:** from a cold unauthenticated start, fire three tools at once — exactly one
   login and one prompt should occur, and all three should complete after the code is
   submitted (proves the single-flight lock).
8. *(live)* Relaunch to confirm the persisted Keyv session skips 2FA entirely; then
   `vrchat_logout` and confirm the prompt returns.
9. *(live)* With `VRCHAT_TOTP_SECRET` set, confirm login is fully unattended — no prompt.
10. *(offline)* **Rate limiter**, against a fake clock:
    - 100 queued calls at `VRCHAT_MCP_RPS=20` drain at ~20/s, none dropped
    - a simulated 429 with `Retry-After: 5` pauses *all* in-flight callers ~5s, then resumes —
      verify it does not produce a concurrent retry stampede
    - a call exceeding max wait returns the retry result instead of hanging
11. *(live)* **WebSocket**, with `VRCHAT_MCP_WEBSOCKET=1`:
    - `vrchat_eventsStatus` → connected, with the expected subscribed types
    - trigger a real event (have a friend come online, or send yourself an invite) →
      `vrchat_eventsRecent` returns it, `content` already **decoded** (not a JSON string)
    - `vrchat_eventsWait({ timeoutMs: 5000 })` with no traffic returns empty, not an error
    - kill the network briefly → reconnects with backoff, `events_status` reflects both states
    - default env (no `VRCHAT_MCP_WEBSOCKET`) → no socket opens and no `vrchat_events*`
      tools appear in `tools/list`
12. *(offline)* **History store** — `bun test` seeding the DB directly, no live socket:
    - confirm **FTS5 is available in `bun:sqlite`** before building on it; if not, the
      `LIKE` fallback path is what ships
    - **per-type retention:** insert 1500 `friend-location` and 5 `economy-update` at
      `VRCHAT_MCP_HISTORY=1000` → 1000 `friend-location` retained *and all 5*
      `economy-update` still present. This is the core assertion — a global cap would have
      evicted them.
    - per-type overrides parse and apply
      (`VRCHAT_MCP_HISTORY=1000,friend-location:200` → 200 retained for that type only)
    - **age ceiling:** with `VRCHAT_MCP_HISTORY_MAX_AGE=7d`, seed 10 events backdated 30 days
      and 10 from today → only today's survive, even though the count cap was never reached
    - both limits together: whichever binds first wins, and `eventsStatus` names which one
    - `VRCHAT_MCP_HISTORY_MAX_AGE=0` disables the age sweep entirely
    - the startup sweep runs, so a DB left untouched for months is clean before its first query
    - `events_status` reports correct per-type counts, caps, drop counts, and oldest
      timestamps
    - trim runs on a threshold, not per insert (assert query count over a burst)
    - `vrchat_eventsSearch` filters correctly by `types`, `userId`, and `since`/`until`,
      and free-text `query` matches inside decoded content
    - `limit` is capped and the response reports total matches, so a truncated result set is
      visible rather than silently partial
    - restart the server → history is still queryable (proves durability, the whole point
      over an in-memory buffer)
    - burst-insert a few thousand rows and confirm batching keeps it fast (no per-event fsync)
13. *(offline)* **Error shape** — assert a mocked 401/403/404/429 each produce an `isError`
    result with status, message, and the right hint, and that no stack trace leaks.
14. *(offline)* **`response_keys` projection**, against a recorded fat `World` payload:
    - `["*"]` (and omitting the arg) returns the payload byte-identical — the raw path must
      never be lossy
    - `["id","name"]`, `["author.displayName"]`, `["*.id"]`, `["items.*.name"]`, and `["**"]`
      each select correctly, preserving nesting, array order, and array length
    - `["!description"]` with `["*"]` returns everything except that field
    - an unmatched path returns `_unmatched` **and** `_availableKeys` rather than an empty
      object — the discovery path is the thing that makes this design safe, so test it
      explicitly
    - projection measurably shrinks the payload (assert a byte-size drop, not just shape)
    - a `response_keys` name colliding with a real VRChat parameter is caught at codegen
15. *(offline)* **Spec snapshot** — `bun run generate --offline` reproduces
    `src/generated/operations.ts` byte-for-byte from `spec/openapi.bundled.json` with the
    network unavailable, and the SHA in `spec/VERSION.json` matches the generated file's
    header. This is the whole anti-drift claim; test it with the network actually off.
16. **Proxy** — point `VRCHAT_MCP_PROXY` at a local proxy with request logging:
    - *(live)* API traffic appears in the proxy log; **and the WebSocket does too** — the
      easy-to-miss half, where a direct connection would leak the real IP
    - *(offline)* an unreachable proxy produces a clear "proxy unreachable" error and
      **no direct connection is attempted**
    - the proxy URL never appears in any log output, including with credentials embedded
    - if `socks5://` isn't natively supported by the installed Bun, the `socks-proxy-agent`
      fallback carries the same env var unchanged
17. *(live)* `bun test:live` — the live suite passes, stays inside the 20 req/s budget, and
    creates no lingering artifacts. Confirm it hard-refuses to run money or admin operations.
18. *(live)* Register with Claude Code and drive an end-to-end creator-economy task (list
    products, read earnings metrics) through the agent.

## Open items

- **Spec drift review.** `generate` pulls upstream `main`, so read both the
  `spec/openapi.bundled.json` and `src/generated/operations.ts` diffs before committing. The
  committed snapshot means a bad upstream commit is revertible rather than load-bearing.
- Recorded HTTP fixtures would let tool handlers be exercised offline too, complementing the
  live suite. Deferred — it needs fixture scrubbing for personal data.
- Out of scope by decision: this machine only — no HTTP transport, no multi-user credential
  isolation, no publishing to the official MCP registry.
