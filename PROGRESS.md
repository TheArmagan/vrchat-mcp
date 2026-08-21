# PROGRESS

Running status log for the build described in [docs/PLAN.md](docs/PLAN.md).
Update this file as each step lands — it is the handoff surface for future agents.

Legend: `[x]` done · `[~]` in progress · `[ ]` not started · `[!]` blocked

## Status

| # | Step | State | Owner |
|---|---|---|---|
| 0 | Project docs (`docs/PLAN.md`, `PROGRESS.md`) | [x] | main |
| 1 | Dependencies, scripts, `.gitignore`, `src/config.ts`, `src/types.ts` | [x] | main |
| 2 | `scripts/generate-tools.ts` + committed spec snapshot | [x] | agent A |
| 3 | `src/vrchat/client.ts` (lazy client, proxy) | [x] | agent B |
| 4 | `src/vrchat/twofactor.ts` (pending-code broker) | [x] | agent B |
| 5 | `src/tools/auth.ts` | [x] | agent B |
| 6 | `src/vrchat/ratelimit.ts` | [x] | agent B |
| 7 | `src/vrchat/events.ts` + `history.ts` + `src/tools/events.ts` | [x] | agent C |
| 8 | `src/registry.ts` (gating + registration) | [x] | main |
| 9 | `src/project.ts` (`_responseKeys`) + `src/errors.ts` | [x] | agent D |
| 10 | `src/index.ts` (stdio entry) | [x] | main |
| 11 | `.env.example` + README | [x] | agent E |
| 12 | `tests/live/` — live suite (plan Verification §17) | [x] | main |

## Established facts (verified against installed packages, do not re-derive)

Read these before touching the code — each one was checked against the
actual installed dependency, not assumed from docs.

### MCP SDK — `@modelcontextprotocol/server@2.0.0`

- Entry: `import { serveStdio } from '@modelcontextprotocol/server/stdio'`,
  `import { McpServer } from '@modelcontextprotocol/server'`.
- `serveStdio(factory, options?)` takes a **factory** (`() => McpServer`) and
  returns a handle synchronously. One instance is pinned per connection.
- `server.registerTool(name, { title?, description?, inputSchema?,
  outputSchema?, annotations? }, cb)`. `inputSchema` should be a **`z.object(...)`**
  (Standard Schema); the raw-shape form is deprecated.
- Input-required flow is exported: `inputRequired`, `InputRequiredResult`,
  `isInputRequiredResult`, `inputResponse`.
- `sendLoggingMessage` is **deprecated** as of `2026-07-28` — log to stderr.

### VRChat SDK — `vrchat@2.22.8`

- `new VRChat({ application, authentication, keyv, pipeline, fetch, ... })`.
- **`authentication.optimistic` defaults to `true`** and fires a login from the
  constructor. Set it to **`false`** — that is what makes login lazy.
- **The SDK already single-flights login.** `authenticate()` memoizes an
  `authenticatePromise`, and a request interceptor makes every in-flight request
  await it. A response interceptor catches **401**, re-authenticates, and
  replays the original request. So a burst of cold-start calls produces one
  login and one 2FA prompt for free — do not build a second lock.
  **CAVEAT, learned the hard way:** that 401 path does *not* make login lazy on
  its own, because a partial session comes back **200** with
  `requiresTwoFactorAuth`. See "Lazy login was broken" below — call
  `ensureAuthenticated()`, never rely on the interceptor alone.
- **`twoFactorCode` receives NO arguments.** It is `Lazy<string>` =
  `string | Promise<string> | (() => string | Promise<string>)`. The SDK does
  *not* pass the 2FA method in, which the plan flagged as an open question.
  **Resolution:** sniff it from the wire. The login response body carries
  `requiresTwoFactorAuth: ["emailOtp"]` or `["totp","otp"]`; the `fetch`
  override (already ours, for the proxy) records the methods into the broker
  before the callback runs. Zero extra requests.
- `totpSecret` is only consulted when the methods include `totp` **and** no
  `twoFactorCode` was supplied — so set `twoFactorCode` only when there is no
  `VRCHAT_TOTP_SECRET`, or TOTP goes interactive unnecessarily.
- Every operation method takes `Options<..., ThrowOnError>` and returns
  `{ data, error, request, response }` when `throwOnError: false`.
- Websocket: `import { VRChatWebsocket } from 'vrchat/websocket'`, also reachable
  as `vrchat.pipeline`; `vrchat.on(event, handler)` is an alias for
  `vrchat.pipeline.on`. It takes `{ baseUrl?, headers?, authToken? }` and is
  authenticated via `pipeline.authenticate(authToken)` — which the SDK already
  calls with the persisted cookie during `authenticate()`.

## Decisions taken during implementation (diverging from or refining the plan)

- **`src/types.ts` and `src/config.ts` were written up front** as the shared
  contract every module codes against, so the workstreams could proceed in
  parallel without guessing each other's shapes. Not in the plan's file list.
- **No hand-rolled single-flight login lock** (plan §4) — the SDK provides one.
  Documented above so nobody "fixes" its absence.
- **2FA method detection is done by response sniffing in the `fetch` override**
  rather than from a callback argument, which the SDK does not offer.
- `src/errors.ts` was split out of `src/registry.ts` so the error mapping is
  unit-testable on its own and reusable by the event and auth tools.
- **The registry calls SDK methods by indexing the client** (`client[operationId]`)
  rather than through a `callOperation` helper in `client.ts`. The SDK exposes
  every spec `operationId` as a method of the same name and codegen asserts that
  mapping, so one indexed call serves all ~250 tools with no per-op glue.
- **Rate limiting is applied inside the client's `fetch` override**, not around
  each tool handler. That is the only seam every request passes through, so the
  auth flow is limited too — which §6 requires and a handler-level wrapper would
  have missed.
- **Gate tests spawn the server over stdio** (`tests/gates.test.ts`) instead of
  using the Inspector CLI. The gates are read from the environment at import
  time, so they can only be tested across a process boundary; this also proves
  `tools/list` works with no credentials.

## Codegen results (spec `b7fff1af`, fetched 2026-08-09)

**297 operations**, not the ~250 the plan estimated — but the four tags the plan
pins are exact: economy 41, inventory 15, props 8, prints 5. Largest tag is
groups (51). Kinds: read 144, write 84, destructive 44, admin 14, money 11;
39 are paginated.

- **Ten operationIds have no matching SDK method** — `cancelPending2FA`,
  `disable2FA`, `enable2FA`, `verify2FA`, `verify2FAEmailCode`,
  `verifyPending2FA`, `getGroupCalendarEventICS`, `getCSS`,
  `deleteAllNotificationV2s`, `getNotificationV2s`. The spec moves faster than
  the client library. `src/registry.ts` routes these through a **raw-request
  fallback** on the same client, so cookies, User-Agent, proxy and the rate
  limiter still apply and 1:1 coverage stays true rather than quietly becoming
  a lie. Codegen prints the gap list on every run.
- **Several ops the plan's override lists name have been renamed upstream** —
  `deleteProductListing` → `deleteProductListingDirect`,
  `updateTiliaTosAgreementStatus` → `updateTiliaTos`,
  `deleteAllUserPersistence` → `deleteAllUserPersistenceData`. Both spellings
  are kept in the lists: a stale entry is inert, a missing one would silently
  downgrade an operation's safety class.
- **Money and admin are also matched by path** (`/tilia|kyc|payout/i`,
  `/moderationReports|avatarmoderations/i`) so a future rename cannot leak an
  op past its gate. Precedence: admin > money > destructive > HTTP verb.
- **`getBalance` classifies as `read`**, not `money` — it only reads a number.
  The plan's verification step 4 calls it under default env, which only works
  if it is a read.

## Env surface: plan vs. `src/config.ts`

`src/config.ts` is authoritative; the README documents it, not the plan.
Differences worth knowing:

- Three vars exist that §11 never names: `VRCHAT_MCP_MAX_WAIT_MS` (30000),
  `VRCHAT_MCP_SESSION` (`.vrchat-mcp/session.json`), `VRCHAT_MCP_2FA_TIMEOUT_MS`
  (300000). The plan gave these as prose defaults only.
- Booleans accept `1` or `true` (case-insensitive), not just `=1`.
- `VRCHAT_MCP_RPS=0` falls back to 20 — there is no "disable the limiter" value.
  `VRCHAT_MCP_HISTORY_MAX_AGE=0` *does* disable the age sweep, because it parses
  through a different helper that permits zero.
- `VRCHAT_MCP_WS_EVENTS` **replaces** the default event set; it does not extend it.
- `parseDuration` accepts `ms|s|m|h|d|w` and a bare millisecond count, beyond
  the `7d`/`12h`/`0` the plan documents.
- `config.dataDir` is hardcoded; `VRCHAT_MCP_DB` and `VRCHAT_MCP_SESSION` are
  independent full paths, so overriding them does not move the directory.

## Projection semantics settled (`src/project.ts`)

The plan's path table left several cases open. These are now fixed behaviour,
pinned by `tests/project.test.ts`:

- **`["*"]` returns the input by reference** — identity, no meta at all, so the
  raw path is provably lossless. `["**"]` is a genuine projection with the same
  content but carrying meta. `["*", "!x"]` is likewise a projection.
- **Array misses become `null`; object misses vanish.** Array length and order
  are load-bearing (an index seen once must stay that element), so a
  non-matching element is a `null` placeholder. Object keys are names, not
  positions, so a non-matching key is simply omitted.
- **No implicit array fan-out.** `items.name` does *not* auto-map over an array;
  `*` must be explicit, so a typo surfaces in `_unmatched` rather than silently
  fanning out.
- **Meta collision** (`_availableKeys` / `_unmatched` already present, or an
  array/scalar projection) nests the projection under `_result` with the meta
  beside it. The payload's own field is never overwritten or dropped. Arrays
  always take this route, because `JSON.stringify` silently discards
  non-index properties on an array.
- **`_availableKeys` names array element keys as `*.id`, `*.name`** — the form
  that actually works as a `_responseKeys` entry. Cap 50, with a `+N more` marker.
- **Meta has a fixed cost**, so excluding one short field can make a response
  marginally larger than raw. Narrowing is what pays; exclusion alone may not.

`src/errors.ts` matches the limiter timeout **structurally**
(`name === 'RateLimitTimeoutError'`, or `code` of `RATE_LIMIT_TIMEOUT`/`ETIMEDOUT`)
rather than importing `src/vrchat/ratelimit.ts`, so the two modules stay
independently testable. Messages are cut at the first V8 stack frame and capped
at 500 chars; a test asserts no stack ever reaches a tool result.

## Runtime findings (verified empirically, not assumed)

- **FTS5 IS available** in Bun 1.3.14's `bun:sqlite`, so search ships as an
  external-content FTS5 virtual table synced by triggers. The indexed-`LIKE`
  fallback is written and gated on `FTS5_AVAILABLE`; a test pins which path is
  live. Queries are wrapped as a single prefix phrase (`"…"*`), which both makes
  agent input injection-proof (no bare `OR`/`NEAR`) and lets the **default**
  tokenizer match inside VRChat ids — a custom `tokenchars '_-'` tokenizer was
  tried first and was strictly worse (`pancakes` stopped matching
  `wrld_pancakes`).
- **`Statement.run().changes` in `bun:sqlite` counts trigger-driven writes too** —
  a 2-row DELETE reported `changes: 10` because of the FTS shadow tables. Drop
  accounting uses an indexed `COUNT(*)` diff per trim instead.
- **Bun 1.3.14's `fetch` does NOT support SOCKS.** `socks5://`, `socks5h://` and
  `socks://` all fail with `UnsupportedProxyProtocol`; `http://` and `https://`
  proxies work and are genuinely honoured. `getClient()` rejects a `socks*` URL
  up front with a `ConfigurationError` rather than failing per-request. The
  plan's `socks-proxy-agent` fallback is **not** implemented — see Blocked/open.
- **The SDK refuses any `VRCHAT_CONTACT` containing `@example.com`**
  (`isApplication()`), so the obvious placeholder is the one value guaranteed to
  fail. `getClient()` pre-empts it with an actionable error, and `.env.example`
  now ships a non-`example.com` placeholder.
- **Bun's global `WebSocket` accepts `proxy` natively**, which is how pipeline
  traffic gets proxied — see below.

## Two leaks found and closed during integration

1. **`VRChat.authenticate()` calls `pipeline.authenticate(cookie)`
   unconditionally** whenever an auth cookie exists — including from the 401
   re-auth interceptor, and including when `VRCHAT_MCP_WEBSOCKET` is off. That
   opens a socket nobody asked for, burns a session slot, and connects
   **directly** while the rest of the server is proxied. `getClient()` now calls
   `pipeline.close()` and neuters `pipeline.authenticate` when the feature is
   disabled. When it is enabled, `EventPipeline.start()` replaces the same
   method with its token-capture hook, which doubles as the cookie feed for
   reconnects.
2. **Enabling the websocket used to crash startup without credentials** —
   `startEventPipeline(getClient())` threw before the server ever served, which
   would have destroyed the "`tools/list` works with no credentials" property
   that makes the server inspectable. Pipeline startup is now fully contained:
   failures log to stderr and nothing else.

## Websocket: the SDK's own pipeline could not be used

`VRChatWebsocket` builds `new WebSocket(url, { headers })` inline — no agent, no
dispatcher, no proxy option, and `url`/`websocket` are private. `src/vrchat/events.ts`
therefore drives Bun's global `WebSocket` directly, which takes `proxy` natively,
so pipeline traffic honours `VRCHAT_MCP_PROXY` like everything else.
`status()` reports `proxied` so it is visible rather than assumed.

Two further reasons the SDK socket had to go, both contradicting the plan's
assumption that we would just consume `vrchat.pipeline`:

- **It silently loses `see-notification` / `hide-notification`.** Its handler
  does an unconditional `JSON.parse(content)` inside a try/catch; a bare
  notification id is not JSON, so those frames are swallowed. `normalizeMessage`
  keeps the bare string (unit-tested) — exactly the case the plan called out.
- It emits per-type on a plain EventEmitter: no wildcard, no raw frame access.

## Naming change: `response_keys` → `_responseKeys`

Requested by the user mid-build. The leading underscore makes a collision with a
real VRChat parameter structurally impossible rather than merely asserted, and
it matches the project's camelCase convention. Renamed across the codegen
assertion, the registry, the event tools, the projection help text, the tests
and the docs. `docs/PLAN.md` retains the original spelling as a historical record.

## Lazy login was broken — fixed (`ensureAuthenticated`)

The plan assumed the SDK's 401 response interceptor would make login lazy for
free, and `PROGRESS.md` recorded that as an established fact. **It is wrong**,
and it was only caught by running against a real account:

On a *partial* session VRChat answers `/auth/user` with **200** and a
`{ requiresTwoFactorAuth: ['emailOtp'] }` body — **not** a 401. So the
interceptor never fires, `authenticate()` is never called, no 2FA prompt is ever
raised, and the tool hands the agent that body as though it were a result. Every
API call would have silently returned nonsense on any account needing 2FA.

`src/vrchat/client.ts` now exports **`ensureAuthenticated()`**, which calls
`authenticate({ partial: true })` explicitly, single-flighted, and short-circuits
once `sessionActive` is set by the fetch sniffer — so it costs one extra request
per process, not per tool call. `src/registry.ts` awaits it before every
operation, and the live suite's `liveCall` does the same.

The SDK's single-flight and 401-replay behaviour is still real and still worth
not duplicating; it simply does not cover the partial-session case, which is the
case that matters on a 2FA account.

## Live verification: PASSING

Confirmed end-to-end against a real account (`AVTRZIP`) over the configured
HTTP proxy, email-OTP login included. `bun run test:live` → 10 pass / 0 fail.

- Email-OTP flow works: the broker parks the login, `submitCode` resolves it,
  and the Keyv session persists so later runs skip 2FA entirely.
- `getCurrentUser` and `getBalance` both return real data — the economy path and
  auth scope are live.
- `searchWorlds` paginates correctly and page 2 differs from page 1.
- Narrowing `_responseKeys` on a real World listing cuts the payload by >50%.
- A bogus user id produces a structured error with no stack trace.
- A 10-call burst stays inside the local rate budget with none dropped.

`tests/live/guard.ts` is the safety rail: every live call goes through
`liveCall`, which **hard-refuses the `money` and `admin` classes** before any
client is constructed. Three tests assert that refusal and run even without
credentials. Cleanups are registered per artifact and torn down in reverse.

The suite skips itself entirely unless `VRCHAT_LIVE_TESTS=1` **and** credentials
are present, so `bun test` still needs neither. `liveLogin()` fails fast with an
actionable message when an account would park on an interactive 2FA prompt —
otherwise a run hangs for the full five-minute broker timeout, per describe block.

## `bun link` support

`vrchat-mcp` installs as a PATH command (`bun link`), so a client registers it
as `claude mcp add vrchat -- vrchat-mcp` with no absolute paths anywhere.
Three things had to change for that to actually work:

- **A `#!/usr/bin/env bun` shebang on `src/index.ts`**, which the `bin` entry needs.
- **Data paths are PER PROJECT** (changed by user decision — an earlier
  revision anchored them to the package root). `findProjectRoot()` walks up
  from `process.cwd()` for a `.git` / `package.json` / `deno.json` /
  `pyproject.toml` / `go.mod` marker, falling back to the working directory.
  Anchoring to a *marker* rather than to `cwd` directly is what makes launching
  from a subdirectory reach the same state instead of stranding a second
  session a level down. Resolved paths are unchanged when run from the repo, so
  no migration.
  - **Accepted consequence:** separate projects have separate logins, so the
    first call in a new project re-authenticates and, on an email-OTP account,
    asks for a code. Verified live. `VRCHAT_MCP_SESSION` pointed at one shared
    absolute path opts back out.
  - **`ensureDataDir()` writes a `.gitignore` containing `*` inside
    `.vrchat-mcp/` on creation.** The directory now lands in projects whose
    `.gitignore` we do not control, and the session file is an auth credential —
    self-ignoring protects it by default instead of relying on the host project
    adding a rule. Verified: `git status` in a fresh project does not see it.
- **The package's own `.env` is loaded as a fallback.** Bun auto-loads `.env`
  from the working directory only, so a linked server would start with no
  credentials and fail on the first tool call. Precedence is preserved:
  anything already in `process.env` — including an MCP client's `env` block —
  wins over the file.

**Config layering works out to three tiers, verified empirically** (a linked
run from a scratch directory containing its own `.env`):

1. Real environment variables / an MCP client's `env` block.
2. `.env` in the **directory the command is run from** — Bun auto-loads this,
   and it works through the linked binary. Overrides the repo's `.env` per key.
3. `.env` at the **repo root** — the fallback added above.

So a project drops a one-line `.env` (`VRCHAT_MCP_TAGS=economy` → 28 tools
instead of 144) and still inherits credentials from the repo. Confirmed both
directions: the local `VRCHAT_CONTACT` won, and `VRCHAT_USERNAME`/`PASSWORD`,
absent locally, were inherited.

Verified end-to-end from an unrelated working directory: `tools/list` returns
144 read-only tools, and `vrchat__getCurrentUser` with
`_responseKeys: ["displayName","id"]` returns real projected data.

## Login was getting stuck. Four separate causes, all fixed

Reported as "logging in from a different proxy hangs". Digging in found four
independent problems, three of which affect every login, not just proxied ones.

1. **`twoFactorPrompt` was written but never called.** A parked login blocked
   the tool call for the broker's full timeout (five minutes) while the agent
   was never told a code was wanted. `raceAgainstPrompt()` now ends the wait the
   moment the broker parks, and the registry returns a `login_paused` result
   naming the requestId and the tool to retry.

2. **VRChat's new-location check was reported as an expired session.** It comes
   back as `401 "It looks like you're logging in from somewhere new!"`, and the
   generic 401 hint told the agent to call `vrchat_authStatus` and re-auth,
   which can never clear it. The email holds a **link**, not a code. Detected
   now by message, with a hint that says so and points at `vrchat_retryLogin`.

3. **The same challenge also appears as `429 "Logging in from too many
   places?"`** once attempts pile up. That read as rate limiting, so the agent
   would wait it out, and worse, it paused the shared token bucket. `vrchatFetch`
   now inspects a 429 body and skips `limiter.noteResponse` for auth challenges.

4. **A fanned-out burst became a burst of logins.** The first login failed, the
   in-flight guard cleared, and the next tool call started another one. Three
   parallel tool calls meant three real login attempts, each costing a session
   slot and each capable of sending another email. Measured at 3 upstream
   attempts; a 30-second failure cache collapses it to 1. `restartLogin()` and
   `logout()` clear the cache, so the user-driven retry stays immediate.

`vrchat_retryLogin` is the new tool that drives round two: it cancels the parked
request, clears the failure cache, and starts a fresh login, reporting either
success or the freshly-parked code request.

Also fixed alongside: `describeError` discarded the `hint` on our own
`ConfigurationError` / `ProxyError`, replacing "Set VRCHAT_USERNAME and
VRCHAT_PASSWORD" with a generic "unexpected failure" shrug. Typed hints now win
over the status table.

Concurrency: a caller that did not start the login waits 3s, then returns
`login_pending` instead of blocking. One slow login stalls one tool call rather
than every tool the agent fired at once.

## File uploads

The spec declares upload fields as `format: binary`, and codegen was rendering
those as `z.string().base64()`. That shape is unusable: the agent would have to
inline a whole PNG into the tool arguments, roughly 2.7 MB of base64 for a 2 MB
file, and the SDK's form serializer wants a `Blob` anyway, so it would not have
worked even at that cost.

Since the server runs on the same machine as the files, it reads them itself.

- **Codegen marks binary fields** (`Operation.binaryFields`) and emits a path
  argument with a description telling the agent not to paste contents. Eight
  operations qualify: `uploadImage`, `uploadPrint`, `uploadIcon`,
  `uploadGalleryImage`, `editPrint`, and the three invite-photo ops.
- **`src/upload.ts`** turns a path into a `File`. A `File` and not a `Blob`
  because the SDK appends the value straight to `FormData`, and only a `File`
  carries a filename through; VRChat refuses a body announcing itself as `blob`
  with no extension. Rejects directories, empty files (VRChat accepts those and
  stores a broken record) and anything over 100 MB.
- **The registry swaps paths for files** before the call and reports the bytes
  sent, so a successful upload of the wrong file is distinguishable from a
  successful upload of the right one.
- **`vrchat_uploadFile`** (hand-written) runs the four-step sequence for
  arbitrary files: `createFile` → `startFileDataUpload` → PUT to the presigned
  URL → `finishFileDataUpload`. It is registered even when writes are off so it
  can explain the gate rather than silently not existing.
  - **The presigned PUT uses a bare `fetch`, not the VRChat client.** The URL
    points at a third-party storage host, and the client attaches the VRChat
    session cookie to every request it makes. Routing the upload through it
    would hand the session cookie to Amazon. The proxy and limiter still apply.
  - On a partway failure it names the file record it created. Deleting it
    automatically is not safe, since the id may belong to a version that did
    land, so the hint points at `vrchat__getFile` / `vrchat__deleteFile`.

**Not verified live.** The path handling has 11 unit tests and the tools were
driven over stdio (registration, the write gate, and a bad path all behave), but
no upload has been sent to VRChat. `vrchat_uploadFile`'s four-step sequence in
particular is written from the spec alone. Needs a real account and
`VRCHAT_MCP_ALLOW_WRITES=1`.

## Gate split: `VRCHAT_MCP_ALLOW_DESTRUCTIVE_WRITES`

`write` and `destructive` used to share one flag, so enabling writes also handed
over every `DELETE`, plus `banGroupMember`, `kickGroupMember`, `moderateUser`,
`closeInstance` and `deleteAllUserPersistenceData`. They are now separate, and
destructive layers on writes exactly as money does:

| kind | needs |
|---|---|
| `read` | nothing |
| `write` | `VRCHAT_MCP_ALLOW_WRITES` |
| `destructive` | `VRCHAT_MCP_ALLOW_WRITES` **and** `VRCHAT_MCP_ALLOW_DESTRUCTIVE_WRITES` |
| `money` | `VRCHAT_MCP_ALLOW_WRITES` **and** `VRCHAT_MCP_ALLOW_PURCHASES` |
| `admin` | `VRCHAT_MCP_ALLOW_ADMIN` (independent of everything) |

Layered rather than standalone on purpose: a delete is a write, so the flag on
its own grants nothing. Letting it work alone would make it a route to deletes
*without* writes, which is backwards for a safety gate. A test pins that.

**This is a behaviour change.** `VRCHAT_MCP_ALLOW_WRITES=1` alone no longer
registers `vrchat__deleteProduct`; the gate test that asserted it did was
updated to assert the opposite, plus the new four-level ladder.

## Blocked / open

- **SOCKS proxy support is deliberately NOT implemented — decided, not pending.**
  Plan §3 offers a `socks-proxy-agent` fallback for exactly this case, and
  Bun 1.3.14 does reject `socks5://` with `UnsupportedProxyProtocol`. The user
  chose to ship HTTP/HTTPS only rather than take on `undici` plumbing (Bun's
  native `fetch` accepts no dispatcher) plus a second agent path for the
  websocket. `http://` and `https://` proxies work fully and cover both API and
  pipeline traffic; a `socks*://` URL fails up front with a `ConfigurationError`
  naming the limitation and suggesting a local HTTP front-end, and never falls
  back to a direct connection. **Do not implement the fallback without asking
  again** — its absence is the decision.
- **Live verification has not been run.** Every offline step passes (116 tests,
  clean `tsc`, deterministic offline codegen, gates verified over real stdio).
  Plan steps 4, 6, 7, 8, 9, 11, 16-live, 17 and 18 all need a real VRChat
  account and credentials in `.env`.
- **Ten operations rely on the raw-request fallback** and have not been
  exercised against the live API — the fallback path itself is untested until a
  live run.
