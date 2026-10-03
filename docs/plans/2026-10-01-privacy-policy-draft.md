# Privacy policy — proposed revision (audit F0-7)

Draft for the maintainer to review. Nothing here is published: the live text is
`taskify-pwa/public/privacy/index.html`. Every statement below was checked against the code on
2026-10-01 (commits through `e22829d8`); items marked **[confirm]** depend on account settings
the code cannot show. Wording is plain on purpose; adjust tone and legal phrasing as you see fit.

---

## Taskify Privacy Policy

Effective date: **[set on publication]**

Taskify is a task, calendar, messaging, and wallet app built on Nostr. Most of your data is
encrypted on your device and stored on Nostr relays; Solife runs a small number of services to
make some features work. This policy explains what those services and the third parties they
use receive, how long it is kept, and your choices.

### 1. Your account

Your account is a Nostr key pair created on your device. The private key stays on your devices,
encrypted with a key held by your browser or by the iOS/macOS Keychain. Solife never receives it.

### 2. What is encrypted before it leaves your device

Boards, tasks, calendar events, direct messages, contacts, wallet backups, and app settings are
encrypted on your device before they are sent to relays. Relays and Solife's services store
the encrypted data and some public metadata about it (see section 4), not its contents.

### 3. Services Solife runs

**Taskify web service (taskify.solife.me), hosted on Cloudflare Workers.**

- *Link previews and NIP-05 lookups.* When you view a task or message containing a link, or look
  up a contact's NIP-05 address, the service fetches that page or address for you. It receives
  the URL or address, and your IP address.
- *Voice dictation.* What you dictate is sent as text to Cloudflare Workers AI to turn into
  tasks. It is not stored by Taskify. Daily usage counters (your public key and a hashed,
  day-specific form of your IP address) are kept for 7 days.
- *Browser reminders.* If you turn on reminders in the web app, your browser's push
  subscription and each reminder's task title, due time, and offsets are stored until the
  reminder is sent, you remove it, or you turn reminders off. A delivered-but-unfetched
  notification is deleted after 14 days.
- *Request signatures.* Signed requests are recorded for about a minute so they cannot be
  replayed.
- *Logs.* Cloudflare's request logs (URL, IP address, approximate location, timing) are kept for
  3 days **[confirm the Workers Logs retention in the Cloudflare dashboard]** for reliability and
  abuse prevention.

**Push relay (push.solife.me), run on Solife's server and reached through Cloudflare.**
Used by the iPhone and Apple Watch apps for message notifications if you turn them on.

- It stores encrypted messages addressed to you for up to 30 days, and your device
  registration (push token, an installation ID, your public key) until you turn notifications
  off or 90 days pass without the app refreshing it.
- It can see who sent a message to whom and when, and message sizes, but not contents.
- Each notification carries a single-use link the app uses to fetch the encrypted message.
- Cloudflare, which carries this traffic, can see the same metadata and your IP address.

### 4. Third parties your device contacts directly

- **Nostr relays** (defaults and any you add) store your encrypted events. They can see your
  public key, the public keys you exchange messages with, event times and sizes, and your IP
  address.
- **Apple Push Notification service** receives your device's push token and a generic alert.
- **Cashu mints, Lightning address, LNURL, and Nostr Wallet Connect services** you choose receive
  what is needed to move funds, and your IP address. Payments sent to you at a mint your wallet
  does not already use are held until you choose to redeem them.
- **File hosts** for attachments (nostr.build, blossom.band, Solife's Originless service, an IPFS
  gateway, or one you choose) receive encrypted files and your IP address.
- **Coinbase** supplies the BTC/USD price if currency conversion is on; it receives your IP
  address.
- **Websites you link to** receive your IP address when the app shows their preview image or
  icon, and **Google's favicon service** receives the domains of links in your messages.
- **Profile picture hosts** receive your IP address when pictures are shown.

### 5. Command-line tool

The Taskify CLI's optional agent sends the task content it works on to the AI provider you
configure, with your API key (OpenAI by default). Solife does not receive it.

### 6. What we do not do

No advertising, no analytics or tracking SDKs, and no sale of personal information.

### 7. Your choices

You can turn off reminders, notifications, voice dictation, currency conversion, and contact
sync in settings, and choose your own relays, mints, and file hosts. Uninstalling the app or
clearing the browser's site data removes local data. **[confirm, then describe: which deletions
the app publishes to relays (deletion requests or replacement events), and that relays decide
whether to honor them]**

### 8. Children

Taskify is not directed to children under 13, and we do not knowingly collect personal data
from them.

### 9. Changes

We will update this policy when the processing above changes, and change the effective date.

### 10. Contact

support@solife.me

---

## Notes for the maintainer

- The current policy says "third-party infrastructure providers" only; regulators generally
  expect named processors and retention periods. This draft names them.
- Voice used Gemini's free tier until fix pass 1; if any users dictated before that deploy,
  consider a line saying so, or a dated changelog entry.
- Confirm the Workers Logs retention and whether you keep invocation logs on at all (F1A-9).
- If the Google Calendar tables still hold data (F1A-16), delete them before publishing, or the
  policy should mention them.
