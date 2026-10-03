# Full-stack audit report — October 2, 2026

The audit covered the Cloudflare Worker, the push server, the PWA and its shared libraries, the
native iOS app with its extensions and Watch app, iPad behaviour, the macOS app, and the CLI. It
asked three questions of each:

- **Security and privacy:** who can read, forge, or spend what.
- **Abuse:** what a stranger can make Taskify pay for or break.
- **Efficiency:** what measurably costs time, bytes, or reliability.

It ran from September 30 to October 2, 2026, following
[the plan](../plans/2026-09-30-full-stack-audit-plan.md). Every finding, its reproduction, and
every fix are in [the running record](full-stack-audit-2026-09-30.md). This report is the
summary and the order of work.

**Nothing has been deployed.** Every "fixed" below means committed on `Beta`, which is 53 commits
ahead of `origin/Beta` at `4275b58e`. Production still has every issue the fixes address. The
first remediation step is therefore to deploy, in the order below.

## Where things stand

| Severity | Total | Fixed | Partly fixed | Maintainer | Open | Accepted | No action |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| P0 | 1 | 0 | 0 | 1 | 0 | 0 | 0 |
| P1 | 15 | 11 | 2 | 1 | 0 | 1 | 0 |
| P2 | 42 | 27 | 7 | 3 | 2 | 2 | 1 |
| P3 | 28 | 20 | 3 | 0 | 3 | 2 | 0 |
| **All** | **86** | **58** | **12** | **5** | **5** | **5** | **1** |

Status meanings:

- **Fixed:** committed and tested on `Beta`.
- **Partly fixed:** the part that could be done in code is done; the rest is listed in the
  finding.
- **Maintainer:** needs account access, a production change, or a decision only the maintainer
  can make.
- **Open:** code work not yet done.
- **Accepted:** the maintainer chose to leave it as it is.

The P0 and P1 items not yet closed:

- **F0-1** — leaked credentials. Rotation reported 2026-09-30.
- **F1A-16** — retired Google Calendar data may still be in D1. Needs a production check.
- **F1A-17** — the Worker's 100,000-requests-a-day allowance can be spent by anyone. Needs a
  Cloudflare rate rule on `/api/*`.
- **F1B-3** — alerts are capped at about six a minute per device. One HTTP/2 connection per
  push and no collapse ID remain.
- **F2-2** — old board ciphertext. Accepted.

## Order of work

| Step | What | Who | Needs |
| --- | --- | --- | --- |
| 0 | Cloudflare rate-limiting rules on `/api/*` and on `push.solife.me` (blunts F1A-17, F4-1, F4-3, F1B-4 before any deploy). Check for the retired calendar tables (F1A-16) and, if present, revoke the OAuth client and apply migration 0005. | maintainer | account access only |
| 1 | Deploy the Worker: apply D1 migrations 0006 and 0007, deploy (picks up `PUSH_RATE_LIMITER`), then `curl -I https://taskify.solife.me/` to confirm the CSP and HSTS headers. The PWA ships with it. | maintainer | D1 migration |
| 2 | Delete the `GEMINI_API_KEY` secret and revoke the key at Google (F1A-10). Older versions stay reachable at preview URLs (F1A-11(a), accepted), so revoking is what stops them. | maintainer | — |
| 3 | Build and install the push server's StartOS package `0.4.1:11` (sets `CLIENT_ADDRESS_HEADER=cf-connecting-ip`). | maintainer | — |
| 4 | Release the iOS, Watch, and Mac builds (v2 request signatures, signed previews, privacy manifests, keychain and clipboard fixes); publish the CLI. Confirm printing and the data protection keychain on a signed Mac build (F3D-2, F3D-3). | maintainer | client release |
| 5 | Configuration: turn off Worker invocation logs (F1A-9); move the VAPID key to a secret and delete its KV copy (F1A-11(b)); make the configured Worker name match `taskify-public` (F1A-11(e)); list the three legacy KV namespaces so the fallback can go (F5-3); add upload authentication or quotas to the Originless node (F4-4); review and publish the privacy policy (F0-7). | maintainer | — |
| 6 | Code, server only: limiters fail closed (F1A-11(c)); per-address limit and signer binding on the Watch bridge (F1A-5, check against what the Watch sends); reserve part of the voice cap for returning users (F1A-4); one APNs HTTP/2 session with collapse IDs (F1B-3, F1B-11); remove the KV fallback once confirmed empty (F5-3). | code | — |
| 7 | Once old app builds are gone: `TASKIFY_AUTH_V1 = "off"` on the Worker and `REQUIRE_SIGNED_PREVIEWS=true` on the relay. | maintainer | wait for client adoption |
| 8 | Privacy, needs a PWA release: stop sending reminder titles to the Worker and resolve them on the device (F1A-8); send preview and NIP-05 inputs in request bodies (F1A-9). | code | PWA release |
| 9 | Storage: per-record `node:sqlite` store for the push server (F5-4; also the base for moving Worker routes to StartOS); per-record DM cache in the PWA (F5-6); non-root relay container (F1B-10). | code | data migration; StartOS box test |
| 10 | Design: per-author signatures inside board events, so attribution is authenticated and a member can be removed by re-keying (F2-4). | code | protocol change, all clients |
| 11 | Clean-up: drop `ensureSchema` once migrations are applied on every deploy (F5-7); advance the Worker compatibility date with a test pass (F1A-11(d)); update the StartOS SDK when it ships fixed dependencies (F0-5). | code | — |

Steps 0, 2, 3 and 5 need nobody but the maintainer and cost nothing on the free plan.

## Findings by surface

### Cross-cutting (repository, process, all clients)

| ID | Sev | Finding | Status | Detail |
| --- | --- | --- | --- | --- |
| F0-1 | P0 | API credentials in public git history | Maintainer | Reported rotated 2026-09-30; not verified from here. |
| F2-2 | P1 | content from before 27 March is encrypted with a public value | Accepted | Maintainer, 2026-09-30: exposure already happened; no board-ID migration. |
| F0-2 | P2 | signed app archives in public history | No action | Include the paths if history is ever rewritten. |
| F0-3 | P2 | nothing automated gates a release | Fixed | CI workflow `c7c6cc8e`; it has not run yet because the branch is unpushed. Swift not covered (see CI). |
| F0-7 | P2 | published policy does not describe actual processing | Maintainer | Draft in `docs/plans/2026-10-01-privacy-policy-draft.md`; three points to confirm. |
| F2-4 | P2 | a board ID grants full access, and authorship is self-declared | Open | Design: per-author signatures inside board events. Protocol change across all clients. |
| F0-4 | P3 | type check is red | Fixed | `cb9d36dd`; 0 errors. |
| F0-5 | P3 | advisories in development dependencies only | Open | Inside the StartOS SDK's bundled dependencies; needs an SDK release. Not shipped. |
| F0-6 | P3 | no type check exists | Fixed | `worker/tsconfig.json`, `npm run check`. |

### Cloudflare Worker

| ID | Sev | Finding | Status | Detail |
| --- | --- | --- | --- | --- |
| F1A-1 | P1 | anyone can make the Worker send requests to any URL | Fixed | Push-service allowlist; cron removes other endpoints; no redirects. |
| F1A-10 | P1 | dictated text is sent to Gemini's free tier, which may use and review it | Fixed | Voice uses Workers AI only. After deploy: delete the `GEMINI_API_KEY` secret and revoke the key. |
| F1A-16 | P1 | data from the retired Google Calendar integration may still be in production | Maintainer | List the retired calendar tables; if present, revoke tokens at Google and apply 0005. |
| F1A-17 | P1 | the free plan's daily request allowance is a switch anyone can flip | Partly fixed | Crawler paths are assets now. A zone-level rate rule on `/api/*` is still needed. |
| F1A-2 | P1 | no limits on what an unauthenticated device can store or make the cron do | Fixed | Caps, bounded cron, retention; then F4-1/F4-2 (diffed saves, daily budgets, fair cron). |
| F4-1 | P1 | one address can spend D1's daily write allowance in minutes | Fixed | Diffed saves, daily change budgets (`write_budget`, migration 0007). |
| F1A-11 | P2 | deployment settings widen the surface | Partly fixed | (a) accepted; (b) VAPID key in KV, (c) limiters fail open, (d) old compatibility date, (e) Worker name mismatch remain. |
| F1A-18 | P2 | preview parsing does not fit the free plan's CPU limit | Fixed | Head-only parse: about 0.8 ms instead of 157 ms. |
| F1A-3 | P2 | the security headers never reach production | Fixed | `_headers` + Worker copy: CSP with `script-src 'self'`, HSTS, framing, Permissions-Policy. |
| F1A-4 | P2 | voice can be switched off for everyone each day | Partly fixed | Address limits key on /64. One person can still spend the 1,000/day global cap. |
| F1A-5 | P2 | the Watch bridge is an open relay proxy in practice | Partly fixed | Public targets only, bounded reads. No per-address limit; events need not be the signer's. |
| F1A-6 | P2 | request bodies are unbounded on every route except voice | Fixed | 256 KiB bounded reads on push routes and the bridge. |
| F1A-7 | P2 | request signatures are replayable and not bound to a route | Fixed | v2 signatures (method, host, path, body; 60 s; replay record). v1 accepted until `TASKIFY_AUTH_V1=off`. |
| F1A-8 | P2 | reminder titles are stored in plaintext and nothing is ever deleted | Partly fixed | Hourly retention pruning. Titles are still sent to and stored by the Worker. |
| F1A-9 | P2 | previewed links and looked-up names travel in URLs while logging is on | Partly fixed | Log lines cleaned, Gemini key gone. Invocation logs and URL-borne preview/NIP-05 inputs remain. |
| F4-2 | P2 | the reminder cron can wake at most 50 devices a minute, oldest rows first | Fixed | ≤45 devices, ≤5 reminders each per tick. |
| F5-3 | P2 | the legacy KV fallback spends the free KV allowance on every miss | Maintainer | List the legacy KV namespaces; then remove the fallback. |
| F1A-12 | P3 | error responses expose internals | Fixed | Generic 500s; malformed paths answer 400. |
| F1A-13 | P3 | preview output and the public-URL guard have gaps | Fixed | Scheme check on preview output; full IPv6 guard. |
| F1A-14 | P3 | the preview and NIP-05 proxies are usable by any website | Fixed | No wildcard CORS; exact host matching; NIP-05 timeout and size cap. |
| F1A-15 | P3 | correctness and maintenance items | Partly fixed | Remaining: schema at request time (F5-7), legacy KV (F5-3). |
| F5-7 | P3 | the schema is created at request time as well as by migrations | Open | Deferred until migrations are applied on every deploy. |

### Push server

| ID | Sev | Finding | Status | Detail |
| --- | --- | --- | --- | --- |
| F1B-1 | P1 | one unauthenticated request stops the process | Fixed | Handler catches everything; stray rejections logged. |
| F1B-2 | P1 | any key can fill the store for any recipient | Fixed | Stored only for the relay's users; per-recipient and total byte budgets. |
| F1B-3 | P1 | any stranger can flood a user's devices with alerts | Partly fixed | One unsent alert per device, ≥10 s apart. Still one HTTP/2 connection per push, no collapse ID. |
| F4-3 | P1 | one client can hold every socket | Fixed | 64 sockets per address; 60 s to authenticate. |
| F1B-4 | P2 | the per-address limit is a single bucket for all users | Fixed | Client address from `cf-connecting-ip` (`CLIENT_ADDRESS_HEADER`). |
| F1B-5 | P2 | work is done for unauthenticated callers without limits | Fixed | Auth before signature work; socket and message caps; pruning throttled. |
| F1B-6 | P2 | the Watch gateway relays for anyone and can be made to hold resources | Fixed | Session caps; per-destination forward limit; bounded query buffering. |
| F1B-7 | P2 | the registration table can be filled and never empties | Fixed | 90-day registration expiry; stalest evicted. |
| F1B-8 | P2 | three exposures the documentation does not cover | Partly fixed | (b) and (c) fixed (signed previews enforced once `REQUIRE_SIGNED_PREVIEWS=true`); (a) Cloudflare's view is in the policy draft. |
| F1B-9 | P2 | persistence is fragile and scales with total state | Partly fixed | A failed write no longer blocks later ones. Whole-file storage remains (F5-4). |
| F5-4 | P2 | every accepted message rewrites the whole state file | Open | Per-record storage in `node:sqlite`. |
| F1B-10 | P3 | smaller hardening items | Partly fixed | Error mapping and replay order fixed. Container still runs as root (needs a StartOS box test). |
| F1B-11 | P3 | maintenance items | Partly fixed | Version files and quadratic pruning fixed. Push collapse IDs and expiry not set. |

### PWA and shared runtime

| ID | Sev | Finding | Status | Detail |
| --- | --- | --- | --- | --- |
| F2-1 | P1 | anyone can send an inbox item that appears to come from any contact | Fixed | Share inbox uses `nip59.unwrapEvent`. |
| F2-3 | P1 | the wallet seed and NWC connections are stored in plain text | Fixed | Seed and NWC strings are device-key ciphertext. |
| F2-5 | P2 | incoming tokens are claimed automatically from any sender and any mint | Fixed | Payments from unfamiliar mints are held until the user redeems them. |
| F2-6 | P2 | payments from standard NUT-18 senders are dropped | Fixed | Rumors without `p` tags accepted, as on iOS. |
| F2-7 | P2 | history fetches skip signature checks that subscriptions make | Fixed | Runtime `fetchEvents` verifies every signature. |
| F3A-1 | P2 | the debug console loads an unpinned third-party script, and keeps loading it | Fixed | Debug console bundled and pinned, loaded only when enabled. |
| F3A-2 | P2 | there is no script policy, and two things block one | Fixed | `script-src 'self'`; tseep aliased to an eval-free shim. |
| F3A-3 | P2 | attached documents can load remote content and show forms on every member's screen | Fixed | Sanitizer drops forms, remote media, styles. |
| F3A-4 | P2 | P2PK private keys are stored in plain text | Fixed | P2PK keys are device-key ciphertext. |
| F3A-5 | P2 | links in messages and tasks contact third parties without a tap | Accepted | Maintainer, 2026-09-30. |
| F5-1 | P2 | the PDF library loads on every start | Fixed | PDF library no longer on the startup path. |
| F5-2 | P2 | a failed reminder sync is not retried | Fixed | `useReminderSync` retries until accepted. |
| F3A-6 | P3 | tapping a reminder never focuses the open app or opens the task | Fixed | Reminder taps focus the app and open the task. |
| F3A-7 | P3 | access secrets other than keys are stored in plain text | Accepted | Maintainer, 2026-09-30. |
| F3A-8 | P3 | an unused, unverified fetch method | Fixed | Unused unverified fetch removed. |
| F5-5 | P3 | 21 functions in `App.tsx` are verbatim copies of exported ones | Fixed | 20 copies removed. |
| F5-6 | P3 | the whole DM cache is re-serialised on every change | Open | Per-record DM storage. |

### Apple clients (iOS, Watch, iPad, macOS)

| ID | Sev | Finding | Status | Detail |
| --- | --- | --- | --- | --- |
| F3B-1 | P2 | tasks completed from the Home Screen widget are never synced | Fixed | Three-way merge of widget and Siri changes. |
| F3B-2 | P2 | no privacy manifest for any target | Fixed | Privacy manifests in all seven targets. |
| F3B-3 | P2 | tokens and board IDs are copied with no expiry | Fixed | Local-only, expiring pasteboard copies. |
| F3C-1 | P2 | nothing locks the wallet or chats on a shared device | Accepted | Maintainer, 2026-10-02: no lock wanted. |
| F3D-1 | P2 | secrets copied on the Mac stay on the clipboard and reach the iPhone | Fixed | Host-only, concealed, expiring copies. |
| F3D-2 | P2 | printing in the sandbox has no print entitlement | Fixed | Print entitlement; confirm with a signed build. |
| F2-8 | P3 | a non-standard NIP-44 extension under the standard version byte | Fixed | Resolved: `nostr-tools` reads the same form; interop tests added. |
| F3B-4 | P3 | the Lock Screen widget shows task titles while locked | Fixed | Titles redacted while locked. |
| F3B-5 | P3 | the receive-ecash sheet reads the clipboard on open | Accepted | Maintainer's choice. |
| F3B-6 | P3 | a fallback notification keeps the push's own actions | Fixed | Fallback notification has no actions. |
| F3B-7 | P3 | a stale copy of the whole store is kept after migration | Fixed | Stale private store removed after verification. |
| F3C-2 | P3 | the Wallet header stacks its buttons phone-style | Fixed | Wallet buttons in a row on wide screens (rest of the finding withdrawn). |
| F3C-3 | P3 | no keyboard shortcuts or drop from other apps | Fixed | ⌘N, ⌘1–5, ⌘↩; file drop on chat and task editor (drop not exercised). |
| F3C-4 | P3 | the conversation shows a back button while the list is visible | Fixed | No back button beside the list; a button to show a hidden list. |
| F3D-3 | P3 | keys use the legacy file-based keychain | Fixed | Data protection keychain; confirm with a signed build. |
| F3D-4 | P3 | the Mac privacy manifest declares what the Mac does not do | Fixed | Mac-specific manifest, kept by the project generator. |

### CLI

| ID | Sev | Finding | Status | Detail |
| --- | --- | --- | --- | --- |
| F3E-1 | P1 | downloading an attachment writes wherever its name says | Fixed | Bare file name; no overwrite. |
| F3E-2 | P1 | bash completion runs commands hidden in board names | Fixed | Quoted names; literal matching. |
| F3E-3 | P2 | other people's text reaches the terminal with control characters intact | Fixed | Control characters stripped from remote text. |
| F3E-4 | P2 | the trust label can be forged, and agents are not told task text is untrusted | Fixed | "~ claims trusted"; skill warns about untrusted content. |
| F3E-5 | P2 | secrets are passed as command-line arguments | Fixed | Secrets prompted or read from stdin. |
| F3E-6 | P3 | CSV export lets spreadsheet formulas through | Fixed | Formula prefixes escaped. |
| F3E-7 | P3 | some relay reads bypass signature verification | Fixed | Direct reads verified on plain copies. |
| F3E-8 | P3 | dead agent code | Fixed | Dead dispatcher removed; private temp files. |

### Third-party service run by Solife

| ID | Sev | Finding | Status | Detail |
| --- | --- | --- | --- | --- |
| F4-4 | P2 | anyone can push Taskify users' attachments off the default file host | Maintainer | Upload authentication or quotas on the Originless node. |

## Minimum CI

`.github/workflows/ci.yml` (fix pass 5) runs on pushes and pull requests to `main` and `Beta`.
It covers:

- the Worker, push server, and CLI: type check, tests, production `npm audit`;
- `taskify-core` and `taskify-runtime-nostr`: tests and a check that committed `dist/` matches
  the source;
- the PWA: lint, type check, tests, build;
- gitleaks over the new commits.

It has not run, because nothing has been pushed. Proposed additions:

1. **Swift.** A macOS job running `swift test` for `taskify-ios-native` and `taskify-macos`,
   and `xcodebuild build` for the iOS app (with extensions), Watch app, and Mac app, unsigned.
   macOS runners are free for public repositories. Building into a temporary derived-data path
   avoids the iCloud and `"file 2"` problems seen locally.
2. **Migrations.** A Worker step that builds a fresh SQLite database from `worker/migrations/`
   and runs the tests against it. The tests already do this through `node:sqlite`; the step
   only needs to fail when a migration does not apply cleanly.
3. **Deploy guard.** `wrangler deploy --dry-run` with the production configuration, so a
   missing binding (the fail-open limiters) or a name mismatch fails the build rather than a
   deploy.
4. **Dependency watch.** A weekly scheduled run of the existing audit steps, so an advisory in
   an unchanged lockfile still surfaces.

UI tests stay manual. They need a simulator, take over half an hour, and three of them are stale
today (a suggested task covers fixing them).

## Reliability TODO, reconciled

Status of each item in [`reliability-todo.md`](../plans/reliability-todo.md) as of this audit:

| Item | Status |
| --- | --- |
| 1. `/api/*` cache bypass | Done. The service worker skips `/api/`, and the Worker sends `Cache-Control: no-store`. |
| 2. `npm test` | Done; 356 tests pass. |
| 3. Event signature verification | Done, and extended: history fetches (F2-7) and CLI direct reads (F3E-7) now verify too. |
| 4. Durable outbox | Done. |
| 5. Sanitize document HTML | Done, and hardened (F3A-3: no forms, remote media, or styles). |
| 6. `tsc` errors | Done; 0 errors (F0-4). |
| 7. Encrypt the Nostr key at rest | Done. The seed, NWC strings, and P2PK keys followed (F2-3, F3A-4). The plaintext fallback without WebCrypto or IndexedDB is accepted. |
| 8. ESLint errors | Done; 0 errors, 1 warning. |
| 9. Per-entity object stores | Done for tasks, boards, and events. The DM cache is still one value (F5-6). |
| 10. Extract logic from `App.tsx` | Done. Fix pass 13 removed 20 leftover duplicates (F5-5). |
| 11. Virtualization | Done for grouped Upcoming. Remaining: contacts, board columns, DM threads. The wallet bounties list is superseded: bounties are deprecated. |
| 12. Worker clean-up | Done. Follow-ups: request-time schema (F5-7) and the legacy KV fallback (F5-3). |
| Conflict resolution (deferred) | Still deferred. Related to F2-4. |

## Appendix A — Abuse and cost, after the fixes on `Beta`

"Keyed on" is what one bucket covers: an address (an IPv6 /64 or an IPv4 address), a Nostr key,
a device, or the whole service. Keys are free, so a per-key limit only binds honest clients.

| Resource | Current limit (keyed on) | Worst case per attacker | Status |
| --- | --- | --- | --- |
| Worker invocations | 100,000/day (service) | spent in minutes by a loop | open: zone rate rule (step 0) |
| D1 rows written | 1,500 reminder changes/day (address), 6,000 (service); unchanged saves write nothing | four addresses stop reminder changes for the day; the rest of D1 keeps working | fixed (F4-1) |
| D1 rows read | 5,000,000/day (service); a save reads ≤500 | about five and a half hours from one address | open: zone rate rule |
| KV reads | 100,000/day (service); 1 per unknown-device request | a few addresses in a day | open (F5-3) |
| Voice model calls | 20/min and 100/day (address), 20/day (key), 1,000/day and about 700 Workers AI requests (service) | 7–10 addresses spend the day | partly fixed (F1A-4) |
| Link previews, NIP-05 | 30 and 60/min (address); head-only parse; 5 s / 256 KiB | own share only | fixed; limiters fail open (F1A-11(c)) |
| Watch bridge | 30/min (key); no address limit; public targets only | unbounded with new keys | partly fixed (F1A-5) |
| Reminder cron | 45 devices × 5 reminders per tick; ≤50 outbound requests | delay bounded by the change budget | fixed (F4-2) |
| APNs alerts per device | one unsent alert, ≥10 s apart (stored) | about 6/min per device | mitigated (F1B-3) |
| Push-relay stored wraps | relay users only; 500 and 8 MiB per recipient; 128 MiB total; 30 days | evicts a recipient's oldest undelivered wraps | fixed (F1B-2) |
| Push-relay sockets | 2,000 (service), 64 (address), 60 s to authenticate | 64 sockets | fixed (F4-3) |
| Push-relay HTTP | 300/min (key), 1,200/min (address) | own share only | fixed (F1B-4) |
| Push-relay forwarding | 30/min (key), 240/min per destination (service), session caps | a popular relay's share | fixed (F1B-6) |
| Clients' publishes to public relays | per-relay token bucket; backoff | the user's own address | closed (relay traffic audit) |
| Messages from strangers | the recipient's inbox relays; push relay as above | unbounded on relays without anti-spam | no change proposed |
| Hostile board member | none in clients; relays' limits | unbounded tasks and deletions on that board | design (F2-4) |
| Originless uploads | unknown; evicts at a storage threshold | evicts others' attachments | maintainer (F4-4) |

## Appendix B — Where user data goes, after the fixes on `Beta`

| Data | Where it rests | Who receives it | Form |
| --- | --- | --- | --- |
| Nostr secret key | PWA: device-key ciphertext (plaintext only without WebCrypto or IndexedDB). iOS: Keychain, after first unlock, device only. Watch: Keychain. macOS: data protection keychain (legacy fallback on unsigned builds). CLI: `~/.taskify-cli`, mode 0600, or `TASKIFY_NSEC` | nobody | — |
| Cashu seed, P2PK keys, NWC strings | PWA: device-key ciphertext. iOS and macOS: Keychain | mints (proofs), the wallet's relay (NWC) | TLS; encrypted NWC requests |
| Cashu proofs, pending tokens | PWA: IndexedDB (accepted, F3A-7). iOS: `cashu.sqlite` | mints; DM recipients | tokens inside encrypted DMs |
| Tasks, boards, events | PWA: IndexedDB per entity. iOS: app-group snapshot. Watch: protected files | Nostr relays; push server (Watch task events, 30 days) | encrypted under a key derived from the board ID |
| Direct messages | PWA: IndexedDB (one value). iOS: snapshot. Watch: protected files | relays; push server (gift wraps for its users, 30 days) | NIP-17 gift wraps |
| Reminder titles and due times (web push) | Worker D1, until sent; undelivered rows 14 days | Taskify Worker | plaintext at the Worker (F1A-8) |
| Web push subscription | Worker D1 (+ legacy KV) | Worker, then the browser's push service | endpoint and keys |
| Reminder change counters | Worker D1 `write_budget`, 7 days | Worker | day-salted hash of the address |
| Voice transcript, board names | not stored | Worker → Cloudflare Workers AI | plaintext at both |
| Voice usage | Worker D1 `voice_quota`, 7 days | Worker | public key and counts; day-salted address hash |
| Used request signatures | Worker D1, until expiry (60 s) | Worker | signature only |
| APNs token ↔ public key | push server `state.json` (0600); expires after 90 days unrefreshed | push server, then Apple | token, topic, environment |
| Push metadata | push server; Cloudflare in front | push server operator, Cloudflare | who sent to whom and when, sizes |
| Link-preview URLs | PWA preview cache | Worker → the site; YouTube, Amazon, Etsy, `noembed.com` | URL (in the request URL, F1A-9) |
| NIP-05 lookups | Worker edge cache, 15 min | Worker → the named domain | identifier |
| Attachments | local caches | Originless, `nostr.build`, `blossom.band`, user-chosen; `dweb.link` | AES-GCM ciphertext |
| Favicons, preview images, mint domains | — | Google favicon service and linked sites, directly (accepted, F3A-5) | domain or URL, plus the user's address |
| Prices | PWA cache | `api.coinbase.com`, directly | the user's address |
| CLI agent content | — | the AI provider the user configures | plaintext |
| Invocation logs | Cloudflare, 3 days | Cloudflare and the account | full URL, address, city-level location (F1A-9) |

## Appendix C — Not covered

- **Deployed systems.** No test reached production, Cloudflare, D1, or the StartOS box; account
  answers came from the maintainer.
- **Devices.** No physical iPhone, iPad, Watch, or signed Mac build was used. iPad rotation,
  multitasking, and the on-screen keyboard were not exercised. Native timings are simulator
  figures.
- **Usability and accessibility.** There was no Lighthouse, accessibility, VoiceOver, or
  Dynamic Type pass, and no end-to-end walkthrough of onboarding, backup, or recovery.
- **External code.** Third-party relays, mints, file hosts, and the Originless node's own code
  are out of scope.
- **Real-world interactions.** Live payments between clients, and messages between real
  devices, were not exercised. The unhandled publish rejection seen in fix pass 3 is
  unreproduced.

## Related audits

- [Relay traffic and publish budgets](relay-traffic-audit-2026-09-24.md)
- [Nostr sync pipeline](nostr-sync-audit-2026-09-03.md)
- [Task and DM history recovery](pwa-client-history-sync-2026-09-11.md)
- [Ecash receive and recovery](solife-ecash-receive-audit-2026-09-22.md)
- [Native board performance](native-board-performance-2026-09-12.md) and
  [device performance](solife-performance-audit-2026-09-03.md)
