# Taskify Push Relay

## Before you start

You need an Apple Developer APNs authentication key with Apple Push Notifications enabled for the
Taskify App ID. Keep the downloaded `.p8` file private; Apple only lets you download it once.

## Set up the service

1. Open the critical **Configure Apple Push** task after installation.
2. Enter the Apple Team ID and APNs Key ID. Open the `.p8` file in a text editor and paste its
   complete contents, including the `BEGIN PRIVATE KEY` and `END PRIVATE KEY` lines, into the masked
   private-key field. Leave the App Bundle ID as `solife.me.Taskify.Native` unless the iOS target is
   signed with a different bundle identifier.
3. Open the **NIP-17 Push Relay** interface and expose it through your StartOS HTTPS gateway at
   `push.solife.me`. The same endpoint must be reachable as both `https://push.solife.me` and
   `wss://push.solife.me` with a valid public TLS certificate.
4. Confirm `https://push.solife.me/healthz` returns `{"status":"ok"}`.
5. Build and sign Taskify with the Push Notifications capability enabled in the Apple Developer
   App ID and provisioning profile, then install the update on an iPhone.
6. In Taskify Settings, enable **Direct-message push** and choose **New messages**, **Ecash
   payments**, or **Messages & payments**.

When enabled, Taskify registers the device using a signed NIP-98 request and adds
`wss://push.solife.me` to the user's signed NIP-17 inbox relay preference. Disabling the last device
registration removes that relay from the preference.

## Privacy and delivery behavior

The service stores only encrypted NIP-17 gift wraps. It sends Apple the same content-free wake for
every incoming wrap—never message text, sender identity, payment data, or the selected category.
The iPhone decrypts the wrap and creates a local notification titled **New Message** or **Payment
Received**.

Apple treats background pushes as low priority and may delay or coalesce them. Delivery also stops
while Background App Refresh is disabled or after the user force-quits the app, until it is opened
again. This is the tradeoff that keeps DM category and content out of APNs.

Back up the service regularly. Its encrypted event queue, device registrations, and APNs provider
key live in the `main` service volume.
