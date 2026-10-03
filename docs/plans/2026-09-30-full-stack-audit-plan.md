# Full-stack audit plan — security, privacy, abuse resistance, and efficiency

Status: complete. All phases (0–6) finished between 2026-09-30 and 2026-10-02. The summary
and order of work are in [the report](../audits/full-stack-audit-report-2026-10-02.md), and
the findings and fixes in [the audit record](../audits/full-stack-audit-2026-09-30.md).

The leads in [Survey leads](#survey-leads-unverified) came from a planning read of the
code and are not findings until the matching workstream confirms them.

## Scope

| Surface | Code | Notes |
| --- | --- | --- |
| Cloudflare Worker | `worker/`, `wrangler.toml` | Serves the PWA and `/api/*`: devices, reminders, voice, link preview, NIP-05, Watch Nostr bridge. D1, 4 KV namespaces, a one-minute cron. |
| Push server | `taskify-push-relay/` | Node 22 NIP-17 inbox relay, APNs sender, Watch gateway; packaged for StartOS (`startos/`) and Docker. |
| PWA | `taskify-pwa/` | React 19 / Vite 7, service worker, Cashu and NWC wallet, DMs. |
| Native iOS | `taskify-ios-native/` | App plus Widgets, Notification Service, Share extension, Watch app, Watch widgets. |
| iPad | same target as iOS (`TARGETED_DEVICE_FAMILY = 1,2`) | No separate code; audited for layout, input, and multitasking behaviour. |
| macOS | `taskify-macos/` | Sandboxed SwiftUI app that compiles a subset of the iOS sources. |
| CLI | `taskify-cli/` | Node CLI with an agent mode; also ships the `.openclaw` skill. |
| Shared libraries | `taskify-core/`, `taskify-runtime-nostr/` | Contracts and the Nostr session, publish, and outbox runtime used by the PWA and CLI. |

Three questions are asked of every surface:

1. **Security and privacy** — can someone read, forge, or spend what they should not, and what does each party learn about a user?
2. **Abuse resistance** — what can an unauthenticated or hostile-but-authenticated party make us pay for, store, send, or get banned for?
3. **Efficiency** — where do performance, UI/UX, or maintainability costs justify a refactor?

Out of scope: third-party relays, mints, and file hosts themselves (only how Taskify
trusts them), and the deprecated bounty feature except for confirming that it cannot be
reached.

## Ground rules

- **Read-only until reported.** Workstreams produce findings, not fixes. Any change that
  affects privacy or security is proposed and approved before it is implemented, as in
  earlier plans in this directory.
- **No hostile traffic at production or third parties.** Abuse and load tests run against
  `wrangler dev` and a local push-relay instance with a throwaway data directory. Production
  (`taskify.solife.me`, `push.solife.me`, `relay.solife.me`) is only observed: response
  headers, TLS, and the behaviour of a single well-formed request.
- **No real keys or funds.** Test accounts and test mints only. macOS development builds
  run against a separate container, never the user's data.
- **Verify, then write it down.** A finding needs a file and line, a concrete scenario
  (input or state → bad outcome), and either a reproduction or a statement that it was not
  reproduced. Prior audits are evidence to re-check, not facts to repeat.
- **Red checks are findings.** A failing test, `tsc`, lint, or build step found along the
  way is recorded even when unrelated to the workstream.

### Severity

| Level | Meaning |
| --- | --- |
| P0 | Key or fund loss, account takeover, remote code execution, or plaintext exposure of private content; exploitable now. |
| P1 | Meaningful privacy leak, authentication or authorization bypass with limited reach, or abuse that costs money or gets shared infrastructure banned. |
| P2 | Defence-in-depth gap, hard-to-reach bug, or a performance or UX problem users will notice. |
| P3 | Hygiene, maintainability, or an improvement with no current user impact. |

### Finding format

```
ID · severity · surface · category (security | privacy | abuse | performance | ux | refactor)
Where:     path:line
Scenario:  input or state → outcome
Evidence:  reproduction, test, measurement, or "read only, not reproduced"
Fix:       smallest change that closes it; note if it needs approval or a migration
```

## Phase 0 — Baseline (do first, about half a day)

Produces the facts every later phase relies on.

1. **Build and test status per package.** Run each package's own `test` and `build`
   scripts (`worker`, `taskify-push-relay`, `taskify-cli`, `taskify-core`,
   `taskify-runtime-nostr`, `taskify-pwa`), the Swift package tests for iOS and macOS with
   a scratch path outside the repository, and an Xcode build of every target. Record what
   is red before anything else is touched.
2. **Dependency inventory.** `npm audit` and an OSV scan over all six lockfiles; review
   both `Package.resolved` files (notably `cdk-swift`, `swift-secp256k1`, `CryptoSwift`,
   `URKit` pinned by revision only). Note every dependency that handles keys, parses
   untrusted documents (`mammoth`, `pdfjs-dist`, `read-excel-file`, `jszip`,
   `markdown-it`, `link-preview-js`), or talks to relays.
3. **Secret scan.** Run a secret scanner across the working tree and the full git
   history; confirm `.dev.vars`, `.p8` keys, and `APNS_CONFIG_PATH` files are untracked.
4. **Data-flow inventory.** One table: each piece of user data, where it is stored, who
   it is sent to, and whether it is encrypted in transit and at rest. Seed it from the
   host list the code contacts: Taskify Worker, push relay, Nostr relays, `nostr.build`,
   `blossom.band`, `originless.solife.me`, IPFS gateways, mints, `npub.cash`,
   `api.coinbase.com`, `noembed.com`, YouTube and Etsy oEmbed, Google, Gemini, Cloudflare
   AI, OpenAI (CLI agent), and APNs. This table is the privacy audit's backbone and is
   later checked against `taskify-pwa/public/privacy` and the App Store privacy answers.
5. **Trust-boundary map.** For each surface, list the entry points that accept untrusted
   input: HTTP routes, WebSocket messages, Nostr events from relays and board members, DMs
   from strangers, QR codes, deep links (`taskify://`), share-sheet items, pasted text,
   opened documents, push payloads, and agent command input.
6. **Pipeline check.** There is no `.github/workflows`; record what currently gates a
   release (nothing automated) so Phase 6 can propose a minimum CI.

## Phase 1 — Servers (highest exposure)

### 1A. Cloudflare Worker

Files: `worker/src/index.ts`, `nostr-auth.ts`, `reminders.ts`, `voice.ts`, `preview.ts`,
`public-fetch.ts`, `nip05.ts`, `nostr-bridge.ts`, `lib.ts`, `worker/migrations/`,
`wrangler.toml`.

Build a route table first — method, path, authentication, rate limit, body cap, what it
writes, what it fetches — then work through:

- **Request authentication** (`verifyTaskifyAuth`): what the signature covers, replay
  window, reuse of one signature across routes, clock skew, and whether the authenticated
  key is bound to the resource being acted on.
- **Device and reminder routes**: the capability model (`deviceId` plus endpoint hash),
  whether one client can overwrite, read, or delete another's reminders, and what an
  unauthenticated caller can write into D1 and KV. Trace the cron path
  (`processDueReminders`) for unbounded work per tick.
- **Server-side fetchers** (`/api/preview`, `/api/nip05`, Watch bridge): SSRF through IP
  literals, redirects, DNS, and alternative encodings; response size and time caps; whether
  any upstream response is reflected in a way that enables cache poisoning or content
  injection in clients. Compare against the push relay's DNS-pinned lookup.
- **Voice routes**: prompt injection, quota accounting under concurrency, cost per request
  against the limits, which provider sees the transcript, and what is logged (observability
  logging is on).
- **Watch Nostr bridge**: whether it can be used as a relay-spam proxy that gets the shared
  Worker egress addresses banned; filter and event bounds; which kinds it will publish.
- **Response hygiene**: security headers on assets and API responses, CORS scope, error
  bodies, caching of authenticated responses.
- **Deployment configuration**: `workers_dev` and `preview_urls` exposing production
  bindings on extra origins, secret placement, KV/D1 legacy dual paths, runtime DDL versus
  migrations, rate-limit bindings that silently disable when absent.
- **Data retained**: every D1 column and KV value, its retention, and whether it needs to
  exist in plaintext.

Exit: route table complete; every route has an explicit answer for authentication, limit,
and worst-case cost; abuse scenarios tested locally.

### 1B. Push server

Files: `taskify-push-relay/src/server.js`, `auth.js`, `relay-policy.js`,
`relay-forwarder.js`, `store.js`, `apns.js`, `config.js`, `Dockerfile`, `startos/`.

- **NIP-98 and NIP-42**: URL and payload binding, freshness, replay-guard capacity and
  eviction, behaviour across restarts, and the account-mismatch checks on Watch sessions.
- **Registration**: can a caller attach their device token to someone else's key, or
  remove someone else's registration; token validation; registration count per key.
- **Relay policy**: only kind 1059 accepted and served to the authenticated recipient;
  filter limits; subscription and connection counts per socket and per address.
- **Push as an abuse vector**: anyone can address a gift wrap to a registered key. Measure
  how many APNs pushes one sender can cause for one recipient and in total, and what APNs
  throttling or token invalidation does to legitimate delivery.
- **Preview capability URLs** (`/v1/previews/<token>`): entropy, lifetime, single use,
  what the response reveals, and what the APNs payload itself reveals to Apple.
- **Watch gateway and forwarder**: outbound target validation, DNS pinning, per-account
  and per-address limits (and whether the address is the client's or the proxy's),
  concurrency caps, and whether it can be turned against third-party relays.
- **Storage**: what `state.json` holds (device tokens mapped to public keys, gift wraps,
  task events), file modes, retention, growth bounds, and write cost as it grows.
- **Runtime hardening**: container user, body and frame limits, slow-client handling,
  error-to-status mapping, log contents, StartOS interface exposure and the APNs
  configuration action.

Exit: a per-endpoint limit table, a measured worst-case push fan-out, and a statement of
exactly what the operator of this server can learn about a user.

## Phase 2 — Protocol, cryptography, and wallet (shared by all clients)

Audited once here, then each client is checked for conformance in Phase 3.

- **Inbound event trust.** Every path that accepts a Nostr event: is the signature
  verified, is the author authorised for that board or thread, and are size, tag, and
  timestamp bounds enforced? Covers TypeScript (`taskify-runtime-nostr`,
  `taskify-pwa/src/nostr`, `taskify-cli/src/nostrRuntime.ts`) and Swift
  (`TaskifyCore/Nostr`, `TaskifyCore/Sync`, the Watch crypto in `TaskifyWatchShared`).
- **Hostile relay and hostile member models.** Replay of old replaceable events, future
  timestamps, flooding, oversized payloads, false end-of-stream, tombstone spam, and
  malformed content reaching decoders (`TaskEventCodec`, `calendarDecode`, `shareContracts`).
- **Encryption.** Board key derivation and what holding a board ID grants; NIP-44, NIP-17,
  and NIP-59 usage including gift-wrap timestamp randomisation and the intentional
  fallback DM policy; attachment encryption on every client; account backup encryption.
- **Metadata.** What relays and file hosts can correlate: keys, board identifiers, timing,
  network address, relay lists, profile lookups.
- **Wallet.** Cashu proof handling, seed and counter storage, token exposure in DMs and on
  the clipboard, mint trust, NWC connection-string storage and permissions, sweep journal
  crash safety, amount and unit parsing, lightning-address and LNURL resolution, payment
  request handling. Re-check the open items in `docs/audits/solife-ecash-receive-audit-2026-09-22.md`.
- **Cross-client consistency.** The same rule implemented four times (PWA, CLI, Swift,
  Watch) is where divergence hides; diff the behaviours, not the code.

Exit: a conformance checklist that Phase 3 applies to each client.

## Phase 3 — Clients

Each client gets the Phase 2 checklist plus the items below.

### 3A. PWA

- **Secrets at rest**: the Nostr key (wrapped key plus the plaintext fallback path), the
  wallet seed, NWC connection strings, and cached DMs and contacts in `localStorage` and
  IndexedDB; what any script running in the origin can reach.
- **Script injection**: every HTML sink (`dangerouslySetInnerHTML`, `document.write` in the
  print paths, `innerHTML`), the sanitiser configuration, document viewers (docx, xlsx,
  PDF, markdown), link-preview rendering, profile fields, and URL handling (`javascript:`,
  `data:`). No Content-Security-Policy exists today; design one as part of the finding.
- **Service worker** (`public/sw.js`): cache scope, message handler origin checks, the
  configurable API base, push payload handling, notification click targets, update flow.
- **Entry points**: query parameters, token and payment-request URL parsing, QR payloads,
  agent mode (`?agent=1`) and whatever programmatic surface it exposes, file imports.
- **Third-party requests**: which hosts the browser contacts directly (revealing the
  user's address) versus through the Worker.

### 3B. Native iOS, Watch, and extensions

- **Keychain and files**: accessibility class per item, access groups shared with the
  Notification Service and Share extensions, synchronisation flags, file-protection class
  for every store (several wallet and snapshot writes use "until first unlock"), app-group
  container contents, and backup exclusion.
- **Extension least privilege**: what the Share extension, Notification Service, widgets,
  and Watch app can each read; whether any of them need the signing key.
- **Entry points**: `taskify://` handling in `RootTabView`, user activities, share-sheet
  items, notification actions, App Intents and the Siri reminder schema, QR scanning,
  pasteboard reads, document import and preview.
- **Exposure**: log statements and their privacy annotations, pasteboard writes for
  secrets and tokens (expiry and local-only flags), app-switcher snapshots, widget and
  lock-screen content, notification previews, Spotlight and Siri donation.
- **Platform compliance**: privacy manifests for every target, permission strings versus
  actual use, export-compliance declaration, App Transport Security exceptions.
- **Concurrency**: the targets build in Swift 5 mode; review shared mutable state in
  `AppModel`, `TaskSyncEngine`, and the wallet service for data races.
- **Watch**: independent client path through the Worker bridge and push gateway, what is
  stored on the watch, and behaviour when the phone is absent.

### 3C. iPad

Security is inherited from 3B; this workstream is behavioural, on a simulator and a device.

- Layout at every size class, in Split View, Slide Over, and Stage Manager resizing; all
  four orientations; whether screens use the width or stretch a phone layout.
- Single-scene limitation (`UIApplicationSupportsMultipleScenes` is false): decide whether
  multiple windows are wanted, and confirm state is sound either way.
- Hardware keyboard shortcuts and focus, pointer hover and context menus, drag and drop
  for tasks and attachments, popover versus sheet presentation, keyboard avoidance in chat.
- Shared-device considerations: what is visible on a family iPad without the wallet
  biometric gate.

### 3D. macOS

- **Sandbox and signing**: entitlements are minimal today (network client, user-selected
  files, calendars, microphone); confirm each is used, hardened runtime stays on, and
  note how the app is distributed and notarised.
- **Secrets**: where the Mac build stores the Nostr key and wallet material given it has
  no keychain access group or app group, and how `deviceOwnerAuthentication` gates reveal.
- **Entry points**: `taskify://` in `MacWorkspace`, drag and drop, file open panels and
  security-scoped access, printing, pasteboard.
- **Shared sources**: list exactly which iOS files the Mac target compiles; confirm iOS
  fixes reach it and that iOS-only assumptions (background modes, push) fail safely.
- **Desktop UX**: menus and shortcuts, window restoration, multiple windows, toolbar and
  sidebar conventions, performance with large boards.

### 3E. CLI

- **Secrets**: plaintext key in `~/.taskify-cli` (mode 0600), `TASKIFY_NSEC` and
  `TASKIFY_AGENT_API_KEY` in the environment, whether any command accepts a secret as an
  argument (shell history, process list), and redaction in every output path.
- **Agent mode**: task content from shared boards is untrusted text reaching a model that
  can call commands. Audit `agentDispatcher`, `agentSecurity` (trust modes, the loose npub
  check, the default of "moderate"), idempotency, and which commands are reachable without
  confirmation. Same for the `.openclaw` skill instructions.
- **Shell surface**: generated completion scripts interpolate cached board data; check for
  injection and for the cache path they read.
- **Files**: attachment download paths (traversal), attachment crypto, backup sync,
  profile import and export.
- **Distribution**: what `npm publish` would ship, committed `dist/` drift in
  `taskify-core` and `taskify-runtime-nostr`, install scripts.

## Phase 4 — Abuse and cost model (cross-cutting)

One table, one row per abusable resource, filled from Phases 1–3:

| Resource | Who can trigger | Current limit | Worst case per attacker | Who pays |
| --- | --- | --- | --- | --- |

Rows to include at minimum: voice LLM calls, link-preview fetches, NIP-05 lookups, Watch
bridge publishes and queries, D1 device and reminder rows, the per-minute cron, web-push
sends, APNs pushes per recipient, push-relay stored events, push-relay forwarder
connections, outbound publishes that count against Taskify's standing with public relays,
DM requests from unknown senders, shared-board writes by a hostile member, and uploads to
first-party file storage.

For each, decide whether the limit is per address, per key, or global; whether it survives
a restart; and whether exceeding it degrades the attacker or everyone. Re-use the relay
limits already measured in `docs/audits/relay-traffic-audit-2026-09-24.md` rather than
re-deriving them.

## Phase 5 — Performance, UX, and refactoring

Measure before proposing. Each candidate needs a number (time, bytes, renders, requests)
or a concrete user-visible defect.

- **PWA**: production bundle composition and lazy-loading of the document viewers and
  wallet; render counts and long tasks on board, Upcoming, and chat with a large data set;
  synchronous `localStorage` JSON blobs on hot paths (DM cache, tasks); service-worker
  caching effectiveness; Lighthouse and accessibility pass. Structural candidates by
  size: `App.tsx` (13.2k lines), `CashuWalletModal.tsx` (10.3k), `index.css` (10.1k),
  `EditModal.tsx` (3.0k).
- **iOS, iPad, macOS**: launch time, scroll hitches, main-thread hangs, and memory with
  Instruments on a device; snapshot and widget write frequency; relay connection and
  subscription counts at startup. Build on the existing scroll-performance UI tests and
  the September audits instead of repeating them. Structural candidates: `WalletView.swift`
  (8.7k), `AppModel.swift` (7.9k), `ChatView.swift` (6.3k), `BoardsView.swift` (4.2k),
  `SettingsView.swift` (3.7k).
- **Worker**: `preview.ts` (1.7k lines of site-specific scraping) and its upstream request
  count per preview; legacy KV paths beside D1; schema creation at request time; cron
  cost per tick.
- **Push server**: whole-file state rewrites, in-memory limiters and replay guard,
  `server.js` routing and its message-text-based status mapping.
- **Shared code**: logic duplicated across PWA, CLI, core, and Swift that should have one
  owner; status of the extraction plans already in `docs/plans/`.
- **UX**: first-run and key backup, recovery flows, wallet confirmations and error
  wording, offline and sync-state visibility, permission prompt timing, notification
  clarity, accessibility (Dynamic Type, VoiceOver, contrast, reduced motion, keyboard
  navigation), and parity gaps that confuse users who move between clients.

Exit: a ranked list where each item states the measured cost, the expected gain, the
risk, and whether it is a prerequisite for a security fix.

## Phase 6 — Report and remediation order

- One dated report in `docs/audits/`, grouped by surface, with the abuse table and the
  data-flow inventory as appendices; add it to `docs/README.md`.
- Remediation sequence: P0 and P1 security and privacy first (each with its approval
  request), then abuse limits, then measured performance work, then refactors. Anything
  needing a client release, a data migration, or a protocol change is called out because
  it cannot be fixed server-side alone.
- A minimum CI proposal: tests and type checks per package, dependency and secret
  scanning, and a Swift build.
- Reconcile `docs/plans/reliability-todo.md` — mark items the audit found done, still
  open, or superseded.

## Order and parallelism

Phase 0 first. Phases 1A, 1B, and 2 are independent and can run side by side; Phase 3
workstreams depend on the Phase 2 checklist but are independent of each other; Phase 4 is
assembled from 1–3; Phase 5 can start any time after Phase 0 because it shares no
findings with the security work. Suggested serial order if done by one person: 0 → 1A →
1B → 2 → 3A → 3B → 3E → 3D → 3C → 4 → 5 → 6.

## Survey leads (unverified)

Noticed while reading the code to write this plan. Each is a starting point for the named
workstream, not a confirmed defect.

| # | Lead | Where | Workstream |
| --- | --- | --- | --- |
| 1 | Request signature covers timestamp and body only — not method or path — with a 300-second window and no replay cache, so a captured signature may be reusable on another route. | `worker/src/nostr-auth.ts` (`verifyTaskifyAuth`) | 1A |
| 2 | Device and reminder routes have no account authentication and no rate-limit binding; an unauthenticated caller can create D1 rows that the cron then processes. | `worker/src/reminders.ts`, `worker/src/index.ts` | 1A, 4 |
| 3 | Reminder and pending-notification rows store task titles in plaintext on the server. | `worker/src/index.ts` schema, `worker/migrations/0001_init.sql` | 1A |
| 4 | Asset responses send `Permissions-Policy: camera=(), microphone=()` while the PWA has a camera QR scanner; either the scanner is blocked in production or the header is not doing what is intended. No CSP, HSTS, or framing header is set. | `worker/src/index.ts:120`, `taskify-pwa/src/ui/board/BoardQrScanner.tsx` | 1A, 3A |
| 5 | The IPv4-mapped IPv6 check expects dotted form, but URL parsing yields hex (`[::ffff:7f00:1]`), so that branch never matches; hostnames are checked as strings with no DNS resolution. Real exposure depends on Workers egress rules and the `global_fetch_strictly_public` flag. | `worker/src/public-fetch.ts` | 1A |
| 6 | The catch-all handler returns the raw error message to the client. | `worker/src/index.ts:208` | 1A |
| 7 | The Gemini key is passed in the request URL; check it cannot reach logs. | `worker/src/voice.ts:505` | 1A |
| 8 | `workers_dev` and `preview_urls` are enabled, exposing the API on additional origins. | `wrangler.toml` | 1A |
| 9 | Per-address limiter keys on the socket's remote address; behind a reverse proxy or tunnel every client may share one address. | `taskify-push-relay/src/server.js:209` | 1B, 4 |
| 10 | The container has no `USER` directive and runs as root. | `taskify-push-relay/Dockerfile` | 1B |
| 11 | Replay guard and rate limiters are in memory with oldest-first eviction at 10,000 entries; both reset on restart. | `taskify-push-relay/src/auth.js`, `server.js` | 1B |
| 12 | NWC connection strings (which authorise spending) are written to `localStorage` as plain JSON; confirm how the Cashu seed is stored beside them. | `taskify-pwa/src/wallet/nwcWalletCatalog.ts:50`, `wallet/seed.ts:93` | 3A |
| 13 | The Nostr key store falls back to plaintext `localStorage` when encryption is unavailable. | `taskify-pwa/src/lib/nostrSkStore.ts:191` | 3A |
| 14 | Print paths write DOM markup into a new window with `document.write`. | `taskify-pwa/src/App.tsx:2944`, `:4628` | 3A |
| 15 | No `PrivacyInfo.xcprivacy` is tracked for any Apple target. | `taskify-ios-native/`, `taskify-macos/` | 3B, 3D |
| 16 | A pending Cashu token is copied to the general pasteboard without the expiry and local-only flags used for the secret-key copy. | `taskify-ios-native/Sources/TaskifyApp/Features/Wallet/NWCWalletViews.swift:1015` | 3B |
| 17 | Custom `taskify://` scheme is handled on iOS and macOS; custom schemes can be claimed by other apps and invoked by any page. | `RootTabView.swift:60`, `MacWorkspace.swift:165` | 3B, 3D |
| 18 | Completion scripts read `~/.config/taskify/cache.json` while configuration lives in `~/.taskify-cli`. | `taskify-cli/src/completions.ts:298` | 3E |
| 19 | No CI workflows exist; tests, audits, and scans run only when someone remembers. | `.github/` | 0, 6 |

## Already covered elsewhere

Do not redo these; re-check their open items and link to them from the report.

- Relay traffic and publish budgets — `docs/audits/relay-traffic-audit-2026-09-24.md`
- Nostr sync pipeline — `docs/audits/nostr-sync-audit-2026-09-03.md`
- Task and DM history recovery — `docs/audits/pwa-client-history-sync-2026-09-11.md`
- Ecash receive and recovery — `docs/audits/solife-ecash-receive-audit-2026-09-22.md`
- Native board and device performance — `docs/audits/native-board-performance-2026-09-12.md`, `docs/audits/solife-performance-audit-2026-09-03.md`
