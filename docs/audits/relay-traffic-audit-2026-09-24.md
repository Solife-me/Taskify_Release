# Relay traffic audit — September 24, 2026

Goal: Taskify should run on public relays without tripping rate limits or getting keys or IPs
blocked. This pass traced every place the PWA, native (iOS/macOS/Watch), worker and push
relay publish or subscribe, and asked of each: how often, how many events, to how many
relays, and does it need to sync at all.

**Verdict:** native is close; the PWA is not. The PWA's normal editing flow can emit dozens to
hundreds of signed events per action, it never slows down when a relay says `rate-limited:`,
and it re-downloads full board and DM history every time the window regains focus. With the
default relays (`relay.damus.io`, `nos.lol`, `relay.solife.me`), one reorder on a large board
is enough to be rate-limited.

## What relays enforce

Limits vary by operator and are mostly not advertised (NIP-11 has no throughput field), so
the client has to be conservative up front, not just react after rejections.

| Relay software | Relevant defaults / documented examples |
|---|---|
| noteguard (Damus) | Rate-limit filter example: **8 events/minute per IP**; optional `ban_after` consecutive rejections, 1 h ban by default |
| strfry | Rejects events **> 15 min in the future**; max event size **64 KB**; 200 subs per connection; no built-in rate limit |
| nostr-rs-relay | `messages_per_sec` and `subscriptions_per_min` unset by default, operators "strongly recommended" to set subs to ~**10/min**; rejects events > 30 min in the future |
| NIP-44 v2 | Plaintext capped at **65,535 bytes** |

Sources: [noteguard](https://github.com/damus-io/noteguard),
[strfry.conf](https://github.com/hoytech/strfry/blob/master/strfry.conf),
[nostr-rs-relay config](https://github.com/scsibug/nostr-rs-relay/blob/master/config.toml).
Damus's live configuration isn't public; the 8/min figure is noteguard's documented example.

A useful working budget: **≤ 8 events/minute sustained per relay, small bursts**, **≤ 10 new
REQs/minute per relay**, events **< 48 KB**, `created_at` within a few minutes of real time.

## Status (updated September 24, 2026)

| Finding | Status | Commit |
|---|---|---|
| 1. Board metadata with every task publish | Fixed: skipped when unchanged (plaintext fingerprint). *Correction:* bursts were already coalesced by the runtime's per-address debounce; the doubling applied to single edits. | `d4cfdfd7` |
| 2. Drag renumbers and republishes | Fixed differently than proposed: task `order` is not part of the synced payload on either client (each device orders its own lists), so order-only changes no longer publish at all. Fractional ordering isn't needed for traffic. | `082e9e9d` |
| 3. Full history on every focus | Fixed: resume only after ≥ 60 s hidden or back online; history recovery is incremental from a per-relay watermark after the first complete pass; DM live subscription reads recent traffic only. | `011407a8` |
| 4. PWA ignores rate limits | Fixed in the shared runtime publisher: per-relay token bucket, `rate-limited:` backoff, refused events held back. | `d4cfdfd7`, `3e6a1802`, `1757e871` |
| 5. Native resends refused events | Fixed: held back per relay on a persisted schedule (1 h doubling to 7 days); never discarded. False `duplicate:` stays pending, per the 2026-09-03 audit. | `3c2f5d8b`, `3e6a1802` |
| 6. Native paces reactively | Fixed: proactive token bucket. | `1757e871` |
| 7. Fasting reminders fight | Fixed: shared series id, date-derived ids, synced settings and seed (parity-tested), no deletions from a device where the feature is merely off. Pre-existing duplicates are not cleaned up. | `a3340646` |
| 8. Backup kind-5 deletion | Fixed. | `97eddf5a` |
| 9. Server fan-in | Fixed: per-account limits on the Worker bridge and push relay forwarding; Watch changes go only to Taskify's relays (relay.solife.me / push.solife.me) and the phone republishes them to the board's public relays from its own connection when it applies the queued Watch command. | `b786445b`, `f49d27f0` |
| 10. Calendar invite subscription churn | Fixed. | `97eddf5a` |
| 11. Native one-shot sockets | Fixed: account backup, app state and contacts lookups run as one-shot REQs on the sync engine's open (NIP-42-authenticated) connections, with a fresh socket only for relays it isn't connected to; auxiliary relays linger 5 min instead of reconnecting per publish. | `55c6077a` |
| 12. Mint backup on every render | Fixed. | `97eddf5a` |
| 13. `created_at` drift | Fixed: only successive versions of one replaceable address are bumped; nothing is stamped more than 60 s ahead. | `0d1de860` |
| 14. Generation before sync | Fixed, and wider than first described: generating a shared-id task (recurring instance, fasting reminder, first scripture review) before sync could reopen an instance another device completed. Both clients now wait for relay sync. | `0d1de860` |
| 15. Broad relay fan-out | Fixed: built-in relays are a fallback only, never appended to configured lists. | `02bb808f` |
| 16. Streak rewrite on completion | Fixed: streaks are derived from the series on both clients; this also fixed native restarting streaks from stale pre-generated instances. | `86a50f56` |

**Pacing policy (chosen):** first-party relays (`relay.solife.me`, `push.solife.me`) get a burst of
100, then 10 events/s, so a 60-task template lands there in about 3 s. Every other relay gets a
burst of 8, then one event every 7.5 s. Both clients.

**Decided:** Watch changes go only to first-party relays; public relays get them when the phone
next syncs. Every finding in this audit is now addressed.

## Fixed in the first pass

| Issue | Change |
|---|---|
| Chat-state sync (added earlier this session) could reach **183 KB** for heavy users: over strfry's 64 KB event limit and NIP-44's plaintext limit, so every publish would fail | Published state is now trimmed, oldest first, to a 32 KB plaintext budget (`CHAT_SYNC_MAX_PLAINTEXT_BYTES` / `ChatSyncState.maxPlaintextBytes`) |
| The "anything new?" check compared full local state against the pruned published state, so an entry pruning drops (e.g. a read marker older than 180 days) would republish the same payload on every trigger | Both clients now ask `chatSyncStateToPublish` / `ChatSyncState.toPublish`, which returns nothing when the pruned result would not change |

Tests: `taskify-core/tests/app-state-sync-core.test.ts`, `AppStateSyncTests.swift`,
`useNostrChatStateSync.test.tsx` ("a read marker too old to publish never triggers a publish").

## Findings

Ranked by how likely they are to get a user rate-limited or banned. "Events" means signed
events before relay fan-out; each is sent to every relay in the target set (3 by default).

### P0 — trips limits in normal use

**1. Every PWA task publish also republishes the board's metadata.**
`maybePublishTask` calls `publishBoardMetadata(b)` unless the caller opts out
(`taskify-pwa/src/App.tsx:6051`; calendar events do the same at 5846, 6344, 6412). The
metadata event is unchanged almost every time. This doubles every task write.
*Fix:* publish board metadata only from board edits, or skip when its content hash matches
the last one published for that board. Native does not do this.

**2. A drag renumbers the whole board and republishes every shifted task.**
The PWA reassigns `order` 0…n across the entire target board, including completed tasks, and
publishes each task whose number moved (`App.tsx:11054`, `11174`). Moving one task to the
top of a 50-task board ≈ 50 task events + 50 metadata events (finding 1) = **100 signed
events, 300 relay writes**, drained at 5/s. Native renumbers per column instead of per board
(`TaskifySnapshot.swift:1132`), which is smaller but still O(column).
*Fix:* fractional ordering — give the moved task a value between its new neighbours so a move
publishes one event. Renumber only when gaps run out, locally first, and publish the
renumbering through the paced queue (below). Never republish completed tasks for ordering.

**3. The PWA re-downloads all board and DM history on every focus.**
`useSyncResume` fires on every `focus`, `visibilitychange` and `online` event (1 s debounce;
`taskify-pwa/src/nostr/useSyncResume.ts:16`), and alt-tabbing back to the window counts.
Each resume:
- tears down and re-REQs every board on every relay, then runs `recoverRelayHistory`, which
  pages back to `since: 0` until a page comes back empty (`taskify-runtime-nostr/src/history.ts:23`), per board, per relay;
- restarts DM sync with a live subscription at `since: 0` plus the same full paged walk over
  two filters on every inbox relay (`taskify-pwa/src/hooks/wallet/useDmSubscription.ts:541`),
  so every DM downloads at least twice.

This is the PWA's largest REQ and bandwidth load, and the pattern (many REQs, deep history
scans, repeated) is exactly what subscription limits target.
*Fix:* resume only after the page was hidden for > 60 s or came back online; resubscribe
live filters with `since = last seen − lookback`; run full history recovery once per
install/upgrade (record completion per relay) and from a manual "Resync" action.

**4. The PWA never slows down when a relay pushes back.**
All PWA publishes share a 200 ms minimum interval (`taskify-pwa/src/domains/nostr/nostrPool.ts:49`),
i.e. up to 5 events/s, and nothing reads `OK false "rate-limited:"` or rate-limit `NOTICE`s
(the only rate limiter in the PWA is for Cashu mints). Several paths bypass even the 200 ms
queue: board sharing (`ui/settings/ManageBoardModal.tsx:192`), inbox deletions
(`App.tsx:1794`), wallet/NWC (`nostr/WalletNostrClient.ts`), profile, contacts, mint backup.
Against noteguard's 8/min, continuing to send after rejections is what triggers `ban_after`.
*Fix:* one per-relay publish scheduler for the PWA, used by every publisher: a token bucket
(e.g. burst 8, then 1 event / 8 s), exponential backoff on `rate-limited:`, and — most
effective — **coalescing by replaceable address** (`kind:pubkey:d`), so five queued edits of
one task send only the newest. Native's `RelayPublishPacer` is a good model for the backoff
half.

### P1 — can cause blocks or wasted traffic

**5. Native retries permanently rejected events forever.**
Only `rate-limited:` and `auth-required:` are classified (`TaskSyncEngine.swift:281`).
Anything else (`blocked:`, `restricted:`, `invalid:`, `pow:`, too large) is deferred for the
current connection only (`TaskSyncEngine.swift:1381`) and re-sent after every reconnect — every
launch and foreground — and `pow:` is never retried at the higher difficulty. Repeatedly
sending what a relay explicitly refused is a ban signal.
*Fix:* treat `blocked:`/`restricted:`/`invalid:` as terminal for that relay after one or two
attempts (keep other relays); re-mine on `pow:` with the stated difficulty; back off on
`error:`.

**6. Native paces reactively.**
`RelayPublishPacer` starts at 50 ms (20 events/s per relay, `TaskSyncEngine.swift:221`) and
only slows after a rejection. That works on tolerant relays but spends the first strikes
against strict ones. *Fix:* add a proactive budget (same token bucket as the PWA) under the
existing adaptive backoff.

**7. Fasting reminders fight across devices.**
Both clients create reminders with random ids (`App.tsx:1379`,
`TaskifySnapshot.swift:436`) from local state at startup, before relay sync — so two
devices create two tasks per date. Native's random-mode seed is a per-device UUID that never
syncs (`FastingRemindersSettings.swift:40`), and native deletes future reminders it didn't
plan (`TaskifySnapshot.swift:~400`). With random mode on in two clients, each deletes the
other's reminders and creates its own on every launch: continuous publish churn and
reminders that change under the user.
*Fix:* date-derived ids (`fasting:<local YYYY-MM-DD>`, as done for scripture review tasks);
sync native's fasting settings and seed through the account backup (the PWA already syncs
`fastingRemindersRandomSeed`); generate only after the board's initial sync completes.

**8. Account backup publishes a deletion after every update.**
Each backup publish is followed by a kind-5 deletion of the previous event
(`taskify-pwa/src/nostr/useNostrAppBackupSync.ts:693`). The backup is a replaceable event, so
the relay already discards the old version. *Fix:* remove the deletion; halves backup writes.

**9. Server components publish many users' events from shared IPs.**
The Watch publishes and queries through the worker (`worker/src/nostr-bridge.ts:162`), and
the push relay forwards DMs to recipients' relays. Per-IP limits (noteguard's is per IP) then
count all Taskify Watch users as one client, and the worker's egress IPs are shared with other
Cloudflare customers. Neither has pacing or per-user quotas.
*Fix:* prefer the phone path (WatchConnectivity) and use the bridge only when the phone is
unreachable; add per-user and per-relay rate limits to the worker and forwarder; keep relay
target lists short.

**10. PWA calendar invite subscription restarts on any calendar edit.**
The effect depends on the whole `calendarEvents` array
(`taskify-pwa/src/nostr/useNostrSubscriptions.ts:234`), so editing any event closes and
reopens the subscription and re-fetches from the union of invite, default, inbox and built-in
relays, whenever any invited events exist. *Fix:* depend on a stable key of the invited
targets (view address + relays).

**11. Native opens extra sockets for one-shot lookups.**
About ten paths open their own short-lived connection instead of using the sync engine's
persistent ones (account backup, app state, contacts, bot commands, inbox relay resolver,
shared inbox, share delivery, NWC). On one foreground return, a relay can see several
concurrent connections from the same device. *Fix:* give `TaskSyncEngine` a one-shot
`fetch(filters, relays)` over its open connections; combine the account backup and app-state
lookups into one REQ (same kind and author, four d-tags).

**12. Mint-list backup republishes whenever wallet settings render.**
`syncMintBackup` runs on every mount of the wallet settings section and whenever the relay
list's identity changes (`taskify-pwa/src/ui/settings/WalletSection.tsx:675`), without comparing
against the cached last-published mint list. *Fix:* skip when the mint list is unchanged.

### P2 — worth doing with the refactor

13. **`created_at` drift.** Under a burst the PWA bumps each event to `last + 1`
    (`nostr/useNostrIdentity.ts:186`), so a large burst runs ahead of real time; strfry rejects
    events > 15 min in the future. Coalescing and pacing make this moot; also clamp to now + 60 s.
14. **Recurring clones generated before sync.** `ensureWeekRecurrences` runs at mount against
    local state (`App.tsx:1426`), so each device publishes the same deterministic clones every
    week. Generate after initial board sync.
15. **Broad relay fan-out.** The built-in relay list is appended to relay unions in ~40
    places, so most reads and writes go to board relays + defaults + inbox relays. Define
    relay sets per purpose (board, inbox, account) and use only that set.
16. **Completing a recurring task** publishes the completed task, a streak update on the next
    instance, and the new clone (plus three metadata events today). Deriving streaks at read
    time would drop the middle write.

## Things that don't need to sync

- **Board metadata alongside task edits** (finding 1).
- **Ordering for completed tasks**, and `lastEditedBy` bumps from reorder-only changes.
- **Device-specific settings in the account backup.** The backup carries nearly every
  setting. These are device preferences and would be better kept local: `baseFontSize`,
  `backgroundBlur`, `startupView`, `startBoardByDay`, `pushNotifications` (enabling push on
  one device shouldn't enable it on another), `walletSentStateChecksEnabled`,
  `walletPaymentRequestsBackgroundChecksEnabled` (per-device battery), `scriptureMemorySort`.
  `completedTab` and `hideCompletedSubtasks` are judgment calls. Sync fewer settings, not more.
- **Streak values on the next recurring instance** (finding 16).
- **Bible tracker `expandedBooks`**: already local-only as of this session.

## Suggested refactor, in order

1. **PWA publish scheduler** (findings 1, 4, 13): one queue per relay for every publisher,
   coalescing by replaceable address, a proactive token bucket, and OK/NOTICE classification
   shared with native's rules. Largest single reduction.
2. **Fractional ordering** on both clients (finding 2).
3. **PWA resume and history policy** (finding 3): cursors for live subscriptions, full
   recovery once per install plus manual.
4. **Native rejection classification and proactive budget** (findings 5, 6).
5. **Generated-task hygiene** (findings 7, 14): date-derived ids, synced settings, generate
   after sync.
6. **Small removals** (findings 8, 10, 12) — each a few lines.
7. **Server fan-in** (finding 9).

## Measure before and after

The numbers above come from reading code, not traffic captures. Before and after the
refactor, count per relay: events sent/minute, REQs opened/minute, rejections by prefix, and
bytes received on resume. Native already surfaces pending publishes; a matching dev panel in
the PWA, plus a regression test that asserts "moving one task publishes ≤ 2 events", would
keep this from creeping back.
