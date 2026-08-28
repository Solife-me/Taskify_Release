# Native DM Push Relay Contract

Taskify's iOS DM push service is a dedicated, ordinary NIP-17 inbox relay with an APNs hook. It does not introduce a Taskify-specific Nostr message type or require the service to decrypt messages. The production origins are `wss://push.solife.me` and `https://push.solife.me`.

## Privacy boundary

- The app sends the APNs device token and installation metadata to the push service over authenticated HTTPS. APNs tokens never appear in Nostr events.
- Nostr contains only the standard signed kind-10050 relay list and normal kind-1059 gift wraps.
- The service never receives an `nsec`, NIP-44 key, plaintext message, sender tag, preview text, task title, or attachment metadata.
- APNs receives a generic visible alert plus a random, 15-minute HTTPS capability URL. The URL contains no event ID, public key, sender, category, or plaintext. A Notification Service Extension fetches the encrypted kind-1059 event and performs NIP-17 verification and decryption on the iPhone.
- Apple can observe notification timing, the generic fallback text, and the opaque capability URL. The push relay can observe when that URL is fetched. Neither receives the decrypted sender, category, message, task title, reaction, invitation, or payment amount.
- The relay can still observe the recipient public key from the outer `p` tag, arrival time, ciphertext size, network metadata, and registered-device relationship. If NIP-42 is required for writes, it can also observe the authenticated publisher during that connection even though the gift wrap itself does not reveal the sender. Do not persist authentication-to-recipient correlations, and disclose this metadata boundary.

## Enable flow

1. The user explicitly enables DM notifications in Taskify Settings.
2. iOS notification authorization is requested and the app registers with APNs.
3. The app registers the current APNs token with the push service over authenticated HTTPS. The registration is bound to the user's public key and a random installation identifier.
4. The app reads the newest valid kind-10050 event, preserves its existing relay entries, appends the dedicated push relay, and publishes a new signed replaceable kind-10050 event to discovery relays and both the old and new inbox sets.
5. The app reconfigures its inbox subscription to the updated advertised set.
6. The user chooses whether notifications are created for messages/activity, received ecash payments, or both. This preference remains in the shared app container on the iPhone and is not registered with the service.

The HTTPS registration must succeed before the push relay is advertised. That avoids directing senders to a relay that cannot notify the device.

## Disable flow

1. Disable the installation at the push service over authenticated HTTPS.
2. When this was the account's last registered installation, read-modify-write the newest kind-10050 event, removing only the dedicated push relay while preserving the user's other inbox relays.
3. Reconfigure native relay subscriptions.

Device-token rotation uses the same authenticated registration endpoint. The service removes registrations when APNs reports that a token is no longer valid.

## Relay behavior

- Accept and validate standard signed kind-1059 events. Do not require a nonstandard payload or tag.
- Store gift wraps for 30 days with bounded per-recipient and global retention so the service remains a complete asynchronous NIP-17 inbox rather than a push-only event sink.
- Require NIP-42 for recipient reads and authorize reads so an authenticated account can request only gift wraps addressed to its public key.
- Rate-limit writes, deduplicate event IDs, cap event size, and expire old events.
- Map the outer recipient `p` tag to enabled installations and send a generic APNs alert containing a unique, short-lived preview URL. Never attempt server-side NIP-44 decryption.
- If authenticated writes are required, suppress the visible notification when the authenticated publisher is also the outer recipient; this prevents a sender's self-copy from notifying their own device without adding a sender-identifying Nostr tag. If the deployment avoids write authentication for stronger sender-metadata privacy, Taskify should omit the dedicated push relay from its sender-copy destination set while still storing that copy on at least one other relay from the sender's kind-10050 list.

The implementation requires NIP-42. Taskify answers the relay challenge, retries any pre-authentication subscription or publish, and suppresses APNs for an authenticated account's own `p` copy.

## Registration and APNs

- `PUT /v1/registrations/:installationID` registers or rotates one APNs token. `DELETE` disables it.
- Every request carries a signed NIP-98 kind-27235 event bound to the exact URL, HTTP method, and SHA-256 payload hash. Events are fresh and one-use.
- Tokens are namespaced by authenticated Nostr public key and installation ID. Moving an installation or token removes its stale association.
- Registrations are bounded to 10 installations per account and 100,000 total so authenticated key generation cannot grow the service state without limit.
- APNs uses token authentication with ES256, `apns-push-type: alert`, priority `10`, `mutable-content: 1`, and `content-available: 1`. Each delivery has its own preview token and is not collapsed with a different encrypted event.
- Invalid APNs tokens are removed. Temporary APNs failures are persisted and retried with bounded exponential backoff.
- The service extension creates rich message/activity previews locally after decryption. It supports ordinary messages, attachments, reactions, task assignments and shares, contact shares, calendar invitations, assignment responses, board invitations, and group subject changes. Cached contacts use their display name; an uncached contact appears as `Unknown sender` with a shortened npub.
- Message previews show the first three non-empty lines, bounded to 240 characters. The normal title is `New Message`; activity-specific titles include forms such as `Reacted 👍`, `New task assignment`, and `New invitation`.
- Payment gift wraps are not presented as receipts from their unverified claimed amount. The background app path redeems the Cashu token first and then creates a local `Payment Received` notification containing the verified amount and cached sender name when available.
- The local result carries only a device-local tab destination. Tapping message/activity notifications opens Chat, while tapping `Payment Received` opens Wallet. The destination is added after on-device processing and is never sent through APNs or exposed to the push relay.

The generic APNs alert can be replaced by the service extension without launching the main app. Payment redemption still depends on best-effort background app execution; if iOS withholds it, Taskify finishes redemption the next time the app runs. A force-quit app is not relaunched in the background. The generic fallback reveals no encrypted-event category.

Suppressing decrypted but unselected categories and suppressing an unverified payment alert use Apple's Notification Filtering entitlement (`com.apple.developer.usernotifications.filtering`) on the Notification Service Extension. Apple must approve that managed capability for the extension App ID before an App Store or TestFlight signing profile can include it. App Groups and the shared Keychain Access Group must also be enabled for both the app and extension provisioning setup.

## Multi-device and replaceable-event safety

Kind 10050 is an account-wide replaceable event, not a per-device setting. Every update must fetch the newest verified event and preserve unrelated relay entries. Use a monotonic `created_at` value so concurrent device changes do not accidentally lose a user's existing inbox relays.

## Hosting

A continuously running service is required because it retains events, accepts long-lived relay connections, persists notification jobs, and sends APNs requests. `taskify-push-relay/` packages the service for StartOS 0.4.1 with x86_64 and aarch64 image definitions. Its **Configure Apple Push** action accepts the Apple Team ID, Key ID, `.p8` provider key, and bundle ID; the key is stored mode `0600` in the backed-up StartOS service volume and never included in the package.

The public StartOS interface must be mapped through a valid TLS gateway to `push.solife.me`. Both HTTPS and WebSocket upgrades share port 8080 inside the container. The packaged runtime pins the public origins so NIP-98 and NIP-42 signatures cannot be replayed against an alternate host.
