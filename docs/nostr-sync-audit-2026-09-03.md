# Nostr sync pipeline audit — September 3, 2026

## Result and scope

The pipeline had concrete reliability and relay-compatibility defects. The changes below correct
those defects and retain the recent overheating fix. This is an implementation audit with
regression tests, not a claim of perfect performance, exhaustive interoperability, or a formal
cryptographic certification. Remaining architectural gaps are listed separately.

Reviewed: native transport and task/calendar sync, durable outbox, inbox processing and routing,
NIP-17/59 construction and verification, NIP-44 implementation boundaries, contacts/account
backup retrieval, Watch discovery/delivery and shared cryptography, the Taskify HTTPS/WebSocket
relay, and the shared web runtime's subscriptions, cursors, publisher, relay health and limits.
Wallet/payment integration was checked at the shared inbox/outbox boundary; third-party CDK,
NDK and cryptographic library internals were not independently audited.

## Changes made

| Area | Defect | Correction |
| --- | --- | --- |
| Native publish rejection | Two rejections of a kind removed all queued events of that kind and reported them sent—even if no relay accepted them. | Preserve durable changes; defer only the rejected event on that relay. Later events of the same kind remain eligible. Explicit user relay exclusions remain supported. |
| Native and gateway acknowledgements | A false OK with `duplicate` text counted as success. | Only a true acceptance boolean confirms delivery. Ignore irrelevant acknowledgements without accumulating rejected IDs. |
| Native history interruption | Verified task records were remembered as seen before delivery; reconnect could discard their EOSE buffer and suppress their replay. | Flush verified batches periodically (200 ms) and before connection cleanup/replacement. |
| Native history cursors | An unverified event could move a cursor; a partial newest-first response could skip unseen older history on reconnect. | Validate routing and signatures before caching; use completed-history checkpoints, preserving the previous checkpoint during interrupted downloads. |
| Native duplicate work | Task/calendar duplicates from other relays were decrypted before deduplication. | Check previously verified IDs before decryption; validate the ID's content when using its trusted timestamp to update another relay's checkpoint. |
| Native transport | Malformed JSON or a malformed event ended the entire socket's receive loop. | Ignore malformed frames while retaining healthy subscriptions. |
| Native authentication | Several simultaneous auth-required replies caused repeated signing/sending; an unanswered AUTH could stall indefinitely. | Coalesce pending authorization and reconnect with backoff after a 15-second authorization timeout. |
| Task timestamps | Bulk sync incremented an app-wide clock once per unrelated task, creating future timestamps and potential relay rejection. | Advance each task's clock relative to its own prior version. |
| Replaceable preferences | Equal timestamps could select different inbox lists depending on arrival order. | Lowest event ID wins on iPhone and Watch. Apply the same tie order to contact/profile and account-backup retrieval. |
| Event/gift-wrap validation | Some malformed event shapes and nonconforming seal/rumor structures were accepted. | Check key/ID/signature shapes and kind range; require empty seal tags and unsigned inner rumors while retaining existing sender verification. |
| NIP-44 size boundary | The encryption limit measured plaintext, but decryption applied that same limit to the larger padded envelope. | Account for padding, nonce, MAC and version; validate key length and bound base64 before decoding. Phone and Watch round-trip the supported maximum. |
| Web subscription state | An event updated every OR-filter cursor; cursors lacked DM timestamp overlap and relay-set isolation. Concurrent callers could create duplicate subscriptions. | Advance only matching filters after delivery and EOSE; retain two-day DM overlap plus slack; separate relay sets/event-ID filters; share concurrent subscriptions. Flush hidden-page work without waiting for animation frames. |
| Web durable publishing | An old publication's acknowledgement could remove a newer replacement at the same outbox key; a failed durable save could still publish. | Serialize outbox mutations per key, correlate results with the exact signed event ID, and stop before networking if persistence fails. |
| Gateway history | History was oldest-first and combined filters used a single limit. ID/author matching allowed prefixes. | Newest-first results, deterministic ties, per-filter limits, exact matching, and continued live delivery beyond history limits. |
| Relay capability metadata | The relay advertised NIP-09 without accepting deletion requests. | Remove that unsupported capability claim. This does not implement remote deletion. |

## Intentional fallback DM policy

At the user's explicit request, fallback sending and receiving compatibility remains supported.
Usable recipient-signed kind-10050 inbox lists take precedence. The iPhone retains discovery-relay
fallbacks and now listens on configured app relays while its own inbox list is unavailable;
the Watch retains confirmed-absence fallback and its existing bounded degraded-routing
policy. The gateway never adds targets on its own. A recipient must actually listen on a fallback
relay to receive a fallback message; an upstream storage acknowledgement cannot prove that.

This intentionally differs from NIP-17's strict requirement to publish only to advertised inbox
relays. Encryption and signature verification still apply. Fallback relays can observe the
recipient tag and routing metadata; they do not gain the message plaintext or private keys.

## Remaining work before calling the pipeline optimal

1. **P1 — Complete history recovery beyond result limits.** Native subscriptions request at most
   2,000 board events and 500 inbox events, with a 30-day inbox window. Neither a limit nor EOSE
   proves that every matching historical event was returned. There is no general paginated
   backfill/reconciliation loop, including same-second page boundaries. Large accounts and
   late-arriving old events therefore still need explicit recovery work. The web runtime also
   limits requests using relay information without a general completeness guarantee. The Taskify
   relay itself retains at most 500 wraps per recipient; pagination cannot recover pruned data.
2. **P2 — Shared native connection ownership.** The main sync engine shares a socket per relay,
   but contact/profile, backup and preference fetchers open additional short-lived sockets.
   Those helpers do not share the engine's NIP-42 state. A connection broker with multiplexed
   request ownership would reduce handshakes and improve compatibility with restricted relays.
3. **P2 — Persisted tie-breaking for task/calendar/board merges.** Preference selection now uses
   NIP-01 tie-breaking, but local task/board/calendar merge records retain timestamps rather than
   the signed event ID. Equal-time conflicting versions can still converge differently across
   clients. Fixing this requires carrying event IDs through persisted models and matching the
   PWA merge contract, with migration and cross-client tests.
4. **P2 — Native relay limits and sustained-load bounds.** Publish pacing and four in-flight events
   per relay are bounded, but the native engine does not adapt subscriptions to NIP-11 limits.
   Receive/update streams deliberately avoid dropping events and remain unbounded under a
   persistently faster producer. A durable intake queue or backpressure design is preferable to
   silently dropping messages. Other publication paths still use the older app-wide clock.
5. **Interoperability limits.** The restricted Taskify relay has no kind-5 deletion handling and
   models one authenticated identity per socket. Auxiliary native fetches can lose partially
   received results at their timeout. These limitations are not fixed by the changes above.

No user history was cleared, no messages were sent for testing, and no production relay was
reconfigured or deployed. A live multi-relay soak and actual Watch cellular/Bluetooth checks
remain necessary after deployment; local tests cannot establish those operating conditions.

## Validation

- Native/Watch package: 600 XCTest cases across the core and Watch runtime suites, 9 skipped,
  zero failures; two additional Swift Testing cases passed. The skips require the optional
  attachment HTTP test server.
- Shared web runtime: 19 tests passed, including cursor isolation, forged-first event handling,
  concurrent subscription reuse, old-ack/new-replacement protection, and failed persistence.
- PWA Nostr integration: 78 passed, one skipped.
- Taskify relay: 47 passed, including real local WebSocket history ordering/per-filter limits,
  live events after EOSE, recipient-only access, HTTPS discovery and forwarded acknowledgements.
- iOS app plus embedded Watch app: Local configuration build succeeded with signing disabled.
- No live deployment or new physical-device performance measurement in this audit.

## Primary specifications checked

- [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md): framing, event verification,
  exact filters, replacement order, acknowledgements and history/live semantics.
- [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md): recipient-specific inbox lists,
  sender copies and randomized envelope timestamps. Fallback routing is the explicit exception.
- [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md): challenge authentication,
  AUTH acknowledgements and retrying restricted requests after authentication.
- [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) and
  [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md): encryption framing, seals,
  unsigned rumors and sender binding.
- [NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md),
  [NIP-51](https://github.com/nostr-protocol/nips/blob/master/51.md),
  [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md), and
  [NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md): relay capabilities,
  contacts/list formats, request authentication and deletion support boundaries.
