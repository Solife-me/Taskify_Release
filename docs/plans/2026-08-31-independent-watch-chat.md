# Independent Apple Watch Chat Plan

**Status:** Implemented in source; physical-device/APNs release validation pending  
**Date:** 2026-08-31  
**Target:** `taskify-ios-native` independent watchOS app  
**Recommended scope:** One-to-one and group NIP-17 text chat, group creation/metadata, replies, reactions, received-photo display, unread state, contacts, durable per-recipient sending, and direct Watch notifications. Sending files, photos, payments, and structured Taskify shares is out of scope.

## Recommendation

> **Approved amendment — 2026-09-02:** After discussing the metadata exposure, the user approved
> moving public recipient discovery through the Taskify relay over HTTPS. This supersedes the
> original direct-Watch-WebSocket discovery proposal and all prohibitions below on a gateway
> lookup endpoint. `POST /v1/watch/inbox-preference/query` accepts one recipient and a bounded
> caller-supplied discovery-relay list under NIP-98, returning signed kind-10050 events and
> completed-relay evidence. The Watch still verifies signatures, selects the newest event,
> caches routing decisions, and supplies immutable delivery targets. The gateway does not scan
> contacts, persist remotely fetched preferences or lookup history, log lookup details, receive
> private keys/plaintext, or add delivery targets. The operator can now observe recipient
> lookups associated with the authenticated account, including those without a later send.
> The original design below is retained as historical context; the current contract and limits
> are documented in `taskify-push-relay/README.md` and `taskify-ios-native/README.md`.

Use the existing Taskify push relay as a narrow HTTPS facade for the independent Watch app. Keep all identity keys, message construction, NIP-44/NIP-59 encryption, decryption, chat history, unread state, and photo decryption on Apple Watch.

The push relay should remain a standard NIP-17 inbox relay. Its new role is limited to high-level HTTPS operations that watchOS supports reliably:

- authenticated, cursor-based reads of the signed-in account's own kind-1059 inbox;
- propagation of Watch-created, already-encrypted and already-signed kind-1059 gift wraps to the bounded relay targets supplied by the Watch;
- registering a watchOS APNs token and sending the same metadata-free generic alert as iOS, with
  a background refresh opportunity for local fetch/decryption.

Recipient kind-10050 discovery, newest-event selection, and fallback choice remain client-side. The push relay must not become a recipient preference resolver, plaintext chat service, contact database, signing service, media proxy, or key custodian.

This is preferable to adding persistent chat-delivery WebSockets to the Watch. The only direct relay sockets in this design are short-lived foreground kind-10050 discovery sessions, which require a physical-device feasibility gate; ordinary HTTPS `URLSession` traffic and direct APNs remain the reliable independent-app path for inbox access and forwarding.

## Scope interpretation

For this plan, “full chat” means complete one-to-one and group DM workflows on Apple Watch:

- list known conversations and unread counts;
- separate unknown senders;
- compose from a Taskify contact;
- create a named group with up to 17 total members, matching the current native/PWA contract;
- display group subjects and participants, rename, mute, leave, and rejoin groups;
- send and receive NIP-17 kind-14 text;
- send and receive replies and kind-7 emoji reactions;
- show queued, partially sent, sent, and failed state with per-recipient retry;
- delete locally, clear, block, and mark read;
- parse received kind-15 attachments and render supported photos;
- receive a metadata-free APNs wake, decrypt locally, and present a generic local alert for an
  unmuted conversation;
- work over the Watch's own Wi-Fi or cellular path after the existing secure provisioning step.

The first release will not:

- send any attachment or photo;
- render documents, audio, or video on Watch;
- send or redeem Cashu payments;
- import task/contact/calendar/board share cards;
- promise older history beyond the relay's 30-day/500-event recovery window.

NIP-17 room membership is the sorted set of the rumor author plus its `p` tags. Adding or removing a participant therefore creates a new room and clean history; it is not an in-place membership edit. The Watch must follow this rule instead of inventing group administrators or mutable server-side membership.

Unsupported incoming encrypted content should remain safely stored and show a compact “Open on iPhone” card rather than being discarded or misclassified.

## Current-state map

| Area | Existing capability | Gap for independent Watch chat |
|---|---|---|
| Watch identity | Account private key is provisioned only while both devices are reachable and stored with `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`. | No watch-safe NIP-44/NIP-59 or generic Nostr event signer is exposed to the Watch target. |
| Watch networking | The Watch signs/encrypts task events locally and uses authenticated HTTPS to forward/query opaque task events. | The bridge only accepts kind 30301 and has no DM inbox, preference, cursor, or APNs flow. |
| Native iPhone chat | Full one-to-one and deterministic-member NIP-17 group chat, kind-14/15, reactions, unique recipient/self gift wraps, strict kind-10050 routing, durable outbox, local retention, and photo decryption already exist. | Most implementations live in `TaskifyCore` or the iPhone UI and cannot simply be linked into the lightweight Watch target. |
| Push relay | NIP-42-authenticated kind-1059 storage, recipient-only reads, 30-day/500-event retention, iPhone APNs registration, opaque preview tokens, and generic alerts. | No direct Watch HTTPS inbox/gateway API, ingestion cursor, outbound relay propagation, or Watch APNs topic. |
| Watch UI/cache | Today, Upcoming, Boards, quick add, protected task cache, and a durable command queue. | No Chat destination, conversation models, chat store, media loader, or notification coordinator. |
| Companion transfer | The schema sends tasks/boards, the account identity during reachable-only provisioning, and a bounded paired-device thread/contact projection. | Physical-device validation must confirm the compressed setup envelope and ongoing application-context projection stay within WatchConnectivity limits. |

## Target architecture

```text
Incoming
NIP-17 sender
  -> recipient's advertised wss://push.solife.me inbox
  -> push relay stores opaque kind-1059 + sends a metadata-free generic alert to Watch
  -> Watch HTTPS inbox read, authenticated as the recipient
  -> Watch verifies outer signature and recipient tag
  -> Watch unwraps NIP-59, verifies seal/rumor identity, then decrypts locally
  -> protected local chat store -> Chat UI

Outgoing
Watch composer
  -> Watch creates one canonical rumor
  -> Watch creates a unique gift wrap for every non-self room member plus a self-copy
  -> protected Watch outbox stores one logical operation with immutable wraps
  -> Watch resolves each recipient's newest valid kind-10050 locally
  -> exact published targets, or exact Taskify defaults only on confirmed absence
  -> Watch submits each opaque wrap independently to the push-relay HTTPS gateway
  -> gateway validates the supplied targets without doing recipient preference discovery
  -> direct local ingest when supplied + bounded propagation to every other supplied relay
  -> per-wrap/per-relay acknowledgement -> Queued/Partial/Sent/Failed state

Received photo
Verified kind-15 rumor
  -> Watch downloads encrypted blob over HTTPS on demand
  -> size/hash/AES-GCM validation and decryption on Watch
  -> ImageIO type/dimension validation and downsampling
  -> memory-only thumbnail -> message bubble
```

WatchConnectivity remains an opportunistic fast path for provisioning plus a bounded local contact/thread index. The index can carry one truncated latest-message preview so the Watch inbox matches the phone immediately, but never full history or attachment keys. It is not the source of DM delivery or sending.

### Client-private relay resolution and narrow gateway forwarding

The Watch is the routing authority for each outgoing gift wrap. It resolves the recipient locally and supplies the resulting relay targets with the immutable kind-1059 event. The gateway must not query kind-10050 events, maintain a recipient preference cache, or enrich the submitted target list.

For each recipient wrap, the Watch must:

1. Search its verified local kind-10050 cache, seeded over local WatchConnectivity during provisioning/contact refresh, and refresh it with short-lived foreground `URLSessionWebSocketTask` queries to the bounded configured preference-discovery relays when stale or missing. It must not use a push-relay recipient-lookup endpoint.
2. Accept only correctly signed kind-10050 events authored by that recipient, select the newest valid event, and normalize/deduplicate its public `wss://` relay tags without adding, substituting, or reordering fallback relays.
3. Use that published list exactly when it exists.
4. Use the current Taskify default fallback list exactly, and only when the Watch's complete discovery attempt confirms that no kind-10050 event exists:
   - `wss://relay.damus.io`
   - `wss://nos.lol`
   - `wss://relay.solife.me`
5. Treat a published-but-empty/unusable list, an incomplete lookup with no usable last-known-positive value, or a list over the configured safety bound as a retryable/explicit routing error. None of those states is proof of absence, so none may trigger the fallback list.
6. Persist the immutable wrap, selected target list, routing source, and resolution timestamp before submission so a retry cannot silently switch routes mid-attempt.

The Watch resolver therefore needs explicit `.published`, `.confirmedAbsent`, `.publishedButUnusable`, and `.indeterminate` outcomes rather than collapsing failures and absence into an empty array. An unexpired last-known-positive published list may be used during partial discovery failure, with a degraded state recorded locally; the Taskify defaults may not. When neither direct Watch discovery nor a safe cached result is available, the message remains queued instead of disclosing the lookup to the push relay.

For each submitted wrap, the gateway must:

1. Accept a bounded, normalized list of public `wss://` targets from the NIP-98-authenticated Watch.
2. Reject credentials, localhost, link-local, private, `.local`, resolved-private-IP, duplicate, malformed, and over-limit targets without substituting another list.
3. Attempt the immutable gift wrap on every supplied target. If `wss://push.solife.me` is supplied, ingest it directly into the existing store and APNs path; do not open a loopback WebSocket.
4. Return acknowledgements keyed by wrap ID and relay URL. Never query the recipient's preferences, create a replacement wrap, add a relay, or change an event between retries.

One-to-one and group delivery use the same operation. A group rumor contains every member `p` tag, but each outer gift wrap has only one recipient and is routed independently. The Watch owns the logical group batch, limits it to the existing 17-member contract (at most 16 non-self recipients plus one self-copy), resolves each member independently, randomizes or staggers independent submissions where practical, and never sends an explicit group identifier or recipient array to the gateway.

For status, a recipient is **delivered** after at least one relay from that recipient's selected list accepts the wrap, while the outbox continues bounded retries to reach the remaining selected relays. A group is **sent** when every non-self recipient is delivered, **partially sent** when only some recipients are delivered, and **failed** only after the unfinished recipient wraps expire or receive a permanent error. The self-copy is tracked and retried independently so another Taskify client can recover the sender's history.

## Privacy and security contract

### Data that stays on Watch

- Nostr private key and all derived NIP-44 conversation keys;
- rumor and seal plaintext;
- decrypted message text, reactions, read state, block state, and local history;
- attachment AES key/nonce after the kind-15 rumor is decrypted;
- decrypted photo bytes and thumbnails;
- the durable outgoing message outbox.

Full chat history and attachment material must never be copied into the Watch App Group used by widgets, complication timelines, application logs, analytics, crash breadcrumbs, or notification payloads. WatchConnectivity application context may contain only the bounded paired-device thread index and one truncated latest preview per projected thread; it must never contain history, message envelopes, attachment URLs/keys, or account secrets.

### Data visible to the push relay

The new HTTPS facade does not eliminate normal NIP-17 transport metadata. It can observe:

- authenticated account public key;
- the submitted kind-1059 bytes, including the clear outer gift-wrap recipient `p` tag;
- the Watch-supplied relay targets;
- ciphertext size, request time, IP/network metadata, and APNs installation association.

It must not receive the private key, NIP-44 key, rumor/seal plaintext, true sender tag from inside the gift wrap, message category, reaction, filename, MIME type, attachment URL, attachment key, or decrypted photo.

NIP-59 does not cryptographically hide the outer recipient tag from a TLS-terminating forwarding gateway. Client-side target resolution still materially reduces exposure: the push relay never issues recipient-key preference queries, receives kind-10050 lookup results/provenance, or builds a recipient preference cache. For an external-only target list the forwarding path should perform only bounded structural validation of the outer `p` tag and must not use or retain it for preference discovery or routing. The bytes remain observable to the service operator. When the Taskify push relay itself is a selected inbox, it must inspect the outer recipient to apply its normal recipient-only storage and APNs rules.

If the security requirement is that the push-relay operator must be cryptographically unable to observe the outer recipient at all, this forwarding facade is insufficient. That stronger property requires direct Watch-to-destination relay connections or a separately operated end-to-end tunnel/oblivious HTTP design. It is not achievable as a minor modification to a TLS-terminating NIP-17 push relay. This plan minimizes additional discovery exposure but does not claim that stronger anonymity property.

Submitting group wraps independently avoids handing the gateway an explicit room ID or participant array. The gateway can still infer that several recipients may be related from the authenticated account, timing, event bytes, and network metadata, just as a relay can infer repeated publishes on one authenticated connection. The Watch should use a small bounded concurrency window and optional short jitter, and the gateway must not create durable sender-recipient or sender-target correlation records.

This extends the metadata boundary already documented for the Taskify push relay; it does not create a new plaintext boundary. Request logs must omit request bodies, Nostr events, device tokens, preview tokens, queried or recipient public keys, selected relay lists, and relay result payloads. Operational metrics should be aggregate counts and latency only.

### Authentication hardening

Do not reuse the current five-minute `X-Taskify-*` Watch request signature unchanged for DM endpoints. It binds the body but is replayable during its freshness window and does not bind the HTTP method or URL.

Use the existing NIP-98 pattern for every private push-relay HTTPS operation:

- bind exact HTTPS URL, uppercase method, and SHA-256 body hash;
- accept only fresh kind-27235 events;
- add a one-use replay guard;
- require the event author to match the inbox recipient for reads and the registration owner for APNs changes;
- rate-limit by authenticated public key and IP;
- return `Cache-Control: no-store`.

The current task bridge should later migrate to the same versioned authentication contract, but that migration does not have to block the first relay-side DM prototype if DM endpoints never accept `X-Taskify-*` auth.

### Gift-wrap validation

Before storing or forwarding, the facade must require:

- a valid signed kind-1059 event;
- exactly one valid 64-hex outer `p` tag;
- exactly one kind-1059 event per Watch submission; group batching exists only in the Watch outbox;
- bounded event, content, tag, supplied-target-list, and per-account concurrency sizes;
- a non-empty caller-supplied relay target list for every outbox submission;
- public `wss://` supplied targets only, with credentials, localhost, link-local, private, `.local`, and resolved private IP targets rejected;
- no arbitrary filters or arbitrary event kinds.

The Watch must independently perform the checks the server cannot:

- outer recipient equals the Watch account;
- outer signature is valid;
- gift-wrap and seal decrypt successfully;
- seal signer equals rumor author;
- rumor ID recomputes correctly;
- room membership is valid;
- kind is explicitly supported before UI classification;
- rumor ID and wrap ID are deduplicated before persistence or notification.

### Local storage

- Keep chat in a separate atomic store written with `.completeFileProtection`.
- Keep the account key in the existing passcode-required, non-synchronizing, device-only Keychain item.
- Cap decrypted history to the newest 500 relay items or 30 days, whichever is smaller, with deterministic pruning.
- Store an opaque relay cursor, dedupe ledger, block state, and per-recipient/per-relay outgoing envelope acknowledgements.
- Never store full photo plaintext on disk in v1. Use a bounded memory cache; clear it on background, memory pressure, logout, and account reprovisioning.
- Add a Watch “Clear chat data” action and make account reset remove chat, outbox, cursor, APNs registration state, and the Keychain identity.

## Required implementation work

### 1. Extract a watch-safe NIP-17 core

Keep `TaskifyWatchShared` lightweight; do not link the full `TaskifyCore` target and its wallet/document dependencies into the Watch app.

Move or factor the following protocol-only code into a watchOS-safe target that both `TaskifyCore` and `TaskifyWatchShared` consume:

- generic signed `NostrEvent` construction and verification;
- NIP-44 v2 conversation-key derivation, encryption, and decryption;
- `NIP17Rumor`, NIP-59 seal/gift-wrap construction, and unwrap verification;
- kind-10050 parsing/event construction and normalized relay routing;
- the minimal kind-14, kind-15, kind-7, reply, and attachment DTOs;
- NIP-98 request-event construction;
- npub/hex parsing needed by compose and contact projection.

There must be one implementation of each cryptographic contract. The existing iPhone/PWA fixture tests should be reused so the Watch does not become a protocol fork.

Likely files:

- `taskify-ios-native/Sources/TaskifyCore/Nostr/NostrSharedInbox.swift`
- `taskify-ios-native/Sources/TaskifyCore/Nostr/NostrDirectMessage.swift`
- `taskify-ios-native/Sources/TaskifyCore/Nostr/NIP17InboxRelayResolver.swift`
- `taskify-ios-native/Sources/TaskifyCore/Nostr/DMPushRegistrationClient.swift`
- `taskify-ios-native/Sources/TaskifyWatchShared/`
- `taskify-ios-native/Package.swift`

### 2. Add Watch chat contracts and a protected store

Add separate versioned models rather than expanding the task/widget snapshot with decrypted messages:

- `TaskifyWatchContact` with public key, npub, local display name, optional HTTPS avatar URL, and scoped discovery relays;
- `TaskifyWatchConversation`, deterministic member-set room identity, subject, participant summary, mute/leave state, `TaskifyWatchMessage`, reaction, attachment, and delivery-state models;
- `TaskifyWatchChatCursor` based on relay ingestion order, not randomized NIP-59 `created_at`;
- `TaskifyWatchDMOutboxEntry` containing the canonical rumor ID, immutable recipient/self wraps, locally selected target lists/routing sources, gateway attempts, per-relay acknowledgements, and a 48-hour expiry;
- a bounded dedupe/deletion ledger that covers the relay's 30-day replay window.

Use an actor for atomic load/merge/prune/save. Keep chat files separate from the current task snapshot and command queue so task browsing remains resilient if chat repair is needed.

### 3. Extend secure Watch provisioning minimally

Bump the Watch provisioning schema and include only the small account context that cannot be recovered from the DM inbox itself:

- bounded contact projection;
- each projected contact's newest verified kind-10050 event/list or confirmed-absence cache state, plus the signed-in account's own preference and discovery provenance;
- the app-level discovery relays;
- whether Watch chat notifications should be requested;
- push-relay HTTPS and WSS origins.

Do not transfer iPhone plaintext chat history. A bounded thread index may include one truncated latest preview over the paired-device channel so the inbox is useful before relay recovery; the Watch recovers the actual timeline from its own NIP-17 sender/recipient copies. The projection is compressed and pruned to the newest threads before it can exceed the WatchConnectivity budget.

Provisioning must still require the immediate reachable-only flow for the private key. Normal application-context updates may refresh the bounded thread index, its truncated previews, contacts, and public relay configuration, but never include the private key, full message history, envelopes, or attachment secrets.

The Watch performs a local read-modify-write of the account's newest valid kind-10050 independently
of notification permission: preserve every existing usable relay, append `wss://push.solife.me` if
absent, sign the replacement locally, and supply the configured discovery relays plus the old and
new inbox lists as publish targets to the gateway. This keeps foreground Wi-Fi/cellular inbox
delivery available even if alert permission is declined. APNs token registration remains a separate
notification optimization and does not depend on permission to present alerts. The Watch must never replace the account's published list with Taskify
defaults. If no kind-10050 exists, the Watch creates one containing the current Taskify defaults
plus `wss://push.solife.me`; this bootstrap is distinct from recipient delivery fallback.

### 4. Add a small HTTPS Watch surface to the push relay

Recommended endpoints:

| Endpoint | Authentication | Contract |
|---|---|---|
| `POST /v1/watch/inbox/query` | NIP-98 | Return only kind-1059 events whose sole outer `p` is the authenticated account, after an opaque ingestion cursor, with a hard page limit. |
| `POST /v1/watch/outbox/submit` | NIP-98 | Accept exactly one signed kind-1059 plus a bounded Watch-selected relay list, attempt every supplied target without preference discovery or list enrichment, and return per-relay acknowledgements or short-lived NIP-42 challenges. |
| `POST /v1/watch/outbox/{session}/authorize` | NIP-98 | Accept an author-matching kind-22242 for the exact relay/challenge bound to a short-lived session, then complete AUTH and publish the already-submitted immutable kind-1059. |
| `POST /v1/watch/inbox-preference/publish` | NIP-98 | Accept only an author-matching signed kind-10050 plus bounded Watch-selected publish targets. This is write-only forwarding for the signed-in account, not a recipient lookup service. |
| Existing registration route | NIP-98 | Add a server-validated `platform: ios | watchos` field and map it to an allowlisted APNs topic. |

Implementation notes:

- Add a monotonic ingestion sequence to stored gift wraps and return opaque cursors. Do not use outer `created_at`; NIP-59 deliberately randomizes it and late arrivals are normal.
- Do not add a gateway kind-10050 lookup endpoint, resolver, or recipient preference cache. Preference discovery and fallback decisions belong to the Watch.
- Ingest `wss://push.solife.me` directly through the existing store/push path only when it appears in the Watch-supplied list; never add it implicitly and never open a loopback WebSocket.
- Forward the same immutable gift wrap to every other supplied relay with short-lived, bounded server-side WebSockets and wait for `OK`; never retain them as chat sessions.
- Group forwarding work by relay internally where it saves sockets, but do not accept or persist a client-visible group batch or group identifier.
- Store the sender self-copy without generating APNs, matching the existing NIP-42 rule.
- Preserve 30-day/500-event bounds and current global limits.
- Add request concurrency, response-size, timeout, supplied-list-size, and per-account publish limits. If a supplied list exceeds a safety limit, return an explicit error; never truncate it or substitute defaults.
- Do not durably persist outbound proxy payloads merely because they passed through the gateway. The only durable copy is normal push-relay inbox storage when the push relay is actually selected; otherwise delivery durability belongs to the Watch outbox and recipient relays.

This is a moderate extension to the existing relay, not a new service or database.

### 5. Support auth-required published inbox relays without custody

Publishing to a recipient's exact list requires a defined path for relays that issue a NIP-42 challenge. This is part of the delivery contract, not an optional post-launch interoperability enhancement.

- The gateway first opens the selected relay connection and attempts the kind-1059 when the relay permits it.
- If the relay requires AUTH, the gateway holds that socket for no more than 20 seconds and returns `202` with an opaque single-use session plus the exact relay URL and challenge.
- The Watch signs kind-22242 locally with that exact relay/challenge and posts it to the session endpoint under a fresh NIP-98 request.
- The gateway verifies the NIP-42 author matches the NIP-98 account and the session-bound values, sends `AUTH`, waits for success, then sends the original immutable kind-1059 and returns its `OK` result.
- The session, challenge, event, and socket remain memory-only and expire together. If the process/socket is lost, the Watch resubmits the same event ID through the normal endpoint.
- The gateway never holds a user signing key, signs on the user's behalf, or introduces delegated custody.

Taskify-to-Taskify independent receipt is made reliable by preserving/appending
`wss://push.solife.me` in the account's read-modify-write kind-10050, regardless of APNs permission.
That rule affects the signed-in account's own preference only; the gateway must never inject the
Taskify push relay or any fallback into the target list supplied for another recipient.

### 6. Build the independent Watch transport and sync engine

Add a Watch DM client alongside `TaskifyWatchIndependentClient`:

- NIP-98 authenticated HTTPS requests with a deferrable foreground `URLSession`;
- cursor-based inbox paging on launch, foreground, notification wake, manual refresh, and conservative background refresh;
- off-main gift-wrap verification/decryption with batched MainActor updates;
- a Watch-local kind-10050 resolver with signed positive cache entries, distinct confirmed-absence and indeterminate states, short-lived foreground discovery-relay queries, and own-account read-modify-write support for safe push-relay enrollment;
- deterministic group-room derivation from the rumor author/member `p` set, with the current 17-total-member limit;
- local-first send: validate -> resolve every member locally -> create one canonical rumor -> create unique wraps for all non-self members and self -> atomically persist the wraps and selected targets -> render queued -> submit each wrap/target list independently;
- a bounded submission window, recommended four wraps at a time, with optional short jitter for group metadata minimization;
- retry with bounded exponential backoff and 48-hour expiry;
- record per-relay gateway acknowledgements; retry only unfinished supplied relays/recipient wraps using the same event IDs and persisted routing decision;
- mark each recipient delivered when at least one selected relay acknowledges its wrap, mark the group partially sent/sent from all non-self recipient states, and continue bounded replication retries for selected relays that remain unfinished;
- keep the sender self-copy retryable independently so iPhone/PWA history converges;
- opportunistically send the exact signed envelope set, selected targets, and acknowledgement state to the iPhone when reachable, never ask the iPhone to recreate a rumor or silently replace the Watch's routing decision.

All retry/dedupe identifiers must be derived from immutable event or rumor IDs. A timeout followed by a retry must not create a second visible message.

### 7. Add Watch Chat UI

Add Chat to `TaskifyWatchRootView` with native Watch patterns:

- conversation list with display name, last message, relative time, unread badge, and delivery state;
- separate “Requests” section for unknown senders;
- contact compose list using the provisioned contact projection, including multi-select group creation capped at 17 total members;
- group subject, participant summary, rename, mute, leave, and rejoin controls; adding/removing participants creates a new deterministic room and clean history;
- compact message timeline with day/sender grouping and scroll-to-latest;
- text composer supporting keyboard, Scribble, and dictation;
- swipe reply/reaction actions, automatic durable retry, delete-local, and block actions;
- explicit network/saved-history status without blocking existing tasks;
- Digital Crown-friendly scrolling and Dynamic Type/VoiceOver labels.

Keep read state device-local in v1. Mark a thread read only after it becomes visible, not when a background notification is processed.

### 8. Render received photos safely

Only auto-classify an attachment as a photo after a verified kind-15 rumor supplies complete encryption metadata.

The Watch photo loader must:

- accept HTTPS URLs only;
- load with `URLSession`, never `AsyncImage` against the encrypted blob;
- enforce a Watch-specific ciphertext limit, recommended 12 MiB;
- reject non-2xx responses and oversized `Content-Length` before buffering;
- stop a streamed download when the byte cap is exceeded;
- verify the optional SHA-256 ciphertext hash before AES-GCM decryption;
- enforce the plaintext cap;
- inspect actual image data with ImageIO instead of trusting the claimed MIME type;
- reject malformed, multi-frame/decompression-bomb, or excessive-dimension images;
- downsample off the main actor to a maximum needed for the Watch display;
- keep the resulting image in a small memory-only cache and clear it on background.

For unknown senders, use tap-to-load rather than automatic network fetch. Plain image URLs inside text remain links; they are not auto-fetched because doing so leaks the reader's network request to an arbitrary sender-controlled host.

### 9. Register and notify Apple Watch directly

- Add the Push Notifications entitlement to the Watch target.
- Add a Watch application delegate and register for APNs at each configured launch, independently
  of permission to present alerts. Request alert permission separately.
- Give Watch its own installation ID and register `platform: watchos` through NIP-98.
- Configure both `solife.me.Taskify.Native` and `solife.me.Taskify.Native.watchkitapp` as allowlisted APNs topics in the relay/StartOS config.
- Send iPhone and Watch the same content-free `dm-preview` alert at alert priority. Retain
  `dm-wake` handling only for rolling-upgrade compatibility.
- Deep-link only to local Chat state. Do not put sender, category, message, photo metadata, recipient, event ID, or relay cursor in APNs.
- Treat background fetch/decryption as best effort. Foreground cursor refresh is the data fallback
  when watchOS delays the content-available work attached to the alert.

The first Watch release should not attempt rich decrypted notification previews. Chat content appears only after the app runs and decrypts it locally.

## Delivery plan

### Phase 0 — Contract and threat-model gate

- Confirm the one-to-one/group scope, deterministic member-set semantics, 17-member cap, and explicit exclusions above.
- Prove on physical Wi-Fi and cellular Watches that short-lived foreground `URLSessionWebSocketTask` sessions can query bounded discovery relays for kind-10050 without relying on the iPhone. Do not proceed on an assumption derived from simulator behavior.
- Add the Watch metadata boundary and reset/revocation limitations to `docs/native-dm-push-relay.md`.
- Define endpoint schemas, Watch-local routing outcome states, target-list contracts, exact-list/fallback rules, limits, cursors, auth, partial group delivery, and error contracts before implementation.
- Add failing contract tests for replay, cross-account inbox reads, missing/unsafe supplied targets, gateway list enrichment, published-list substitution, false absence fallback, and unsupported kinds.

**Exit gate:** successful physical-Watch direct preference-discovery spike, reviewed protocol/API document, and failing security tests. If the networking spike fails, stop and revisit the privacy/transport architecture rather than silently adding a server-side recipient lookup.

### Phase 1 — Shared crypto and interoperability

- Extract the watch-safe NIP-44/NIP-17/NIP-59/NIP-98 core.
- Keep iPhone behavior unchanged.
- Add Watch <-> native <-> PWA fixture tests for one-to-one/group text, reply, reaction, group subjects/member sets, and kind-15 photo rumors.

**Exit gate:** byte-compatible canonical rumors and unique per-member/self gift wraps, plus all tamper/impersonation tests, pass on watchOS and iOS builds.

### Phase 2 — Narrow push-relay forwarding gateway and watchOS APNs

- Add cursors, NIP-98 endpoints, supplied-target validation, no-enrichment forwarding, bounds, rate limits, local ingest, external forwarding, mandatory short-lived NIP-42 challenge sessions, and per-topic APNs configuration. Do not add recipient preference discovery to the service.
- Add StartOS config migration that preserves the existing iPhone topic and supplies the Watch topic default.
- Verify identical cross-device generic payloads and sender-copy suppression.

**Exit gate:** relay tests prove own-inbox-only access, replay rejection, forwarding only to the exact supplied list, no recipient preference lookups/list enrichment, no private-network proxying, auth-required relay delivery, retention, pagination, token rotation, and iOS/watchOS topic routing.

### Phase 3 — Watch store, receive path, and contacts

- Add versioned contact/inbox provisioning.
- Add the four-state Watch kind-10050 cache/resolver, bounded foreground discovery queries, protected chat store, cursor, dedupe, history pruning, and foreground/manual sync.
- Build one-to-one/group conversation derivation, subject/member handling, requests, unread/read behavior, and text/reaction parsing.

**Exit gate:** an untethered Watch restores 30 days/500 events from the push relay and never needs iPhone state to render a thread.

### Phase 4 — Send path and composer

- Add exact client-side published/fallback target selection, canonical-rumor/per-member wrap creation, durable logical group outbox, independent gateway submissions, per-recipient/per-relay acknowledgements, partial retry, and exact-envelope/target iPhone fallback.
- Add one-to-one/group compose, multi-contact selection, subject/participant UI, replies, reactions, partial delivery status, and retry.

**Exit gate:** airplane-mode queueing followed by Watch-only Wi-Fi/cellular recovery resolves recipient targets without a push-relay lookup, produces exactly one visible message for every one-to-one/group recipient and one convergent sender-history item, and regenerates no rumor or wrap IDs.

### Phase 5 — Received photos

- Add encrypted photo loading, validation, downsampling, tap-to-load privacy behavior, cache clearing, and unsupported attachment cards.

**Exit gate:** valid PWA/iPhone photo messages render; tampered, oversized, deceptive, and malformed images fail closed without memory spikes.

### Phase 6 — Direct Watch notifications and background refresh

- Add permission UI, APNs token lifecycle, generic alert deep link, best-effort background inbox refresh, and logout/unregister.

**Exit gate:** iPhone and Watch token rotation works, a sender copy never alerts the author, and a message presents once at Apple's selected device.

### Phase 7 — Real-device interoperability and rollout

- Test Taskify-to-Taskify and at least two independent NIP-17 clients.
- Test one-to-one and max-size group recipients with distinct inbox lists, multiple inbox relays, one unavailable relay, and one auth-required relay.
- Exercise the bounded Watch-signed NIP-42 challenge session against the supported interoperability matrix.
- Ship behind a Watch Chat feature flag, then staged TestFlight rollout.

**Exit gate:** privacy review, battery/memory soak, real cellular test, accessibility pass, and rollback switch are complete.

## Test matrix

### Protocol and security

- Every non-self group member and the sender self-copy receives a unique wrap around one canonical rumor ID; no recipient wrap is reused for another member.
- The rumor author plus normalized `p` tags derive the same room on Watch, native iOS, and PWA; changing that set derives a new room with clean history.
- Group creation enforces 2–17 total unique members, rejects duplicates/invalid keys, and never exposes an administrator or mutable server-side roster concept.
- Wrong recipient, invalid outer signature, invalid seal, seal/rumor author mismatch, invalid rumor ID, duplicate tags, oversized content, and unknown kinds fail closed.
- Cross-account inbox reads and APNs registration changes return 401/403.
- NIP-98 method, URL, body, time, and one-use replay checks are enforced.
- Outbox submission requires a bounded client-supplied public relay list and exactly one valid kind-1059; missing, unsafe, duplicate, malformed, and over-limit targets fail closed.
- The Watch uses a valid non-empty published kind-10050 list exactly; neither it nor the gateway unions the Taskify push relay/defaults into that list.
- Watch-confirmed absence selects exactly `relay.damus.io`, `nos.lol`, and `relay.solife.me`; lookup timeout/partial failure, published-but-unusable data, and over-limit published lists never select fallback.
- Multiple valid preference events resolve locally to the newest signed event, with deterministic URL normalization and no silent truncation.
- The gateway performs no recipient kind-10050 query, attempts every supplied relay and no others, and directly ingests only when the Watch supplied `wss://push.solife.me`.
- NIP-42 sessions bind account, relay, challenge, original wrap ID, expiry, and one-use authorization; altered or replayed authorizations fail closed.
- Relay SSRF tests cover URL credentials, redirects, DNS rebinding, private IPv4/IPv6, localhost, and `.local`.
- Logs, traces, metrics labels, and APNs payload snapshots contain none of the forbidden plaintext, identity, recipient-list, selected-relay, or group-correlation fields.

### Persistence and delivery

- Store migration from task-only Watch schema succeeds with empty chat state.
- Crash/relaunch between local outbox write and network submission does not lose or duplicate a message.
- Partial group recipient/self acknowledgement retries only unfinished wraps and remaining selected relays, preserving every event ID.
- A group is sent only after every non-self recipient has at least one acknowledgement from that recipient's own selected list; partial state identifies unfinished recipients without exposing them in logs.
- A permanently unavailable selected relay does not cause substitution with Taskify defaults; the Watch retains its replication retry state until expiry.
- A stale/missing recipient preference with incomplete direct discovery stays queued and is not sent to the gateway as a recipient lookup request.
- Late and out-of-order gift wraps are returned after an ingestion cursor and deduplicated by IDs.
- Local delete/block/clear survives relaunch and suppresses the 30-day relay replay window.
- Account reprovisioning clears the previous account's chat, cursor, media cache, outbox, and token registration.

### Photo safety

- Current and legacy PWA encrypted-photo fixtures decrypt and downsample.
- Hash mismatch, GCM failure, incorrect MIME claim, huge dimensions, excessive frames, oversized body, non-HTTPS URL, and HTTP error display a safe failure state.
- Unknown-sender photos make no request before user action.

### Real device

- Paired iPhone available, paired iPhone unreachable, and paired iPhone powered off.
- Watch Wi-Fi only and Watch cellular only.
- One-to-one, three-member, and 17-member group sends where recipients publish different inbox lists.
- Group reply/reaction receipt, rename, leave/rejoin, and add/remove-member-new-room behavior.
- iPhone Wi-Fi and Bluetooth disabled in Settings, not only Control Center.
- Watch locked/unlocked, passcode removed, app terminated, network transition, and token rotation.
- 500-event inbox recovery, long conversation scroll, repeated foreground cycles, and photo memory pressure.
- Notification enabled on both devices, only iPhone, only Watch, and neither.

The simulator is insufficient for final networking, APNs, memory, and watchOS background conclusions.

## Rollout and observability

- Feature flags: relay HTTPS gateway, Watch Chat UI, Watch APNs registration, and third-party NIP-42 session flow. General availability requires all four for the supported relay matrix.
- Aggregate metrics only: request count, latency bucket, status class, page size, per-relay success count, retry count, and APNs status code.
- Never record account key, recipient key, event ID, event body, relay query authors, device token, preview token, message type, attachment fields, or URLs.
- Add a server kill switch that disables new Watch publishes/queries without affecting standard NIP-17 WebSocket relay operation or iPhone push.
- Preserve backward compatibility with existing relay state and registrations during rollout.

## Main risks

| Risk | Mitigation |
|---|---|
| watchOS background execution is not guaranteed | Direct generic APNs plus foreground cursor recovery is the reliability contract; background decrypt is only an optimization. |
| Proxying leaks sender/recipient routing metadata to Taskify | Keep content E2EE, submit group wraps independently, document the residual timing inference, do not log associations, minimize request scope, and use the already-disclosed push relay rather than a second service. |
| Auth-only relays require a stateful handshake | Use only the short-lived Watch-signed NIP-42 session bound to one socket/challenge/wrap; keep it memory-only and never give the gateway a user signing key. |
| Direct Watch relay discovery is foreground-only and may fail on constrained networks | Seed signed preferences locally from the iPhone, cache verified positives, use short-lived Watch WebSockets when stale, keep indeterminate sends queued, and never trade the privacy boundary for a push-relay recipient lookup. |
| Relay discovery failure could be mistaken for no published list | Model published, confirmed-absent, published-but-unusable, and indeterminate outcomes on the Watch separately; defaults are legal only for confirmed absence. |
| Large or hostile published lists could exhaust the gateway | Apply explicit documented list/concurrency bounds and fail without truncation, union, or fallback; process valid in-bound lists with bounded fan-out. |
| Group sends amplify metadata and battery use | Keep the logical batch local, submit one wrap per request with bounded concurrency/jitter, reuse HTTPS connections, and test maximum-size groups on cellular. |
| Full account nsec on Watch has no remote cryptographic revocation | Retain passcode-required device-only Keychain, add explicit reset/unregister, rely on Watch erase/Activation Lock for loss, and clearly disclose that true revocation requires account-key rotation. |
| Photo decompression exhausts Watch memory | Small ciphertext/plaintext limits, ImageIO inspection, off-main downsampling, memory-only bounded cache, and real-device soak tests. |
| Application-context size regresses task sync | LZFSE-compress the snapshot, trim trailing tasks first and then oldest projected threads, and keep full chat history/envelopes out of the task snapshot. |
| Duplicate alerts on iPhone and Watch | Send byte-equivalent metadata-free alert bodies to both APNs topics so Apple can select the best destination, and test best-destination behavior on physical devices. Direct generic alerts cannot honor encrypted per-group mute state until a notification extension ships. |

## Definition of done

The work is complete when a provisioned Watch, with the paired iPhone powered off, can over its own Wi-Fi or cellular connection:

1. receive a metadata-free generic APNs alert with a content-available inbox refresh opportunity;
2. fetch only its own stored gift wraps;
3. verify and decrypt text/reply/reaction/photo messages locally;
4. show one-to-one/group conversations, subjects/participants, requests, unread state, and a safely downsampled received photo;
5. create a group of up to 17 total members and durably send text/reply/reaction using one canonical rumor plus unique recipient and self wraps;
6. resolve every recipient on the Watch, selecting the exact newest valid published list or exactly the current Taskify defaults only after confirmed absence, then have the gateway forward to that supplied list without discovery or enrichment;
7. show per-recipient partial delivery, retry unfinished selected relays without changing event IDs, and complete sender self-copy convergence;
8. recover from offline/timeout/relaunch without message loss or duplication;
9. converge the sent and received history with the iPhone/PWA through standard NIP-17 events;
10. pass the security, real-device, battery, memory, metadata, and interoperability gates above without placing plaintext or keys on the relay or in APNs.
