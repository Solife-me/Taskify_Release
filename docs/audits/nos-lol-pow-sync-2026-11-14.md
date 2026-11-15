# nos.lol proof-of-work and sync audit — 2026-11-14

## Live relay findings

- `https://nos.lol` returned NIP-11 metadata without `limitation.min_pow_difficulty` and did not advertise NIP-13.
- A read subscription completed normally (the sampled request returned an event in 686 ms).
- Recent stored kind 1 notes, kind 1059 NIP-17 gift wraps, and kind 30301 Taskify events included events with no nonce target and only 0–4 naturally leading zero bits. nos.lol is therefore accepting and storing these event kinds without a universal PoW floor.
- Short-lived writes from a new disposable key received no `OK` response at either difficulty 0 or 20. This does not establish a PoW requirement: raising PoW to 20 did not change the result, while established traffic without PoW was visible. The behavior is consistent with a separate spam/new-pubkey write policy or a silent write timeout.

## Regression

Taskify had a hard-coded 20-bit floor for nos.lol in both the Swift and TypeScript relay requirement caches. Native NIP-17 sending prepared one gift-wrap batch for the maximum requirement across the union of sender and recipient relays. Consequently, nos.lol made every chat copy wait for mining before the ordinary Solife copy could even enter the durable outbox. Mining timeout or queue failure produced the user-visible “could not queue” alert.

## Resolution

- Removed the invented nos.lol floor. Requirements now come only from NIP-11 or a relay's explicit `pow:` rejection and remain bounded by the supported client maximum.
- Native chat creates separate gift wraps for ordinary and PoW relays. The ordinary batch is durably queued first; cached requirements are used immediately and uncached NIP-11 requirements are discovered in the background before PoW copies are prepared, so a slow public relay cannot delay Solife.
- Preserved the existing per-relay rejection learning, remine/re-sign recovery, holdback, pacing, and durable retry behavior for relays that really require NIP-13 work.
- Added regressions for independent NIP-17 relay routing and for not inventing a nos.lol requirement.

## Verification

- `taskify-runtime-nostr`: 94 tests passed.
- Native focused PoW/outbox/routing suite: 25 tests passed.
- PWA TypeScript checks passed.
- Complete unsigned iOS app build succeeded.


## Follow-up on Beta

The native hard-coded floor returned in a merge. It has been removed again. The current
native outbox preserves a plain event for ordinary relays and shares a separate mined copy
across verified PoW targets. Relay-specified floors can come from NIP-11 or an explicit
`pow:` rejection.

- The Solife relay advertised `min_pow_difficulty: 10`.
- Snort and Minibits advertised no floor. A read-only sample found recent events below 10 bits
  on Primal, Snort, and Minibits.
- Damus and nos.lol did not provide conclusive results in the follow-up. The earlier nos.lol
  sample above showed stored events below 20 bits.
