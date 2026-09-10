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

## Native send-path performance and delivery state

- The native app persists recipient kind-10050 results by public key. Positive results are fresh for 10 minutes and may be used stale for up to 30 days while a refresh runs in the background; an empty result is cached for 90 seconds and may be used stale for another 10 minutes. Opening a one-to-one conversation also starts a preflight lookup.
- A recipient's advertised inbox list is authoritative. Contact relays, relays remembered for that conversation, and the app's configured relays are discovery and fallback inputs only; they are used for delivery when the recipient has not advertised an inbox. Relays accumulated from unrelated contacts and chats are not queried or published to.
- Gift-wrap construction runs off the UI actor. Group recipient lookups are bounded to four concurrent operations, and all wraps for one message, reaction, structured share, or group metadata update are added to the durable outbox in one atomic batch.
- Tapping Send waits only for local validation, recipient resolution when it was not already cached, encryption, and the durable outbox write. Relay connection, subscription reconciliation, backlog draining, authentication, rate-limit waits, and acknowledgement happen in the background.
- Inbox delivery entries are complete when any one destination relay accepts the gift wrap. They expire after 48 hours rather than retrying forever. Relay acknowledgements are coalesced before rewriting the outbox file, while enqueue remains immediately durable.
- The conversation shows outgoing messages as `Sending…`, `Sent`, or `Failed`. `Sent` means a recipient gift wrap was accepted by at least one destination relay; it is not a read receipt.
- Relay configuration changes are reconciled incrementally, so opening or sending in one conversation does not tear down unchanged subscriptions. Instruments points-of-interest named `DM Send`, `DM Relay Resolution`, `DM Gift Wrap`, and `DM Durable Queue` expose the remaining latency by phase.

## Registration and APNs

- `PUT /v1/registrations/:installationID` registers or rotates one APNs token. `DELETE` disables it.
- Every request carries a signed NIP-98 kind-27235 event bound to the exact URL, HTTP method, and SHA-256 payload hash. Events are fresh and one-use.
- Tokens are namespaced by authenticated Nostr public key and installation ID. Moving an installation or token removes its stale association.
- Registrations are bounded to 10 installations per account and 100,000 total so authenticated key generation cannot grow the service state without limit.
- APNs uses token authentication with ES256, `apns-push-type: alert`, priority `10`, and `content-available: 1`. iPhone deliveries add `mutable-content: 1` and their own preview URL and are not collapsed with a different encrypted event. Watch deliveries carry neither, because watchOS has no service extension to use them.
- Invalid APNs tokens are removed. Temporary APNs failures are persisted and retried with bounded exponential backoff.
- The service extension creates rich message/activity previews locally after decryption. It supports ordinary messages, attachments, reactions, task assignments and shares, contact shares, calendar invitations, assignment responses, board invitations, and group subject changes. Cached contacts use their display name; an uncached contact appears as `Unknown sender` with a shortened npub.
- Message previews show the first three non-empty lines, bounded to 240 characters. The normal title is `New Message`; activity-specific titles include forms such as `Reacted 👍`, `New task assignment`, and `New invitation`.
- Payment gift wraps are not presented as receipts from their unverified claimed amount. The background app path redeems the Cashu token first and then creates a local `Payment Received` notification containing the verified amount and cached sender name when available.
- The local result carries only a device-local tab destination and, for message/activity previews, the conversation ID (the sender's public key, or the group ID). Tapping message/activity notifications opens Chat, while tapping `Payment Received` opens Wallet. Both values are added after on-device processing and are never sent through APNs or exposed to the push relay.
- Message/activity previews use a notification category with a **Reply** text action. Long-pressing the notification and sending text delivers the reply to Taskify in the background (the app is not brought forward), which sends it to that conversation through the normal encrypted NIP-17 path and durable outbox, marks the conversation read, and holds a background task while the gift wraps are published. If the send cannot be queued, Taskify posts a local `Reply Not Sent` notification. The generic fallback alert has no conversation ID, so it offers no Reply action.
- The notification categories are defined once in TaskifyCore (`TaskifyNotificationCategories`) and registered only when the system's set differs. Apple expects `setNotificationCategories` to be called once at launch, and every DM push also launches Taskify in the background, so re-registering on each launch would replace the set while the extension's rewritten notification is being presented. The extension confirms the set is registered before attaching the Reply category, which also covers a notification that arrives after an install or update before the app has run. The extension logs why a notification kept the generic alert or went out without Reply, never message content, under the `solife.me.Taskify.Native.NotificationService` subsystem.

The generic APNs alert can be replaced by the service extension without launching the main app. Payment redemption still depends on best-effort background app execution; if iOS withholds it, Taskify finishes redemption the next time the app runs. A force-quit app is not relaunched in the background. The generic fallback reveals no encrypted-event category.

The Notification Service Extension ships without Apple's managed Notification Filtering entitlement (`com.apple.developer.usernotifications.filtering`). Hiding a remote notification requires that entitlement, so the extension never hands back empty content: payment gift wraps, categories the user did not select, blocked senders, muted or left group conversations, and events it cannot fetch or decrypt within the extension's time limit keep the unchanged generic alert. Payments therefore show the generic alert followed by the verified `Payment Received` notification. App Groups and the shared Keychain Access Group must be enabled for both the app and extension provisioning setup.

When Apple approves the entitlement for `solife.me.Taskify.Native.NotificationService`, add it to `TaskifyNotificationService.entitlements` and make the extension hand back empty `UNNotificationContent` for those arrivals instead of the generic alert. The push relay must send `apns-push-type: alert` for suppression to work.

## Multi-device and replaceable-event safety

Kind 10050 is an account-wide replaceable event, not a per-device setting. Every update must fetch the newest verified event and preserve unrelated relay entries. Use a monotonic `created_at` value so concurrent device changes do not accidentally lose a user's existing inbox relays.

## Hosting

A continuously running service is required because it retains events, accepts long-lived relay connections, persists notification jobs, and sends APNs requests. `taskify-push-relay/` packages the service for StartOS 0.4.1 with x86_64 and aarch64 image definitions. Its **Configure Apple Push** action accepts the Apple Team ID, Key ID, `.p8` provider key, and bundle ID; the key is stored mode `0600` in the backed-up StartOS service volume and never included in the package.

The public StartOS interface must be mapped through a valid TLS gateway to `push.solife.me`. Both HTTPS and WebSocket upgrades share port 8080 inside the container. The packaged runtime pins the public origins so NIP-98 and NIP-42 signatures cannot be replayed against an alternate host.
