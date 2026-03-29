# Taskify iOS

Native SwiftUI iOS app for [Taskify](https://taskify.so) — full feature parity with the PWA, built on Nostr.

## Architecture

```
taskify-ios/
├── Package.swift
├── Sources/
│   ├── TaskifyCore/           # Reusable framework (crypto, relay, sync, models)
│   │   ├── Crypto/
│   │   │   ├── BoardCrypto.swift      # AES-GCM (tasks) + NIP-44 (calendar) crypto
│   │   │   ├── NIP44.swift            # NIP-44 v2 bare implementation
│   │   │   └── Secp256k1Helpers.swift # secp256k1 key ops + Schnorr signing
│   │   ├── Models/
│   │   │   ├── NostrEvent.swift       # Nostr event types + relay messages
│   │   │   └── TaskifyModels.swift    # SwiftData models (Task, Event, Board)
│   │   ├── Relay/
│   │   │   ├── RelayPool.swift        # WebSocket pool — mirrors RuntimeNostrSession
│   │   │   └── RelayConnection.swift  # Single relay + exponential backoff reconnect
│   │   ├── Sync/
│   │   │   └── SyncEngine.swift       # Per-relay batch sync — mirrors App.tsx subscription
│   │   └── Config/
│   │       └── KeychainStore.swift    # Secure nsec / profile storage
│   └── TaskifyApp/
│       └── TaskifyApp.swift           # SwiftUI app entry point
└── Tests/
    └── TaskifyCoreTests/
        └── CryptoInteropTests.swift   # Crypto interop tests (vs. PWA/CLI vectors)
```

## PWA references

| iOS component | PWA reference |
|---------------|---------------|
| `RelayPool` | `taskify-runtime-nostr/RuntimeNostrSession.ts` + `SubscriptionManager.ts` |
| `SyncEngine` | `taskify-pwa/src/App.tsx` (board subscription effect, `relayBatchRef`) |
| `CursorStore` | `taskify-runtime-nostr/CursorStore.ts` |
| `EventCache` | `taskify-runtime-nostr/EventCache.ts` |
| `BoardCrypto` | `taskify-core/boardCrypto.ts` + `taskify-cli/calendarCrypto.ts` |
| `NIP44` | `nostr-tools` nip44.v2 |
| `KeychainStore` | `taskify-pwa/src/nostrKeys.ts` + localStorage/kvStorage |
| `TaskifyModels` | `FullTaskRecord`, `FullEventRecord`, `BoardEntry` types across PWA + CLI |

## Crypto interop

All crypto must be byte-for-bit compatible with the PWA:

| Scheme | Used for | Key derivation |
|--------|----------|----------------|
| AES-256-GCM | Task events (kind 30301) | `SHA-256(UTF8(boardId))` |
| NIP-44 v2 | Calendar events (kind 30310/30311) | `SHA-256("taskify-board-nostr-key-v1" \|\| UTF8(boardId))` → secp256k1 → self-ECDH |
| Board tag hash | `#b` filter tag | `SHA-256(UTF8(boardId))` → hex |

## Sync architecture

Mirrors App.tsx `relayBatchRef` pattern:

1. SwiftData renders immediately on app open (no relay wait)
2. Per-relay batch maps hold incoming events until that relay's EOSE
3. On each EOSE: flush batch with clock-protected merge (`event.created_at >= existing.createdAt`)
4. 25s absolute timeout flushes any stuck relays
5. 150ms live micro-batch coalescer for post-EOSE live events

## Dependencies

- [swift-secp256k1](https://github.com/21-DOT-DEV/swift-secp256k1) — secp256k1 (NIP-44 ECDH, Schnorr)
- Swift CryptoKit — AES-GCM, SHA-256, HKDF, HMAC (built-in)
- SwiftData — local persistence (iOS 17+)
- URLSessionWebSocketTask — Nostr relay WebSocket (built-in, no NDK)

## Setup

1. Install Xcode 15+ (Swift 5.10)
2. `cd taskify-ios && swift package resolve`
3. `swift test` — run crypto interop tests first
4. `xed .` to open in Xcode

## Delivery phases

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | ✅ Scaffolded | Foundation: crypto, relay, sync, SwiftData schema |
| 2 | Pending | Core task UX: board list, week view, list view, task CRUD |
| 3 | Pending | Full parity: calendar, compound boards, recurrence, sharing |
| 4 | Pending | Polish: offline mode, widgets, TestFlight |
