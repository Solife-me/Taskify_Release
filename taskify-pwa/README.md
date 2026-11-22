# Taskify PWA

Taskify is an offline-friendly personal task board built with React, TypeScript, and Vite. In this iteration the app adds precise due times, reminder presets, and end-to-end push notifications for iOS and Android via a Cloudflare Worker.

## Highlights

- 💡 Set due **date + time** on any task from the editor.
- ⏰ Attach reminder presets (5m, 15m, 1h, 1 day) per task; combine multiple offsets.
- 🔔 Push notification toggle in Settings with automatic platform detection.
- ☁️ Cloudflare Worker API stores subscriptions, schedules reminders, and pings devices via VAPID-secured Web Push.
- 📦 Worker also serves the static Vite build, so the full app runs on Workers instead of Pages.

## Boards and local data

Open a board's Share dialog and choose **Send to chat** to find a saved contact
or group conversation. Board settings open the same recipient picker. The board
appears in the conversation as a named card, with **Add board** for recipients.
Shared task cards and the task editor show the original creator, with initials from a
saved contact when available. **Settings → Boards & Lists** offers drag and drop
and move buttons for touch and keyboard use. Board checklists include upcoming
tasks, notes, due dates, and subtasks by default.

Daily is the shortest task repeat interval. Existing hourly task rules round up to whole calendar
days. A rule for every 24 hours or less becomes daily and a rule for every 25 hours becomes every
two days. The task's current due date, due time, and repeat end date are preserved.

**Settings → Reset local data** clears Taskify's saved key, settings, tasks,
messages, pending sync queue, and wallet data in this browser. Save your key
and back up local data first. Taskify returns to first-run setup after the
reset. Copies already published to Nostr relays remain available there.

## Prerequisites

- Node.js 22.23.5 or newer in the 22.x series
- Cloudflare account with Workers access
- `wrangler` CLI (`npm install -g wrangler`)

## Frontend setup

```bash
cd taskify-pwa
npm install
# Create .env.local with the values described below
```

Environment variables:

- `VITE_WORKER_BASE_URL` – Base URL for your deployed Worker (no trailing slash). Example: `https://taskify-worker.your-name.workers.dev`
- `VITE_VAPID_PUBLIC_KEY` – Base64url-encoded VAPID public key. Generate alongside the private key during Worker setup.
- `VITE_MANAGED_BLOSSOM_URL` – Optional managed Blossom base URL. The built-in default is `https://blossom.solife.me`. The URL can also be changed from Settings → Storage.

The managed Blossom URL selects the Storage dashboard. Originless is the default
encrypted upload server until the Blossom deployment accepts `application/octet-stream`.
Compatible Blossom servers can be selected explicitly for encrypted uploads.

Taskify shows one in-app renewal reminder for the managed and selected Blossom
servers when attachments enter their renewal window. Open the reminder to renew
them in **Settings → Storage**. Taskify uses the server’s advertised renewal
window, with a 30-day fallback for older servers. Checks run while the app is open.

Run the Vite dev server:

```bash
npm run dev
```

> During local development you can leave `VITE_WORKER_BASE_URL` pointing at your Wrangler dev address (default `http://127.0.0.1:8787`) after you start `wrangler dev`.

## Cloudflare Worker deployment

The Worker lives in `worker/src/index.ts` and shares this repository. It serves static assets and exposes reminder APIs.

1. **Generate VAPID keys** (one time):

   ```bash
   npx web-push generate-vapid-keys
   ```

   - Put the **public key** in `wrangler.toml` under `[vars]` as `VAPID_PUBLIC_KEY`, and in
     `.env.local` as `VITE_VAPID_PUBLIC_KEY`. Set `VAPID_SUBJECT` under `[vars]` to a `mailto:` or
     `https://` contact. Both are public; a deploy replaces every variable with `[vars]`.
   - Store the **private key** as a Worker secret: `wrangler secret put VAPID_PRIVATE_KEY`
     (PKCS#8 PEM or the raw base64url key).

2. **Create the D1 database** and put its ID in `wrangler.toml` (`[[d1_databases]]`):

   ```bash
   wrangler d1 create taskify-notifications
   ```

3. **Apply the migrations** in `worker/migrations/`, before the first deploy and before every
   deploy after it. The Worker creates no tables itself:

   ```bash
   wrangler d1 migrations apply taskify-notifications --remote
   ```

4. **Build the frontend** so the assets directory is populated:

   ```bash
   npm run build
   ```

5. **Run locally** (optional) to test the API+assets stack:

   ```bash
   wrangler dev
   ```

   Point your browser at the address shown (`http://127.0.0.1:8787`).

6. **Deploy**:

   ```bash
   wrangler deploy
   ```

   The worker registers the scheduled cron trigger (`*/1 * * * *`) automatically. Reminders are checked every minute and push pings are sent for due items.

## Using push notifications

1. Sign in to Taskify, open **Settings → Push notifications**, and enable push — the app automatically selects the appropriate push service for your browser.
2. The browser prompts for notification permission and registers the device with the Worker.
3. Edit any task, add a due time and one or more reminder offsets. When the Worker’s cron job reaches the scheduled send time it fires a push ping.
4. The service worker fetches reminder details on receipt and shows user-friendly notifications with links back into Taskify.

## Install, offline, and update behavior

- On Chromium-based Android browsers, the install prompt is captured and exposed as **Settings → Install app** when the browser says the app is installable. Browsers without that API, including iOS Safari, do not render the control.
- Each production build precaches its app shell and startup assets. The active worker keeps those files available for offline navigation while it controls the app. API and relay requests bypass that cache.
- While an update is waiting, navigation continues to use the active build. Accepting the in-app update notice reloads the page once the replacement worker takes control.
- The manifest includes stable app identity, scope, Android shortcuts, and colors matched to the initial app shell. Existing Apple standalone, touch-icon, and status-bar metadata remains in place for iOS PWAs.
- Production headers keep the service worker and manifest revalidating while allowing fingerprinted Vite assets to use long-lived immutable caching.

## Scripts

Inside `taskify-pwa`:

- `npm run dev` – Vite dev server.
- `npm run build` – production build required before `wrangler deploy`.
- `npm run lint` – ESLint check.

At repository root:

- `wrangler dev` – run Worker locally (requires built assets).
- `wrangler deploy` – deploy the Worker, its cron and its D1 binding (apply migrations first).

## Linting & QA

Before committing or deploying run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run check:startup
```

## Environment recap

| Location | Purpose |
| --- | --- |
| `.env.local` | `VITE_WORKER_BASE_URL`, `VITE_VAPID_PUBLIC_KEY`, optional `VITE_MANAGED_BLOSSOM_URL` |
| `wrangler.toml` | Worker name, D1 database, rate limiters, VAPID `[vars]`, asset config |
| Worker vars/secrets | `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `VAPID_PRIVATE_KEY` |

Keep VAPID private keys out of version control. Each device uses the Worker API to synchronise reminders; if you rotate keys, re-enable push in Settings so browsers resubscribe.
