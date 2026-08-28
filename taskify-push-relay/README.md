# Taskify Push Relay

Taskify Push Relay is a restricted Nostr inbox relay and Apple Push Notification service bridge.
It stores encrypted NIP-59 gift wraps, exposes the NIP-17 inbox preference event, and sends a
generic APNs alert with a short-lived opaque preview URL when a new recipient copy arrives.

The relay cannot decrypt the gift wrap. The native iOS notification extension fetches and unwraps
it locally to produce message and activity previews. Payment notifications are created only after
the app successfully redeems the Cashu token, so `Payment Received` never reflects an unverified
claimed amount. Device registration
uses a NIP-98 request signed by the user's Nostr identity. Gift-wrap reads and writes require
NIP-42 authentication; kind `10050` inbox preferences remain publicly discoverable as NIP-17
requires.

## Runtime

- HTTPS registration API: `PUT`/`DELETE /v1/registrations/:installationID`
- Nostr WebSocket relay: kinds `1059` and `10050`
- Health endpoint: `GET /healthz`
- One-use-style preview retrieval: `GET /v1/previews/:opaqueToken` (expires after 15 minutes)
- Persistent state: `/data/state.json`
- APNs configuration: `/data/apns.json`
- Event retention: 30 days, at most 500 wraps per recipient and 100,000 total
- Device registrations: at most 10 per Nostr account and 100,000 total
- APNs jobs survive restarts and retry temporary failures with bounded exponential backoff

The production public origins are intentionally pinned to `https://push.solife.me` and
`wss://push.solife.me` so NIP-98 and NIP-42 signatures cannot be replayed to a different origin.

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

The iOS Notification Service Extension needs Apple's managed Notification Filtering entitlement
to suppress decrypted categories the user did not select and to hide payment gift wraps until
redemption succeeds.
