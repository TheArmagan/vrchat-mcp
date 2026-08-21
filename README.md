# vrchat-mcp

An MCP server exposing **the entire VRChat API** — roughly 250 operations across 18 tags —
with first-class coverage of the creator-economy stack (Economy, Inventory, Props, Prints).

Tools are **generated from the [VRChat OpenAPI specification](https://github.com/vrchatapi/specification)**
at build time and committed, so the surface tracks upstream instead of rotting against it.
Transport is **stdio only**: the server runs as a local subprocess of Claude Code or Claude
Desktop, there is no HTTP endpoint, and credentials never leave the machine.

Built on Bun, the official MCP TypeScript SDK v2, and the official `vrchat` JavaScript SDK.

## Quick start

```bash
bun install
cp .env.example .env      # then fill in VRCHAT_USERNAME, VRCHAT_PASSWORD, VRCHAT_CONTACT
```

### Install the `vrchat-mcp` command (recommended)

`bun link` puts a `vrchat-mcp` executable on your PATH, so nothing downstream needs to know
where the checkout lives:

```bash
bun link          # run once, from the repo root
vrchat-mcp        # now on PATH; speaks MCP over stdio
```

Then register it by name:

```bash
claude mcp add vrchat -- vrchat-mcp
```

Or, for Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vrchat": {
      "command": "vrchat-mcp"
    }
  }
}
```

That is the whole config. Credentials come from the repo's `.env` (see
[Where the command reads its data](#where-the-command-reads-its-data)), so they do not have
to be repeated here — though anything you *do* put in `env` takes precedence.

To remove it: `bun unlink` from the repo root.

### Without linking

If you would rather not put anything on your PATH, point at the entry file with an
**absolute** path — the server is spawned from an arbitrary working directory:

```bash
claude mcp add vrchat -- bun run /abs/path/to/vrchat-mcp/src/index.ts
```

```json
{
  "mcpServers": {
    "vrchat": {
      "command": "bun",
      "args": ["run", "/abs/path/to/vrchat-mcp/src/index.ts"],
      "env": {
        "VRCHAT_USERNAME": "your-username",
        "VRCHAT_PASSWORD": "your-password",
        "VRCHAT_CONTACT": "your-real-email@your-domain.tld"
      }
    }
  }
}
```

### Where the command reads its data

Once `vrchat-mcp` is on your PATH it can be launched from anywhere, so nothing that matters
is resolved against the working directory:

**State is per project.** Run the server inside a project and its session and event history
live in that project's `.vrchat-mcp/`:

| What | Where |
|---|---|
| `.vrchat-mcp/session.json` | the **project root** |
| `.vrchat-mcp/events.db` | the **project root** |

The project root is found by walking up from the working directory for a `.git`,
`package.json`, `deno.json`, `pyproject.toml` or `go.mod`. Launching from a subdirectory
therefore reaches the same state rather than stranding a second session a level down. With
no marker anywhere above, the working directory is the project.

The directory makes itself invisible to version control: `vrchat-mcp` writes a `.gitignore`
containing `*` inside it on creation, so the session — which is an auth credential — is
protected without the host project needing a rule for it.

> **Each project logs in separately.** The first call in a new project authenticates from
> scratch and, on an email-OTP account, asks for a code. That is the cost of isolation. To
> share one login across projects, point every install at the same file:
>
> ```bash
> VRCHAT_MCP_SESSION=/abs/path/to/shared/session.json
> ```

`VRCHAT_MCP_SESSION` and `VRCHAT_MCP_DB` override those paths; a relative value there is
resolved against the working directory.

**Configuration** layers, so a project can set its own options without repeating your
credentials. Highest priority first:

| Priority | Source | Use it for |
|---|---|---|
| 1 | Real environment variables, including an MCP client's `env` block | Anything you want to win unconditionally. |
| 2 | **`.env` in the directory the command is run from** | Per-project overrides. Bun auto-loads this. |
| 3 | `.env` at the repo root | Your credentials, set once. |

So a project that wants economy tools only, using the credentials you already configured,
needs a one-line `.env` next to it:

```bash
# ~/my-project/.env
VRCHAT_MCP_TAGS=economy
```

Run `vrchat-mcp` from `~/my-project` and it registers the 28 economy tools, authenticating
with the username, password and contact from the repo's `.env`. Any key the local `.env`
does define — `VRCHAT_CONTACT`, a different account, a tighter `VRCHAT_MCP_RPS` — overrides
the repo value for that run only.

The server starts read-only. Nothing that writes, spends, or moderates is registered until
you set the corresponding gate — see [Safety gates](#safety-gates).

## The User-Agent requirement (read this before you file a bug)

**VRChat rejects generic User-Agents with a 403.** Set `VRCHAT_CONTACT` to an email address
or project URL you control; it is folded into the descriptive User-Agent the SDK sends on
every request, API and WebSocket alike.

The value must be real. The SDK refuses any contact containing `@example.com`, so the
obvious placeholder is the one value guaranteed to fail — the server reports this as a
configuration error on the first tool call rather than letting it surface as a raw 403.

If every call comes back 403 — including ones that have nothing to do with permissions —
an unset or non-descriptive `VRCHAT_CONTACT` is the first thing to check. This is API policy,
not a quirk of this server.

## Configuration

All configuration is environment variables, read once at import in `src/config.ts`. Boolean
flags accept `1` or `true` (case-insensitive); anything else is off. `VRCHAT_MCP_RPS`,
`VRCHAT_MCP_MAX_WAIT_MS` and `VRCHAT_MCP_2FA_TIMEOUT_MS` must parse as a positive integer or
the default applies; the retention variables accept `0` as well. Nothing here can crash the
server at startup — a missing credential becomes a tool error on first use.

| Variable | Default | Effect |
|---|---|---|
| `VRCHAT_USERNAME` | — | VRChat account name (not display name). |
| `VRCHAT_PASSWORD` | — | Account password. |
| `VRCHAT_TOTP_SECRET` | — | Base32 TOTP secret. Set for unattended login; leave unset for the interactive 2FA flow. |
| `VRCHAT_CONTACT` | — | Contact string in the mandatory descriptive User-Agent. Effectively required. |
| `VRCHAT_MCP_TAGS` | all tags | Comma-separated OpenAPI tags to register, e.g. `economy,inventory,users`. Trimmed, lowercased, de-duped. |
| `VRCHAT_MCP_ALLOW_WRITES` | off | Registers `write` operations: creating and editing. Not deletes. |
| `VRCHAT_MCP_ALLOW_DESTRUCTIVE_WRITES` | off | Additionally registers `destructive` operations. Requires the write gate too. |
| `VRCHAT_MCP_ALLOW_PURCHASES` | off | Additionally registers `money` operations. Requires the write gate too. |
| `VRCHAT_MCP_ALLOW_ADMIN` | off | Registers `admin` operations. Independent of the write gate. |
| `VRCHAT_MCP_RPS` | `20` | Sustained requests/second through the shared token bucket. |
| `VRCHAT_MCP_MAX_WAIT_MS` | `30000` | Max time a call may sit queued behind the limiter before returning a retry result. |
| `VRCHAT_MCP_WEBSOCKET` | off | Opens the pipeline socket and registers the `vrchat_events*` tools. |
| `VRCHAT_MCP_WS_EVENTS` | see below | Comma-separated event types. **Replaces** the default set, does not extend it. |
| `VRCHAT_MCP_HISTORY` | `1000` | Retained events **per type**. Per-type overrides: `1000,friend-location:200`. |
| `VRCHAT_MCP_HISTORY_MAX_AGE` | `30d` | Age ceiling on retained events. `30d` / `12h` / `90m` / `45s` / `500ms` / bare ms / `0` to disable. Same override syntax. |
| `VRCHAT_MCP_DB` | `.vrchat-mcp/events.db` | SQLite event history file. |
| `VRCHAT_MCP_SESSION` | `.vrchat-mcp/session.json` | Persisted auth session. **This file is a credential.** |
| `VRCHAT_MCP_PROXY` | — | Proxy for API *and* WebSocket traffic. Never logged. |
| `VRCHAT_MCP_2FA_TIMEOUT_MS` | `300000` | How long a paused login waits for a submitted code. |
| `VRCHAT_LIVE_TESTS` | off | Opts into the live integration suite. |

Default WebSocket event set: `notification`, `notification-v2`, `economy-update`,
`friend-online`, `friend-offline`, `instance-queue-ready`.

See [`.env.example`](.env.example) for the same list with inline commentary.

## Tool naming

The separator carries meaning:

| Form | Origin | Examples |
|---|---|---|
| `vrchat__<operationId>` (**two** underscores) | Generated from the OpenAPI spec, `operationId` verbatim | `vrchat__getCurrentUser`, `vrchat__getBalance`, `vrchat__createProductListing` |
| `vrchat_<name>` (**one** underscore) | Hand-written server tool, not a VRChat endpoint | `vrchat_authStatus`, `vrchat_submitTwoFactorCode`, `vrchat_logout`, `vrchat_eventsRecent` |

No case transform is applied to generated names, so `vrchat__getUserTiliaKyc` is directly
searchable in the VRChat API docs. Codegen asserts the invariant: a generated tool can never
emit a single-underscore name, so the two namespaces cannot collide.

Hand-written tools:

- `vrchat_authStatus` — authenticated / awaiting-code / not configured, which env gates are
  active, and rate-limiter state (queue depth, backing off). First thing to call when
  anything behaves oddly.
- `vrchat_submitTwoFactorCode({ requestId, code })` — resolves a paused login.
- `vrchat_logout` — clears the persisted session.
- `vrchat_eventsRecent`, `vrchat_eventsWait`, `vrchat_eventsSearch`, `vrchat_eventsStatus` —
  registered only when `VRCHAT_MCP_WEBSOCKET=1`.

## Safety gates

Every generated operation is classified at codegen time, and the classification decides which
env flag must be set before the tool is registered at all. Ungated tools are not merely
refused at call time — they never appear in `tools/list`.

| Kind | Rule | Required env | Examples |
|---|---|---|---|
| `read` | `GET` | none — always registered | `getCurrentUser`, `searchWorlds`, `getBalance` |
| `write` | `POST` / `PUT` / `PATCH` | `VRCHAT_MCP_ALLOW_WRITES=1` | `createInstance`, `updateWorld` |
| `destructive` | `DELETE`, plus an explicit override list | `VRCHAT_MCP_ALLOW_WRITES=1` **and** `VRCHAT_MCP_ALLOW_DESTRUCTIVE_WRITES=1` | `deleteProduct`, `banGroupMember`, `kickGroupMember`, `moderateUser`, `deleteAllUserPersistence`, `closeInstance` |
| `money` | Buying, and anything under Tilia/KYC/payout paths | `VRCHAT_MCP_ALLOW_WRITES=1` **and** `VRCHAT_MCP_ALLOW_PURCHASES=1` | `purchaseProductListing`, `getEconomyPayouts`, `getUserTiliaKyc`, `updateTiliaTos` |
| `admin` | Admin-only and account-lifecycle ops | `VRCHAT_MCP_ALLOW_ADMIN=1` (independent of the write gate) | `deleteUser`, `registerUserAccount`, `confirmEmail`, `updateAssetReviewNotes`, moderation-report ops |

What you are actually opting into:

- `VRCHAT_MCP_ALLOW_WRITES=1` lets an agent create and change things you own — worlds,
  avatars, group membership, instances. Reversible mostly by hand.
- `VRCHAT_MCP_ALLOW_DESTRUCTIVE_WRITES=1` adds deleting and moderating on top: every `DELETE`,
  plus banning and kicking group members, closing instances and wiping user persistence. These
  are the calls with no undo, which is why they are not bundled with ordinary writes.
- `VRCHAT_MCP_ALLOW_PURCHASES=1` lets an agent **spend real balance**: `purchaseProductListing`
  is a live transaction. Do not set this because a tool listing looked incomplete.
- `VRCHAT_MCP_ALLOW_ADMIN=1` exposes `deleteUser` among others. Most of these 403 on a normal
  account, but `deleteUser` is the one that must never be an accident. It sits behind its own
  flag precisely so enabling writes does not drag it along.

Admin operations stay in the generated table either way, so coverage remains 1:1 with the spec
and the denylist is auditable in the diff.

On top of the env gates, MCP annotations (`readOnlyHint` on reads, `destructiveHint` on
destructive/money/admin) are set so clients that surface them can prompt — defense in depth,
not the primary control.

## Authentication and two-factor

**Login is lazy.** Nothing authenticates at startup. The server boots instantly, `tools/list`
works with no credentials at all, and login happens on the first tool call that needs the API.
This matters for stdio, which respawns on every client start — an eager login would fire on
each launch, and a 2FA prompt at boot has no tool call to attach itself to.

The session is persisted to `.vrchat-mcp/session.json`, so 2FA is asked for at most once per
machine until the session expires or you call `vrchat_logout`.

### Unattended (TOTP)

Set `VRCHAT_TOTP_SECRET` to the Base32 secret from your authenticator app. Codes are generated
in-process and login never prompts.

### Interactive (email OTP, or TOTP with no stored secret)

The in-flight tool call returns a non-fatal "login paused" result carrying a `requestId` and
which method VRChat asked for. No code is ever guessed or fabricated — the login parks until
you supply one, or until `VRCHAT_MCP_2FA_TIMEOUT_MS` expires.

A worked exchange:

```text
> vrchat__getCurrentUser {}

  Login paused: VRChat emailed a 6-digit code to your address.
  Ask the user for it, then call vrchat_submitTwoFactorCode
  { requestId: "a1b2", code: "123456" }, then retry this call.

> vrchat_authStatus {}

  { "state": "awaiting_code", "method": "emailOtp", "requestId": "a1b2" }

> vrchat_submitTwoFactorCode { "requestId": "a1b2", "code": "384219" }

  { "ok": true, "retry": "vrchat__getCurrentUser" }

> vrchat__getCurrentUser {}

  { "id": "usr_…", "displayName": "…", … }
```

A wrong code fails clearly and leaves the request re-submittable; an unknown or expired
`requestId` is rejected rather than left hanging.

On clients that negotiate the `2026-07-28` protocol revision, the same flow is surfaced as an
`input_required` result instead: you get a proper input box and the original call completes on
its own, no manual retry. The transcript above is the fallback, and works everywhere.

### Logging in from a new network

Changing proxy, VPN or ISP triggers a check that is not a two-factor code, and the two look
alike enough to waste a lot of time. VRChat answers the login with one of these:

```
401  It looks like you're logging in from somewhere new! Check your email for a message from VRChat.
429  Logging in from too many places? Check your email for verification link
```

Both mean the same thing. The email holds a **link**, not a six-digit code, so
`vrchat_submitTwoFactorCode` cannot help. The login takes two rounds:

1. A tool call fails with one of the messages above.
2. The user opens the link in the email.
3. Call `vrchat_retryLogin`. VRChat only sends the one-time code on this second attempt.
4. The user reads the code from the second email; call `vrchat_submitTwoFactorCode`.
5. Retry the original tool.

The 429 is an auth challenge wearing a rate-limit status, so the local limiter ignores it.
Waiting does not clear it, and every extra attempt costs one of the account's limited session
slots, which is what produces the 429 in the first place. A failed login is cached for 30
seconds so a burst of tool calls cannot turn into a burst of login attempts.
`vrchat_retryLogin` clears that cache, because by then the user has done the thing the
failure was waiting on.

### Concurrent tool calls during login

Agents fan tools out in parallel, and on a cold start they all land on an unauthenticated
client. One call drives the login. The others wait up to three seconds and then come back
with `login_pending` rather than blocking, so a slow login stalls one tool call instead of
every tool call, and a login that parks on a code raises one prompt instead of several.

## `_responseKeys`

Every tool — generated and hand-written alike — takes a `_responseKeys: string[]` argument,
defaulting to `["*"]`, which returns the raw upstream payload untouched. There is no
server-side curation: nothing is hidden, and the full response is always reachable.

Narrowing `_responseKeys` is how you avoid burning context on a fat `World` or `User` object.

| Pattern | Meaning |
|---|---|
| `["*"]` | The whole raw response, unprojected (default) |
| `["id", "name"]` | Those top-level fields |
| `["author.displayName"]` | Nested path |
| `["*.id"]` | `id` from every element of a top-level array or object |
| `["items.*.id", "items.*.name"]` | Those fields from every element of `items` |
| `["unityPackages.*.**"]` | Everything below each element (`**` = any depth) |
| `["!description"]` | Leading `!` excludes; combine with `["*"]` for "raw minus this" |

Projection **preserves shape**: objects stay nested, arrays stay arrays and keep their order
and length. Paths learned on one call still work on the next.

Before — the default, one world, ~30 fields including `description`, `unityPackages`, tags,
heat/popularity, timestamps:

```jsonc
// vrchat__searchWorlds { "n": 25 }  →  _responseKeys defaults to ["*"]
[
  {
    "id": "wrld_ba913a96-fac4-4048-a062-9aa5db092812",
    "name": "The Great Pug",
    "description": "…",
    "authorId": "usr_…",
    "authorName": "…",
    "unityPackages": [ { "…": "…" }, { "…": "…" } ],
    "tags": ["…"],
    "…": "…"
  }
  // × 25
]
```

After:

```jsonc
// vrchat__searchWorlds { "n": 25, "_responseKeys": ["*.id", "*.name", "*.authorName"] }
[
  { "id": "wrld_ba913a96-…", "name": "The Great Pug", "authorName": "…" }
  // × 25
]
```

If a requested path matches nothing, the result does not come back empty — it carries
`_unmatched` listing the paths that missed, plus `_availableKeys` naming what was actually
there, so one retry lands it. `_availableKeys` is included on projected responses by default
(names only, capped). Where the spec has a response schema, the top-level field names are
baked into the tool description at codegen time, so the common case needs no discovery
round-trip at all.

## Running a store

Managing a storefront is an ordinary write, not a `money` operation. Creating a product,
renaming it, changing its image, publishing or unpublishing a listing: none of these spend or
earn anything, so they need only `VRCHAT_MCP_ALLOW_WRITES=1`. The `money` gate is reserved for
buying things and for the payment processor.

`VRCHAT_MCP_TAGS=store` narrows to the 19 storefront operations. The spec's own `economy` tag
covers the storefront, wallet balances, purchase history and Tilia all at once, so it barely
filters anything for a creator who only manages products. Every operation keeps its spec tag
too, so `economy` still matches all of them.

```bash
VRCHAT_MCP_TAGS=store
VRCHAT_MCP_ALLOW_WRITES=1
```

Setting a product image takes two calls, or one:

```json
{ "name": "vrchat_setProductImage",
  "arguments": { "productId": "prod_...", "path": "/abs/path/cover.png" } }
```

That uploads with `tag: "product"` and attaches the returned file id as the product's
`imageId`. Doing it by hand is `vrchat__uploadImage` with `tag: "product"` or
`"listinggallery"`, then `vrchat__updateProduct` with the `id` it returns.

**What VRChat itself does not allow:** a listing exposes only `active` for editing, so its
price, title and description cannot be changed after creation. Delete the listing and create a
new one. The name, description and image live on the *product* and are editable through
`vrchat__updateProduct`.

## Which tools am I missing?

A gated tool is simply absent, which reads as "VRChat cannot do this" rather than "this server
was told not to". `vrchat_authStatus` closes that gap: it reports every tag and safety class,
how many operations each holds, which are currently exposed, and the exact `.env` change that
would expose the rest.

```json
{
  "availability": {
    "toolsRegistered": 12,
    "toolsHidden": 285,
    "tagFilter": ["store"],
    "kinds": { "write": { "enabled": false, "hidden": 88 } },
    "nextSteps": [
      "88 `write` operations are hidden. Ask the user to set VRCHAT_MCP_ALLOW_WRITES=1 ..."
    ]
  }
}
```

Call it before concluding something is unsupported.

## Uploading files

Pass a **local file path**. The server runs on your machine and reads the file itself, so
file contents never enter the conversation. Inlining a 2 MB PNG as base64 would cost roughly
2.7 MB of tool arguments, more than everything else in the call combined.

Eight operations take a file directly, one call each:

| Tool | Field | For |
|---|---|---|
| `vrchat__uploadImage` | `file` | Icons, gallery images, emoji, stickers (`tag` picks which) |
| `vrchat__uploadPrint` | `image` | Prints |
| `vrchat__uploadIcon` | `file` | Profile icons |
| `vrchat__uploadGalleryImage` | `file` | Gallery |
| `vrchat__editPrint` | `image` | Replacing a print's image |
| `vrchat__inviteUserWithPhoto` | `image` | Invite photos |
| `vrchat__requestInviteWithPhoto` | `image` | Invite requests |
| `vrchat__respondInviteWithPhoto` | `image` | Invite responses |

```json
{
  "name": "vrchat__uploadImage",
  "arguments": { "file": "C:/Users/me/Pictures/icon.png", "tag": "icon" }
}
```

The result names the bytes that were sent, which is the only way to tell a successful upload
of the right file from a successful upload of the wrong one:

```json
{
  "uploaded": [{ "field": "file", "name": "icon.png", "bytes": 48211, "type": "image/png" }],
  "result": { "id": "file_...", "name": "icon.png" }
}
```

For everything else, `vrchat_uploadFile` runs VRChat's four-step sequence (create the record,
request a presigned URL, transfer the bytes, finish) and returns the completed file record.
Use it for asset bundles and unity packages.

```json
{ "name": "vrchat_uploadFile", "arguments": { "path": "/abs/path/avatar.vrca" } }
```

The bytes go straight to VRChat's storage provider with a plain request, deliberately not
through the API client, because that client attaches your VRChat session cookie to everything
it sends and the storage host is a third party. The proxy and rate limiter still apply.

Uploads are writes, so all of this needs `VRCHAT_MCP_ALLOW_WRITES=1`. Files are capped at
100 MB, and an empty file is refused before it reaches VRChat, which would otherwise store a
broken record. If `vrchat_uploadFile` fails partway it names the file record it created, so
you can inspect it with `vrchat__getFile` and remove it with `vrchat__deleteFile`.

## Pagination

Paginated operations return **one page per call**. `n` defaults to a conservative 25, and the
handler echoes back the `nextOffset` to continue with. There is no hidden multi-request loop.

That is deliberate: an internal auto-paginate would burn the 20 req/s budget and a large slice
of the context window inside what looks to the agent like a single call. Fetching page two is
a decision the caller should make.

## WebSocket events

Off by default — an idle always-on socket burns a session slot, and `friend-location` /
`friend-update` will drown anything useful. Set `VRCHAT_MCP_WEBSOCKET=1` to enable it; only
then are the event tools registered.

`VRCHAT_MCP_WS_EVENTS` selects which types to subscribe to and **replaces** the default
low-noise set (`notification`, `notification-v2`, `economy-update`, `friend-online`,
`friend-offline`, `instance-queue-ready`).

Pipeline messages are double-encoded upstream (`content` is stringified JSON inside JSON).
That is normalized once at ingest, so tools always hand back decoded content.

Tools:

- `vrchat_eventsRecent({ types?, since?, limit? })` — events after a cursor; returns the newest
  cursor so you can poll incrementally without re-reading.
- `vrchat_eventsWait({ types?, timeoutMs? })` — resolves on the first matching event, or returns
  empty at timeout. `timeoutMs` defaults to 30s, capped at 120s so a call cannot outlive the
  client's own request timeout.
- `vrchat_eventsSearch({ query?, types?, userId?, since?, until?, limit? })` — free-text over
  decoded content plus indexed filters. Newest-first, default limit 50, hard cap ~200, with a
  total match count so a truncated slice is visible.
- `vrchat_eventsStatus()` — connected / disconnected / disabled, subscribed types, and a
  per-type breakdown: stored count, effective caps, oldest retained timestamp, rows dropped,
  and which limit is currently binding.

Event tools take `_responseKeys` like everything else — pipeline payloads are fat too.

### Retention is per type

History lives in local SQLite (`.vrchat-mcp/events.db`, WAL mode) so it survives restarts and
`vrchat_eventsSearch` can answer "what happened while I was away".

`VRCHAT_MCP_HISTORY` (default 1000) is a cap **per event type, not 1000 rows in total**. Each
type keeps its own window, so a chatty type like `friend-location` can never evict a rare and
valuable one like `economy-update` — which a single global cap would do within minutes. That
is what makes the high-frequency types safe to subscribe to at all.

`VRCHAT_MCP_HISTORY_MAX_AGE` (default `30d`) is an age ceiling applied alongside the count cap;
whichever bites first wins. Count alone lets a rarely-fired type sit on months-old events that
read as current; age alone lets a burst blow up the database. The sweep runs on a threshold and
once at startup, so a DB left untouched between sessions is clean before its first query. Set
it to `0` to disable the age sweep.

Both variables accept per-type overrides with the same syntax:

```bash
VRCHAT_MCP_HISTORY=1000,friend-location:200,economy-update:5000
VRCHAT_MCP_HISTORY_MAX_AGE=30d,friend-location:2h
```

Total rows are therefore bounded by `types × cap` and by the age window — a few thousand rows
with the default event set.

## Proxy

`VRCHAT_MCP_PROXY` routes traffic through an HTTP or HTTPS proxy, with optional
`user:pass@` credentials:

```bash
VRCHAT_MCP_PROXY=http://127.0.0.1:8080
VRCHAT_MCP_PROXY=https://user:pass@proxy.internal:8443
```

**SOCKS is not supported.** Bun's `fetch` rejects `socks5://`, `socks5h://` and `socks://`
with `UnsupportedProxyProtocol`, so a SOCKS URL fails at startup with a configuration error
naming the limitation rather than half-working. To use a SOCKS proxy, front it with a local
HTTP proxy and point `VRCHAT_MCP_PROXY` at that.

It covers **both API and WebSocket traffic**. The two are proxied through different mechanisms
(a `fetch` override for the API, Bun's native `WebSocket` `proxy` option for the socket), and
the failure mode of getting only half of it right is a server that looks proxied while leaking
its real IP on the event stream.

If the proxy cannot be reached, calls fail with a clear "proxy unreachable" error. The server
**never** silently falls back to a direct connection — for anyone using this for IP separation,
a silent fallback is the worst possible outcome. The proxy URL is never logged, since it may
embed credentials.

## Development

```bash
bun link                    # install the `vrchat-mcp` command on PATH
bun unlink                  # remove it again
bun run generate            # regenerate tools from the latest upstream spec
bun run generate --offline  # regenerate from the committed spec/openapi.bundled.json, no network
bun test                    # offline unit suite
bun run test:live           # live integration suite (needs VRCHAT_LIVE_TESTS=1)
bun run inspect             # MCP Inspector against this server
bun run typecheck           # tsc --noEmit
```

`bun run generate` fetches `vrchatapi/specification` at `main`, bundles it, and writes both the
bundled spec and `spec/VERSION.json` (upstream SHA, fetch timestamp, content hash) alongside the
regenerated `src/generated/operations.ts`. Both are committed, so every regeneration produces
two reviewable diffs — the spec change and the tool change it caused — and a bad upstream commit
is revertible rather than load-bearing. `--offline` reproduces the output from the committed
snapshot with no network at all.

`src/generated/operations.ts` is generated. Do not edit it by hand.

**stdio note:** stdout is the JSON-RPC channel. All logging goes to stderr — one stray
`console.log` corrupts the protocol stream.

## Testing

Two suites, split by whether they touch the network.

**`bun test` (offline).** Codegen output, gating, the rate limiter against a fake clock,
history retention and search, `_responseKeys` projection, error mapping. No network, no
credentials, no account required. This is what runs by default.

**`bun run test:live` (live).** Real HTTP against a real account, opted into with
`VRCHAT_LIVE_TESTS=1` and skipped otherwise. Rules it holds itself to:

- **Reads and creator-owned writes only.** It hard-refuses anything classified `money` or
  `admin` — no `purchaseProductListing`, no `deleteUser`. A test suite must not be able to
  spend money.
- Every write cleans up after itself (create → assert → delete) and is tagged so stray
  artifacts are identifiable in-game.
- It routes through the same 20 req/s limiter as production and stays small; a run that trips
  VRChat's throttling is worse than no run.
- Assertions are on shape and status, not volatile content — friend counts and world listings
  move.
- Use a dedicated account where you can. Credentials come from `.env` only, never committed.

## Security

- `.env` and `.vrchat-mcp/` are gitignored. Check before your first commit, not after.
- `.vrchat-mcp/session.json` is an **auth credential** — a valid session cookie. Treat it like
  a password; deleting it (or calling `vrchat_logout`) forces a fresh login.
- 2FA codes, passwords, TOTP secrets and proxy URLs are never logged, including to stderr.
- Errors are returned as structured `isError` results with status, VRChat's message, and an
  actionable hint. Raw exceptions and stack traces never reach the transcript.
- stdio only, local only. No HTTP transport, no multi-user credential isolation — this server
  is for one account on one machine.

## Project layout

```text
scripts/generate-tools.ts     # build-time codegen: spec -> src/generated/operations.ts
spec/openapi.bundled.json     # committed snapshot of the upstream spec
spec/VERSION.json             # upstream SHA + fetch timestamp + content hash
src/config.ts                 # the entire env surface, read once
src/types.ts                  # shared contracts (OperationKind, Operation, events, errors)
src/generated/operations.ts   # committed, generated, ~250 entries — do not edit
src/vrchat/client.ts          # memoized lazily-authed VRChat SDK client (+ proxy)
src/vrchat/twofactor.ts       # pending-code broker (email OTP + TOTP)
src/vrchat/ratelimit.ts       # 20 req/s token bucket + global 429 backoff
src/vrchat/events.ts          # websocket client + waiter registry
src/vrchat/history.ts         # bun:sqlite event store, per-type retention + search
src/tools/auth.ts             # vrchat_authStatus / _submitTwoFactorCode / _logout
src/tools/events.ts           # vrchat_eventsRecent / _eventsWait / _eventsSearch / _eventsStatus
src/registry.ts               # tag/write/admin gating + tool registration
src/project.ts                # _responseKeys path projection
src/errors.ts                 # HTTP status -> structured tool error with hint
src/index.ts                  # serveStdio entry point
tests/                        # offline suite; tests/live/ is the opt-in live suite
docs/PLAN.md                  # design document
PROGRESS.md                   # running build status and verified SDK facts
```

## License

See [LICENSE](LICENSE).
