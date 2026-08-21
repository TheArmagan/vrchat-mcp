# vrchat-mcp

An MCP server for the VRChat API. All 297 operations from the OpenAPI spec, generated at build
time, plus hand-written tools for the things a single endpoint cannot do: two-factor login,
file uploads, viewing images, and the event pipeline.

Runs locally over stdio, as a subprocess of Claude Code or Claude Desktop. Read-only until you
say otherwise.

Built on Bun, the official MCP TypeScript SDK v2, and the official
[`vrchat`](https://github.com/vrchatapi/vrchatapi-javascript) JavaScript SDK. Tools come from
the [VRChat OpenAPI specification](https://github.com/vrchatapi/specification) and are
committed, so the surface tracks upstream instead of rotting against it.

## Cheatsheet

```bash
bun install && bun link                # `vrchat-mcp` is now on PATH
cp .env.example .env                   # fill in username, password, contact
claude mcp add vrchat -- vrchat-mcp
```

Minimum `.env`:

```bash
VRCHAT_USERNAME=you
VRCHAT_PASSWORD=hunter2
VRCHAT_CONTACT=you@your-domain.tld     # must be real, VRChat 403s generic agents
```

| I want to | Do this |
|---|---|
| Enable creating and editing | `VRCHAT_MCP_ALLOW_WRITES=1` |
| Enable deleting and moderating | add `VRCHAT_MCP_ALLOW_DESTRUCTIVE_WRITES=1` |
| Enable spending balance | add `VRCHAT_MCP_ALLOW_PURCHASES=1` |
| Only expose storefront tools | `VRCHAT_MCP_TAGS=store` |
| Expose everything | `VRCHAT_MCP_TAGS=everything` |
| Find out why a tool is missing | call `vrchat_authStatus` |
| Stop huge payloads eating context | `_responseKeys: ["id","name"]` on any tool |
| See an image | `vrchat_getImage` with an `imageUrl` |
| Upload a picture | `vrchat__uploadImage` with a local file path |
| Fix a login stuck on a new network | open the emailed link, then `vrchat_retryLogin` |

Tool names carry their origin. Two underscores means generated from the spec
(`vrchat__getCurrentUser`), so the name is searchable in VRChat's own docs. One underscore
means this server wrote it (`vrchat_authStatus`).

Hand-written tools, in full:

| Tool | Does |
|---|---|
| `vrchat_authStatus` | Login state, rate limiter, and which tool groups are hidden by which env var |
| `vrchat_submitTwoFactorCode` | Answers a parked login with the code the user read out |
| `vrchat_retryLogin` | Restarts a login after a new-network email link is opened |
| `vrchat_logout` | Clears the stored session |
| `vrchat_getImage` | Downloads a VRChat image and returns it as a viewable image |
| `vrchat_uploadFile` | Runs VRChat's four-step upload for non-image files |
| `vrchat_setProductImage` | Uploads an image and attaches it to a store product |
| `vrchat_eventsRecent` | Events since a cursor |
| `vrchat_eventsWait` | Blocks until the next matching event |
| `vrchat_eventsSearch` | Full-text search over stored event history |
| `vrchat_eventsStatus` | Socket state and per-type retention |

The last four appear only with `VRCHAT_MCP_WEBSOCKET=1`.

## Install

`bun link` puts a `vrchat-mcp` executable on your PATH, so nothing downstream needs to know
where the checkout lives.

```bash
bun install
bun link          # from the repo root
```

Register it by name:

```bash
claude mcp add vrchat -- vrchat-mcp
```

Or for Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vrchat": {
      "command": "vrchat-mcp"
    }
  }
}
```

That is the whole config. Credentials come from the repo's `.env`, so they do not have to be
repeated here, though anything you put in an `env` block wins. Remove the command with
`bun unlink`.

If you would rather not put anything on your PATH, point at the entry file with an absolute
path. The server is spawned from an arbitrary working directory, so a relative one will not do.

```bash
claude mcp add vrchat -- bun run /abs/path/to/vrchat-mcp/src/index.ts
```

## The contact requirement

VRChat rejects generic User-Agents with a 403. `VRCHAT_CONTACT` goes into the descriptive
User-Agent the SDK sends on every request, API and WebSocket alike, and it is effectively
mandatory.

The value has to be real. The SDK refuses any contact containing `@example.com`, so the obvious
placeholder is the one value guaranteed to fail. The server reports that as a configuration
error on the first tool call rather than letting it surface as a mysterious 403.

## Configuration

Three layers, highest priority first. A project can set its own options without repeating your
credentials.

1. Real environment variables, including an MCP client's `env` block
2. `.env` in the directory the command runs from, which Bun loads automatically
3. `.env` at the repo root

So a project that wants storefront tools only, using credentials you already configured, needs
one line next to it:

```bash
# ~/my-project/.env
VRCHAT_MCP_TAGS=store
```

| Variable | Default | Effect |
|---|---|---|
| `VRCHAT_USERNAME` | none | Account username or email |
| `VRCHAT_PASSWORD` | none | Account password |
| `VRCHAT_TOTP_SECRET` | none | Base32 TOTP secret. Set it and login never prompts |
| `VRCHAT_CONTACT` | none | Contact string in the User-Agent. Effectively required |
| `VRCHAT_MCP_TAGS` | all | Tags to register. `everything` for no filter |
| `VRCHAT_MCP_ALLOW_WRITES` | off | Creating and editing |
| `VRCHAT_MCP_ALLOW_DESTRUCTIVE_WRITES` | off | Deleting and moderating. Needs the write gate too |
| `VRCHAT_MCP_ALLOW_PURCHASES` | off | Spending balance. Needs the write gate too |
| `VRCHAT_MCP_ALLOW_ADMIN` | off | Admin operations. Independent of the write gate |
| `VRCHAT_MCP_RPS` | 20 | Requests per second. `0` falls back to 20, there is no off |
| `VRCHAT_MCP_MAX_WAIT_MS` | 30000 | How long a call waits behind the limiter before giving up |
| `VRCHAT_MCP_WEBSOCKET` | off | Opens the event pipeline and registers the event tools |
| `VRCHAT_MCP_WS_EVENTS` | low-noise set | Event types to subscribe to. Replaces the default, does not extend it |
| `VRCHAT_MCP_HISTORY` | 1000 | Events kept per type. Per-type overrides: `1000,friend-location:200` |
| `VRCHAT_MCP_HISTORY_MAX_AGE` | 30d | Age ceiling. `0` disables. Accepts `ms s m h d w` |
| `VRCHAT_MCP_DB` | project `.vrchat-mcp/events.db` | Event database path |
| `VRCHAT_MCP_SESSION` | project `.vrchat-mcp/session.json` | Session file path |
| `VRCHAT_MCP_PROXY` | none | HTTP or HTTPS proxy for API and WebSocket traffic |
| `VRCHAT_MCP_2FA_TIMEOUT_MS` | 300000 | How long a parked login waits for a code |
| `VRCHAT_LIVE_TESTS` | off | Opts into the live test suite |

Booleans accept `1` or `true`, case-insensitive.

### Where state lives

State is per project. Run the server inside a project and its session and event history live in
that project's `.vrchat-mcp/`. The project root is found by walking up from the working
directory for a `.git`, `package.json`, `deno.json`, `pyproject.toml` or `go.mod`, so launching
from a subdirectory reaches the same state instead of stranding a second session a level down.

The directory hides itself from version control: `vrchat-mcp` writes a `.gitignore` containing
`*` inside it on creation, so the session file, which is an auth credential, is protected
without the host project needing a rule for it.

Each project therefore logs in separately, and the first call in a new project may ask for a
2FA code. To share one login everywhere, point every install at the same file:

```bash
VRCHAT_MCP_SESSION=/abs/path/to/shared/session.json
```

## Safety gates

The server starts read-only. 150 of the 297 operations register by default. Nothing that
writes, deletes, spends or moderates appears until you ask for it.

| Class | What it covers | Needs | Examples |
|---|---|---|---|
| `read` | Every `GET` | nothing | `getCurrentUser`, `searchWorlds` |
| `write` | `POST` / `PUT` / `PATCH` | `ALLOW_WRITES` | `createInstance`, `updateWorld`, `updateProduct` |
| `destructive` | Every `DELETE`, plus an override list | `ALLOW_WRITES` and `ALLOW_DESTRUCTIVE_WRITES` | `deleteProduct`, `banGroupMember`, `kickGroupMember`, `closeInstance` |
| `money` | Buying, and Tilia/KYC/payout paths | `ALLOW_WRITES` and `ALLOW_PURCHASES` | `purchaseProductListing`, `getEconomyPayouts`, `getUserTiliaKyc` |
| `admin` | Admin and account lifecycle | `ALLOW_ADMIN` | `deleteUser`, `registerUserAccount`, moderation reports |

Destructive and money layer on top of writes, so enabling writes grants exactly the ability to
create and edit, never to delete or to spend. Admin stands alone and is implied by nothing:
letting an agent edit your own content must never also let it delete the account.

What you are opting into:

- `ALLOW_WRITES` lets an agent create and change things you own. Reversible, mostly by hand.
- `ALLOW_DESTRUCTIVE_WRITES` adds the calls with no undo. Deletes, bans, kicks, closing
  instances, wiping user persistence.
- `ALLOW_PURCHASES` lets an agent spend real balance. `purchaseProductListing` is a live
  transaction. Do not set this because a tool listing looked incomplete.
- `ALLOW_ADMIN` exposes `deleteUser` among others. Most of these 403 on a normal account, but
  `deleteUser` is the one that must never be an accident.

Gated operations stay in the generated table either way, so coverage remains 1:1 with the spec
and the denylist is reviewable in the diff. MCP annotations (`readOnlyHint`, `destructiveHint`)
are set as well, so clients that surface them can prompt.

## Which tools am I missing?

A gated tool is simply absent, which reads as "VRChat cannot do this" rather than "this server
was told not to". That mistake has already been made in the wild: an agent reported the economy
API as read-only when the write tools existed and were merely behind a flag.

`vrchat_authStatus` closes the gap. It reports every tag and safety class, how many operations
each holds, how many are currently exposed, and the exact `.env` change that would expose the
rest.

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

## Choosing which tools to expose

`VRCHAT_MCP_TAGS` selects tags. Unset registers everything, and `everything` says so
explicitly, which is easier than deleting a key from a JSON config. `all` and `*` work too.

```bash
VRCHAT_MCP_TAGS=everything          # all 297 operations
VRCHAT_MCP_TAGS=store               # just the storefront, 19 operations
VRCHAT_MCP_TAGS=store,users,worlds  # matches any of the three
```

Spec tags: `authentication`, `avatars`, `calendar`, `economy`, `favorites`, `files`, `friends`,
`groups`, `instances`, `inventory`, `invite`, `jams`, `miscellaneous`, `notifications`,
`playermoderation`, `prints`, `props`, `users`, `worlds`. Plus `store`, which this server adds.

A tag matching nothing is warned about on stderr at startup and reported by
`vrchat_authStatus`. Without that, a typo like `stores` registers no generated tools and looks
exactly like a broken server.

## Logging in

Login is lazy. Nothing authenticates at startup, so `tools/list` works with no credentials at
all and the server stays inspectable. The first tool call that needs a session triggers the
login.

With `VRCHAT_TOTP_SECRET` set, that is the whole story. No prompts, ever.

Without it, VRChat emails a code and the call comes back parked rather than hanging:

```
vrchat__getCurrentUser
  -> Login paused: VRChat emailed a code. Ask the user for it, call
     vrchat_submitTwoFactorCode { requestId: 'a1b2c3d4', code: '……' },
     then retry the original call.
```

Answer it with `vrchat_submitTwoFactorCode`, then retry. The session persists, so this happens
once per project until it expires.

### Logging in from a new network

Changing proxy, VPN or ISP triggers a check that is not a two-factor code, and the two look
alike enough to waste real time. VRChat answers with one of these:

```
401  It looks like you're logging in from somewhere new! Check your email for a message from VRChat.
429  Logging in from too many places? Check your email for verification link
```

Both mean the same thing, and neither is what it looks like. The email holds a link, not a
six-digit code, so `vrchat_submitTwoFactorCode` cannot help. The login takes two rounds:

1. A tool call fails with one of those messages
2. The user opens the link in the email
3. Call `vrchat_retryLogin`. VRChat sends the actual code only on this second attempt
4. The user reads the code out, call `vrchat_submitTwoFactorCode`
5. Retry the original tool

The 429 is an auth challenge wearing a rate-limit status, so the local limiter ignores it.
Waiting does not clear it, and every extra attempt costs one of the account's limited session
slots, which is what produces the 429 in the first place. A failed login is cached for 30
seconds so a burst of tool calls cannot become a burst of login attempts. `vrchat_retryLogin`
clears that cache, because by then the user has done the thing the failure was waiting on.

### Parallel calls during login

Agents fan tools out at once, and on a cold start they all land on an unauthenticated client.
One call drives the login. The others wait up to three seconds and then return `login_pending`
rather than blocking, so a slow login stalls one tool call instead of every tool call, and a
login that parks on a code raises one prompt instead of several.

## `_responseKeys`

Every tool takes `_responseKeys`, and every tool returns the raw upstream payload by default.
There is no server-side curation, because a hand-picked field list guesses what matters, is
wrong for whoever needed the other field, and has to be maintained for 297 operations against a
spec that moves. The agent knows what it wants on this call. It should say so.

A `World` object is roughly 4 KB. Narrowing usually cuts that by more than half.

| Pattern | Selects |
|---|---|
| `["*"]` | the whole payload, byte for byte |
| `["id","name"]` | those top-level fields |
| `["author.displayName"]` | a nested path |
| `["*.id"]` | `id` from every element of a top-level array |
| `["items.*.name"]` | that field from every element of `items` |
| `["unityPackages.*.**"]` | everything below each element |
| `["!description"]` | excludes, and combines with `["*"]` |

Projection keeps the shape. Objects stay nested, arrays keep their order and length, so a path
learned on one call still works on the next.

Discovery matters more than the projection. An agent cannot ask for keys it does not know
exist, and a silently empty result would make this design worse than trimming. So a path that
matches nothing comes back as `_unmatched`, alongside `_availableKeys` listing what was
actually there. Array element keys are named as `*.id`, `*.name`, the form that works as a
`_responseKeys` entry.

`["*"]` returns the input by reference, so the raw path is provably lossless and nothing is
ever hidden.

## Viewing images

`vrchat_getImage` downloads a VRChat image and returns it as an image block, so the model can
look at it rather than report a URL.

```json
{ "name": "vrchat_getImage",
  "arguments": { "url": "https://api.vrchat.cloud/api/1/file/file_.../1/256" } }
```

Pass any `imageUrl` or `thumbnailImageUrl` from a user, world, avatar, print or product, or
pass `fileId` and let the tool build the URL. `savePath` also writes the bytes to disk.

Prefer a URL ending in `/256` or `/512` when one exists. The image is carried as base64, so a
full-size texture costs a lot of context and buys no extra detail. Anything over 4 MB is
refused; raise `maxBytes` if you mean it.

The tool only fetches VRChat-hosted images, and only `api.vrchat.cloud` is ever sent your
session cookie. A tool that fetches a caller-supplied URL while holding a session is a
request-forgery primitive unless it is constrained, and a cookie sent to a CDN is a cookie
given away.

## Uploading files

Pass a local file path. The server runs on your machine and reads the file itself, so file
contents never enter the conversation. Inlining a 2 MB PNG as base64 would cost roughly 2.7 MB
of tool arguments, more than everything else in the call combined.

Eight operations take a file directly, one call each:

| Tool | Field | For |
|---|---|---|
| `vrchat__uploadImage` | `file` | Icons, gallery, emoji, stickers, product images (`tag` picks which) |
| `vrchat__uploadPrint` | `image` | Prints |
| `vrchat__uploadIcon` | `file` | Profile icons |
| `vrchat__uploadGalleryImage` | `file` | Gallery |
| `vrchat__editPrint` | `image` | Replacing a print's image |
| `vrchat__inviteUserWithPhoto` | `image` | Invite photos |
| `vrchat__requestInviteWithPhoto` | `image` | Invite requests |
| `vrchat__respondInviteWithPhoto` | `image` | Invite responses |

```json
{ "name": "vrchat__uploadImage",
  "arguments": { "file": "C:/Users/me/Pictures/icon.png", "tag": "icon" } }
```

The result names the bytes that were sent, which is the only way to tell a successful upload of
the right file from a successful upload of the wrong one.

For everything else, `vrchat_uploadFile` runs VRChat's four-step sequence (create the record,
request a presigned URL, transfer the bytes, finish) and returns the completed file record. Use
it for asset bundles and unity packages. The bytes go straight to VRChat's storage provider
with a plain request, deliberately not through the API client, because that client attaches
your session cookie to everything it sends and the storage host is a third party.

Uploads are writes, so all of this needs `VRCHAT_MCP_ALLOW_WRITES=1`. Files are capped at
100 MB, and an empty file is refused before it reaches VRChat, which would otherwise store a
broken record. If `vrchat_uploadFile` fails partway it names the file record it created, so you
can inspect it with `vrchat__getFile` and remove it with `vrchat__deleteFile`.

## Running a store

Managing a storefront is an ordinary write, not a `money` operation. Creating a product,
renaming it, changing its image, publishing or unpublishing a listing: none of these spend or
earn anything, so they need only `VRCHAT_MCP_ALLOW_WRITES=1`. The `money` gate is for buying
and for the payment processor.

```bash
VRCHAT_MCP_TAGS=store
VRCHAT_MCP_ALLOW_WRITES=1
```

Setting a product image takes one call:

```json
{ "name": "vrchat_setProductImage",
  "arguments": { "productId": "prod_...", "path": "/abs/path/cover.png" } }
```

That uploads with `tag: "product"` and attaches the returned file id as the product's
`imageId`. By hand it is `vrchat__uploadImage` with `tag: "product"` or `"listinggallery"`,
then `vrchat__updateProduct` with the id it returns.

One thing VRChat itself does not allow: a listing exposes only `active` for editing, so its
price, title and description cannot be changed after creation. Delete the listing and create a
new one. The name, description and image live on the product and are editable through
`vrchat__updateProduct`.

## Pagination

One page per call. Paginated tools default to 25 results and echo back a `nextOffset` to
continue with. There is no internal pagination loop, deliberately: a hidden auto-paginate would
burn the request budget and a large slice of context inside what looks to the agent like a
single call.

A short page means the end. VRChat reports no total, so that is the only reliable signal.

## WebSocket events

Off by default, because an idle always-on socket burns a session slot. Set
`VRCHAT_MCP_WEBSOCKET=1` to open it and register the four `vrchat_events*` tools.

`VRCHAT_MCP_WS_EVENTS` picks which types to subscribe to, replacing rather than extending the
default set of `notification`, `notification-v2`, `economy-update`, `friend-online`,
`friend-offline` and `instance-queue-ready`.

Pipeline messages are double-encoded: the `content` field is stringified JSON needing a second
parse, except for `see-notification` and `hide-notification`, which carry bare ids. All of that
is normalised once at ingest, so no tool ever hands you a JSON string inside JSON. The SDK's
own socket silently drops those two message types, which is one reason this server does not use
it. The other is that it takes no proxy.

### Retention is per type

History goes to SQLite at `.vrchat-mcp/events.db`, and it keeps 1000 events per event *type*,
not 1000 in total. A chatty type like `friend-location` can never evict a rare, valuable one
like `economy-update`, which a single global cap would do within minutes.

```bash
VRCHAT_MCP_HISTORY=1000,friend-location:200,economy-update:5000
VRCHAT_MCP_HISTORY_MAX_AGE=7d
```

An age ceiling runs alongside the count cap, and whichever bites first wins. Count alone lets a
rarely-fired type sit on months-old events that read as current. Age alone lets a burst blow up
the database. `vrchat_eventsStatus` reports which limit is currently binding, per type, so the
window is legible instead of silent.

History survives restarts, so `vrchat_eventsSearch` can answer what happened while you were
away. A live-only buffer cannot.

## Proxy

`VRCHAT_MCP_PROXY` routes traffic through an HTTP or HTTPS proxy, with optional `user:pass@`
credentials.

```bash
VRCHAT_MCP_PROXY=http://127.0.0.1:8080
VRCHAT_MCP_PROXY=https://user:pass@proxy.internal:8443
```

SOCKS is not supported. Bun's fetch rejects `socks5://` outright, so a SOCKS URL fails at
startup with a configuration error naming the limitation rather than half-working. Front it
with a local HTTP proxy instead.

The proxy covers both API and WebSocket traffic. The two go through different mechanisms, and
the failure mode of getting only half of it right is a server that looks proxied while leaking
its real IP on the event stream.

If the proxy cannot be reached, calls fail with a clear error. The server never silently falls
back to a direct connection, because for anyone using this for IP separation that is the worst
possible outcome. The proxy URL is never logged, since it may embed credentials.

## Development

```bash
bun link                    # install the vrchat-mcp command on PATH
bun unlink                  # remove it
bun run generate            # regenerate tools from the latest upstream spec
bun run generate --offline  # regenerate from the committed snapshot, no network
bun test                    # offline suite
bun run test:live           # live suite, needs VRCHAT_LIVE_TESTS=1
bun run inspect             # MCP Inspector against this server
bun run typecheck           # tsc --noEmit
```

`bun run generate` fetches `vrchatapi/specification` at `main`, bundles it, and writes the
bundled spec plus `spec/VERSION.json` (upstream SHA, timestamp, content hash) alongside the
regenerated `src/generated/operations.ts`. Both are committed, so every regeneration produces
two reviewable diffs, the spec change and the tool change it caused, and a bad upstream commit
is revertible rather than load-bearing. `--offline` reproduces the output from the committed
snapshot byte for byte with no network at all.

`src/generated/operations.ts` is generated. Do not edit it by hand.

Ten operationIds have no matching method in the VRChat SDK, because the spec moves faster than
the client library. Those route through a raw-request fallback on the same client, so cookies,
User-Agent, proxy and rate limiting still apply, and 1:1 coverage stays true instead of quietly
becoming a lie. Codegen prints the list on every run.

stdout is the JSON-RPC channel. All logging goes to stderr, and one stray `console.log`
corrupts the protocol stream.

## Testing

`bun test` is the offline suite: codegen output, gating, the rate limiter against a fake clock,
history retention and search, projection, error mapping, upload path handling. No network, no
credentials, no account. This is what runs by default.

`bun run test:live` hits a real account, opted into with `VRCHAT_LIVE_TESTS=1` and skipped
otherwise. Rules it holds itself to:

- Reads and creator-owned writes only. It hard-refuses anything classified `money` or `admin`,
  before a client is even constructed. A test suite must not be able to spend money.
- Every write cleans up after itself and is tagged so stray artifacts are identifiable in-game.
- It routes through the same limiter as production and stays small. A run that trips VRChat's
  throttling is worse than no run.
- Assertions are on shape and status, never volatile content. Friend counts and world listings
  move between runs.
- Use a dedicated account where you can. Credentials come from `.env` only.

## Security

- `.env` and `.vrchat-mcp/` are gitignored, and `.vrchat-mcp/` also ignores itself from within
  so it stays hidden inside other projects.
- `.vrchat-mcp/session.json` is an auth credential, a valid session cookie. Treat it like a
  password. Deleting it, or calling `vrchat_logout`, forces a fresh login.
- 2FA codes, passwords, TOTP secrets and proxy URLs are never logged, including to stderr.
- Your session cookie goes to `api.vrchat.cloud` and nowhere else. Uploads to VRChat's storage
  provider and image fetches from its CDN deliberately bypass the authenticated client.
- Errors come back as structured results carrying status, VRChat's own message, and an
  actionable hint. Raw exceptions and stack traces never reach the transcript.
- stdio only, local only. No HTTP transport, no multi-user credential isolation. This server is
  for one account on one machine.

## Project layout

```text
scripts/generate-tools.ts     # build-time codegen: spec -> src/generated/operations.ts
spec/openapi.bundled.json     # committed snapshot of the upstream spec
spec/VERSION.json             # upstream SHA + fetch timestamp + content hash
src/config.ts                 # the entire env surface, read once
src/types.ts                  # shared contracts
src/generated/operations.ts   # committed, generated, 297 entries, do not edit
src/vrchat/client.ts          # lazily-authed VRChat client, proxy, 2FA sniffing
src/vrchat/twofactor.ts       # pending-code broker
src/vrchat/ratelimit.ts       # token bucket + global 429 backoff
src/vrchat/events.ts          # websocket client + waiter registry
src/vrchat/history.ts         # bun:sqlite event store, per-type retention + FTS5 search
src/tools/auth.ts             # authStatus / submitTwoFactorCode / retryLogin / logout
src/tools/images.ts           # getImage
src/tools/upload.ts           # uploadFile / setProductImage
src/tools/events.ts           # eventsRecent / eventsWait / eventsSearch / eventsStatus
src/registry.ts               # gating, registration, the one shared handler
src/project.ts                # _responseKeys path projection
src/upload.ts                 # local path -> File, with size and type guards
src/errors.ts                 # HTTP status -> structured tool error with hint
src/index.ts                  # serveStdio entry point
tests/                        # offline suite; tests/live/ is the opt-in live suite
docs/PLAN.md                  # design document
PROGRESS.md                   # build status and verified SDK behaviour
```

## License

See [LICENSE](LICENSE).
