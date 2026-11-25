# Taskify for Brave

Taskify in the browser's side panel: your boards, your upcoming tasks, and your chat — with the
page you are reading one click away from your AI agent.

The panel is a first-class Taskify client. It uses the same Nostr identity as the web app, the
iOS app and the macOS app, so the same boards and the same conversations are on every device.
Nothing is stored on a Taskify server: tasks, boards and messages are signed Nostr events, and
the extension talks only to the relays you already use.

---

## What it does

**Boards** — the account's boards and their tasks, grouped the way the app groups them (by day
for a week board, by list for a list board).

**Upcoming** — the account's tasks by the day they are due, with the overdue ones first.

**Chat** — your Taskify conversations. This is the part that makes the panel worth having while
you are reading: the composer's `+` menu takes what is on the page and sends it to the agent.

**Settings** — the account, the relays, and the way out.

### Attaching the page you are on

The `+` menu in the chat composer offers four ways to put the page in front of your agent:

| Option | What it sends |
|---|---|
| **Selected text** | Whatever you have highlighted. Falls back to the page's text when nothing is selected. |
| **Page text** | The page's readable text: the article body, without the navigation, the sidebars or the footers. |
| **Screenshot** | A picture of the page you are on. |
| **A file** | A file from your computer. |

Each capture becomes an encrypted attachment: a fresh AES-256 key and nonce per file, the file
encrypted, uploaded to Taskify's managed Blossom server by default (with NIP-96 and Originless
fallbacks), and sent as a NIP-17 gift-wrapped kind-15 message. The agent decrypts it with the same
tooling it uses for any other Taskify attachment — no changes needed on the agent's side.

The captured text is a Markdown file with the page's title and URL at the top, so the agent
always knows what it is looking at.

---

## Installing it

### From the source (for development)

```sh
cd taskify-extension
npm install
npm run build
```

Then in Brave:

1. Open `brave://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and pick the `taskify-extension/dist` folder.

Reload the extension after each rebuild.

### Signing it for everyday use

The panel's identity is tied to the extension's ID, so the key you sign in with stays where it
is. To keep the same ID across machines, put the public key in `public/manifest.json`:

```json
"key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC..."
```

---

## First run

The panel asks for your Taskify `nsec` — the same one the web app and the agent use. Find it in
the Taskify app under **Settings → Nostr**, or in **Settings → Backup**.

The key is stored encrypted on this device: a non-extractable AES-GCM wrapping key lives in
IndexedDB, and the secret is kept in `chrome.storage.local` as base64(iv ‖ ciphertext). A dump of
the extension's storage does not yield the secret key. The extension has no server of its own and
never sends the key anywhere but the relays you already use.

---

## How it is put together

```
taskify-extension/
├── src/
│   ├── panel.tsx          the side panel: the tabs and the shell
│   ├── panel.html         the panel's document
│   ├── background.ts      the service worker: the side panel, and screenshots
│   ├── content.ts         the content script: reading the page
│   ├── lib/
│   │   ├── capture.ts     turning a page into readable text
│   │   ├── pageCapture.ts asking the tab for a capture
│   │   ├── identity.ts    the account key, encrypted at rest
│   │   ├── session.ts     the Nostr session
│   │   ├── account.ts     finding the account's boards
│   │   ├── boards.ts      reading a board and its tasks
│   │   ├── chat.ts        sending and receiving messages
│   │   ├── chatCrypto.ts  NIP-17 gift wraps and attachment encryption
│   │   ├── fileUpload.ts  uploading to a file server
│   │   └── inbox.ts       where a peer's messages are waiting
│   └── ui/                the four tabs
├── tests/                 the capture, crypto, identity and upload checks
└── public/                the manifest and the icons
```

The shared contracts come from the repository's own packages, compiled from source exactly as the
PWA does it, so a change in `taskify-core` or `taskify-runtime-nostr` is visible here at once:

- `taskify-core` — the board, task and NIP-17 contracts
- `taskify-runtime-nostr` — the relay session, the board keys and the NIP-17 key parties

### What the panel does not do

- **No wallet.** The wallet is being phased out of Taskify (2026-12-01) and is not in the panel.
- **No task editing.** The panel is for reading your tasks and talking to your agent; editing
  stays in the app, where the editors are.
- **No push notifications.** Reminders are scheduled by the app and the Worker.

---

## Building and checking

```sh
npm run build       # build the bundle into dist/
npm run typecheck   # TypeScript, no emit
npm test            # the test suite
npm run icons       # regenerate the icons
```

The tests cover the parts that are easy to get subtly wrong: the page capture (that it keeps the
article and drops the furniture), the attachment encryption (that it round-trips, and that two
files never share a key), the NIP-17 gift wrap (that a recipient can open it), the account key
parsing (that an `nsec` and a hex key work, and that a public key does not), and the file upload
(that managed Blossom is the default and that BUD-11 authorization carries the ciphertext hash).

---

## The wire format

The panel is wire-compatible with the rest of Taskify, so nothing on the agent's side changes.

| What | How |
|---|---|
| Boards and tasks | Kind 30300 (board metadata) and 30301 (task), encrypted to a key derived from the board id. |
| The account's board list | Kind 30078, d-tag `taskify-app-backup`, NIP-44 v2 to the account's own key. |
| Chat messages | NIP-17: a kind-14 rumor (text) or kind-15 (file), sealed (kind 13) and gift-wrapped (kind 1059). |
| Attachments | AES-256-GCM, one key and nonce per file, uploaded to a NIP-96, Blossom or Originless server. The rumor's tags carry the key, the nonce and the algorithm. |

`taskify-core` and `taskify-runtime-nostr` are the source of truth for all of these, and the
panel uses them rather than its own copies.
