# Taskify Push Relay

Taskify Push Relay is a restricted Nostr inbox relay and Apple Push Notification service bridge.
It stores encrypted NIP-59 gift wraps, exposes the NIP-17 inbox preference event, and sends a
metadata-free generic APNs alert when a new recipient copy arrives.

The independent Apple Watch client uses the same encrypted inbox through a narrow NIP-98 HTTPS
gateway. The Watch creates and signs every event, retrieves public kind `10050` preferences
through HTTPS, verifies them locally, and supplies the exact relay targets. The gateway performs
bounded public lookups but never selects or adds delivery targets. watchOS receives a metadata-free generic alert plus a
background refresh opportunity, then decrypts the inbox locally.

For task and board sync, the Watch sends a short-lived, board-key-signed access proof for each
board it currently subscribes to. The gateway queries only those exact derived board authors and
public board tags on the Watch-supplied relays, rejects unrelated results, and caches only the
latest encrypted replaceable event for each requested coordinate. It does not crawl or cache the
rest of any upstream relay. The Watch verifies signatures and decrypts all board and task payloads
locally. If this gateway is unavailable, the Watch retries through `https://taskify.solife.me`.

The relay cannot decrypt the gift wrap. It sends only a generic alert; the app fetches and unwraps
the message locally. iPhone alerts also carry `mutable-content` and a random, 15-minute preview URL
so the iOS Notification Service Extension can fetch the encrypted gift wrap, decrypt it on the
device, and replace the generic text with a rich preview. The extension does not use Apple's
Notification Filtering entitlement, so encrypted category, block, and per-conversation mute choices
cannot suppress the remote arrival alert; they leave it generic instead. Payment notifications are created only after the app successfully redeems the Cashu token,
so `Payment Received` never reflects an unverified claimed amount. Device registration
uses a NIP-98 request signed by the user's Nostr identity. Gift-wrap reads and writes require
NIP-42 authentication; kind `10050` inbox preferences remain publicly discoverable as NIP-17
requires.

## Runtime

- HTTPS registration API: `PUT`/`DELETE /v1/registrations/:installationID`
- Watch inbox API: `POST /v1/watch/inbox/query`
- Watch propagation API: `POST /v1/watch/outbox/submit` and short-lived NIP-42 continuation at
  `POST /v1/watch/outbox/:session/authorize`
- Watch inbox-preference publication: `POST /v1/watch/inbox-preference/publish`
- Watch public inbox-preference lookup: `POST /v1/watch/inbox-preference/query`
- Watch task/board gather API: `POST /v1/watch/tasks/query`
- Watch task/board propagation API: `POST /v1/watch/task-events/publish`
- Nostr WebSocket relay: kinds `1059` and `10050`
- Health endpoint: `GET /healthz`
- One-use-style preview retrieval: `GET /v1/previews/:opaqueToken` (expires after 15 minutes)
- Persistent state: `/data/state.json`
- APNs configuration: `/data/apns.json`
- Separate iOS and watchOS APNs topics; the defaults are `solife.me.Taskify.Native` and
  `solife.me.Taskify.Native.watchkitapp`
- Event retention: 30 days, at most 500 wraps per recipient and 100,000 total
- Task/board cache retention: latest encrypted event per replaceable coordinate, discarded after
  30 days without being observed, at most 2,000 per public board author and 100,000 total
- Device registrations: at most 10 per Nostr account and 100,000 total
- APNs jobs survive restarts and retry temporary failures with bounded exponential backoff

The production public origins are intentionally pinned to `https://push.solife.me` and
`wss://push.solife.me` so NIP-98 and NIP-42 signatures cannot be replayed to a different origin.
Watch forwarding accepts only a bounded, non-empty list of unique public `wss://` targets and
rejects credentials, local/private/link-local hosts, and DNS answers containing private addresses.
Task-cache reads additionally require a fresh board-key proof bound to the authenticated Watch
account and this exact HTTPS endpoint. Durable task-cache entries contain only the public event
coordinate, signed ciphertext event, and last-observed time; no account, device, relay-list, or
subscription mapping is stored with them.

Watch DM submissions can opt into `returnAfterFirstAccepted: true`. The gateway responds after
the first supplied target actually accepts the immutable gift wrap, with unfinished targets
reported as `pending` (HTTP 202). Local inbox ingestion is scheduled first when the caller
included this relay. Forwarding continues to every remaining supplied target with at most four
concurrent operations; the Watch keeps pending copies in its durable outbox and retries them
using the same event ID. Without an acceptance, the gateway waits for all results, including
NIP-42 challenges. Older clients that omit the flag still receive all results together. This
option applies only to DM outbox submissions, not task or preference publication.

The preference lookup takes exactly `{ recipientPublicKey, relays }` under body-bound NIP-98
authentication. It queries kind `10050` for that single recipient on at most eight caller-supplied
public discovery relays, with four concurrent queries, two seconds per remote query, and a
five-second overall deadline. The same DNS pinning/private-address protections apply as for
forwarding. If the local relay is selected, its existing public preference store is read directly.
The response is `{ events, completedRelays }`: at most four events per relay, each at most 8 KiB,
deduplicated and filtered to valid signatures for the requested author and kind. Completion
requires EOSE; failures, invalid results, and truncated replies do not establish absence. The
Watch independently verifies signatures, selects the newest event, and evaluates whether enough
independent relays completed before treating an empty result as absence.

Lookup results and sender-recipient associations are not persisted or logged by the lookup
handler. Lookup requests are made for pending recipients or the account's own inbox enrollment,
not to scan a contact directory. The Watch retains the routing cache. The gateway operator can
observe the authenticated account, queried recipient, discovery relays, timing, and connection
metadata. HTTPS does not conceal that information from the operator. Watch authentication is
never forwarded to upstream discovery relays, and private keys and message plaintext stay on
the client. This metadata tradeoff was explicitly approved on 2026-09-02.

Deploy this gateway before the updated Watch client. HTTPS discovery replaces the unsupported
direct `URLSessionWebSocketTask` path described in
[Apple TN3135](https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchos).
An unavailable or older gateway produces an incomplete lookup, not confirmed absence; normal
durable outbox retry/fallback policy still applies.

## Protocol audit

See the [September 2026 pipeline audit](../docs/audits/nostr-sync-audit-2026-09-03.md). WebSocket history
is newest-first, resolves equal timestamps by ascending event ID, and applies each filter's
limit independently; limits do not suppress subsequent live events. ID/author filters use exact
matches. Forwarding honors the relay's OK acceptance boolean even if rejection text says
`duplicate`. The NIP-11 capability list no longer claims NIP-09 deletion support: kind-5 deletion
requests are not implemented. Existing retention limits continue to apply.

Client fallback DM delivery remains supported for users without published inbox preferences.
The gateway forwards only the targets explicitly supplied by the Watch and does not choose
fallbacks itself. These source changes require a gateway deployment to affect the running service.

## Development

```sh
npm install
npm test
npm run check
npm run build
make x86
```

`make x86` produces the StartOS package. `make arm` builds the aarch64 variant.

Never commit an APNs `.p8` key. On StartOS, use the **Configure Apple Push** action; the key is
entered by pasting the complete `.p8` contents into the masked field. It is stored mode `0600` in
the encrypted service volume and included in StartOS backups.

The iOS Notification Service Extension ships without Apple's managed Notification Filtering
entitlement, so decrypted categories the user did not select and payment gift wraps keep the
generic alert. Adding the entitlement later lets the extension hide them instead; suppression
requires the `apns-push-type: alert` header this relay already sends.
