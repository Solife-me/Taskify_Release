# Taskify Push Relay

## Before you start

You need an Apple Developer APNs authentication key with Apple Push Notifications enabled for the
Taskify App ID. Keep the downloaded `.p8` file private; Apple only lets you download it once.

## Set up the service

1. Open the critical **Configure Apple Push** task after installation.
2. Enter the Apple Team ID and APNs Key ID. Open the `.p8` file in a text editor and paste its
   complete contents, including the `BEGIN PRIVATE KEY` and `END PRIVATE KEY` lines, into the masked
   private-key field. Leave the App Bundle ID as `solife.me.Taskify.Native` unless the iOS target is
   signed with a different bundle identifier. Leave the Watch App Bundle ID as
   `solife.me.Taskify.Native.watchkitapp` unless the watchOS target uses a different identifier.
3. Open the **NIP-17 Push Relay** interface and expose it through your StartOS HTTPS gateway at
   `push.solife.me`. The same endpoint must be reachable as both `https://push.solife.me` and
   `wss://push.solife.me` with a valid public TLS certificate.
4. Confirm `https://push.solife.me/healthz` returns `{"status":"ok"}`.
5. Build and sign Taskify with Push Notifications and remote-notification background delivery
   enabled for both the iOS and independent watchOS App IDs and provisioning profiles, then install
   the update on an iPhone and paired Apple Watch.
6. In Taskify Settings, enable **Direct-message push** and choose **New messages**, **Ecash
   payments**, or **Messages & payments**.

When enabled, Taskify registers the device using a signed NIP-98 request and adds
`wss://push.solife.me` to the user's signed NIP-17 inbox relay preference. Disabling the last device
registration removes that relay from the preference.

The Watch independently ensures the push relay remains in its account's signed inbox preference,
even when notification permission is declined, so foreground cellular/Wi-Fi inbox refresh still
works. For outgoing DMs the Watch asks this service to retrieve a recipient's public inbox relay
list over HTTPS. The Watch verifies the signed list and submits each encrypted recipient copy
with its chosen targets; this service never substitutes or adds delivery targets.

Updated Watch clients can receive confirmation as soon as one selected relay accepts a message.
The gateway continues forwarding the remaining copies, and the Watch retains unfinished copies
for retry. Deploy the updated gateway and Watch build together to use this faster confirmation;
older clients retain their existing response behavior.

Update the gateway before installing the updated Watch build. Public recipient lookups now use
HTTPS, replacing the connection type Apple restricts on physical Watches. Slow discovery relays
have a short deadline, and the Watch reuses recently checked lists.

The same HTTPS origin is the Watch's preferred task and board gateway. For every board currently
on the Watch, Taskify supplies a fresh proof signed by that board's derived key and the exact relay
targets to query. The service gathers and deduplicates only events matching those explicit board
authors and tags; it does not subscribe to or cache unrelated traffic from the upstream relays.
Outgoing encrypted task changes use the same gateway and Watch-supplied relay targets. When the
push relay is unavailable, the Watch automatically falls back to `https://taskify.solife.me`.

## Privacy and delivery behavior

The gateway operator can observe which public recipient account you look up and when, as well
as your authenticated account. The lookup handler does not store a lookup history or remotely
fetched lists, and it does not log lookup details. The Watch checks signatures and keeps its
own routing cache. Message contents and private keys are never included in these lookups.

The service stores only encrypted NIP-17 gift wraps. It never sends Apple message text, sender
identity, payment data, group metadata, or the selected category. iPhone and Watch receive a
generic **New Message** alert with a background refresh opportunity. The iPhone alert also carries
a random preview link that expires after 15 minutes: Taskify's notification extension uses it to
fetch the encrypted message, decrypts it on the iPhone, and replaces the generic text with the
sender and a short preview. The Watch decrypts its inbox locally. Because conversation and mute
metadata remains encrypted, the service cannot honor block, mute, or category choices; on the
iPhone those arrivals keep the generic alert instead of showing a preview.

Task and board cache entries are also opaque signed ciphertext. The service never receives board
secrets, board names, task text, decrypted state, or a durable account-to-board subscription map.
The Watch independently verifies the event signature, expected derived author, and board tag before
decrypting it on-device. Cached entries expire after 30 days without being observed and are bounded
per public board author and globally.

Apple can still delay background refresh work. The visible generic alert uses alert-priority APNs,
so its delivery does not depend on a low-priority silent wake. Background refresh stops while
Background App Refresh is disabled or after the user force-quits the app, until it is opened again.

Back up the service regularly. Its encrypted event queue, device registrations, and APNs provider
key live in the `main` service volume.

## Relay compatibility

Taskify can still send messages using fallback relays when the recipient has no published inbox
list. Usable published lists take precedence, and the gateway uses the targets chosen by the app.
Delivery is confirmed only when a relay reports acceptance. A rejected message remains pending
for retry rather than appearing sent. The service does not currently process Nostr deletion
requests; encrypted messages remain subject to its configured retention limits.
