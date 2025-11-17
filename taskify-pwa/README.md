# Taskify PWA

Taskify is an offline-friendly personal task board built with React, TypeScript, and Vite. In this iteration the app adds precise due times, reminder presets, and end-to-end push notifications for iOS and Android via a Cloudflare Worker.

## Highlights

- 💡 Set due **date + time** on any task from the editor.
- ⏰ Attach reminder presets (5m, 15m, 1h, 1 day) per task; combine multiple offsets.
- 🔔 Push notification toggle in Settings with automatic platform detection.
- ☁️ Cloudflare Worker API stores subscriptions, schedules reminders, and pings devices via VAPID-secured Web Push.
- 📦 Worker also serves the static Vite build, so the full app runs on Workers instead of Pages.

## Prerequisites

- Node.js 18+
- Cloudflare account with Workers access
- `wrangler` CLI (`npm install -g wrangler`)

## Frontend setup

```bash
cd taskify-pwa
npm install
cp ../.env.example .env.local  # edit values as described below
```

Required environment variables (see `.env.example`):

- `VITE_WORKER_BASE_URL` – Base URL for your deployed Worker (no trailing slash). Example: `https://taskify-worker.your-name.workers.dev`
- `VITE_VAPID_PUBLIC_KEY` – Base64url-encoded VAPID public key. Generate alongside the private key during Worker setup.

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

   - Put the generated **public key** into `.env.local` as `VITE_VAPID_PUBLIC_KEY` and into `wrangler.toml` (`VAPID_PUBLIC_KEY`).
   - Store the **private key** as a Worker secret:

     ```bash
     wrangler secret put VAPID_PRIVATE_KEY
     ```

2. **Create KV namespaces** (production + preview) for devices, reminders, and pending payloads:

   ```bash
   wrangler kv:namespace create TASKIFY_DEVICES
   wrangler kv:namespace create TASKIFY_DEVICES --preview
   wrangler kv:namespace create TASKIFY_REMINDERS
   wrangler kv:namespace create TASKIFY_REMINDERS --preview
   wrangler kv:namespace create TASKIFY_PENDING
   wrangler kv:namespace create TASKIFY_PENDING --preview
   ```

   Update the placeholder IDs in `wrangler.toml` with the values printed by each command.

3. **Set remaining Worker vars** (public key + VAPID subject/email):

   ```bash
   wrangler secret put VAPID_PUBLIC_KEY   # optional – or keep in wrangler.toml
   wrangler secret put VAPID_SUBJECT
   ```

   Alternatively keep `VAPID_PUBLIC_KEY` / `VAPID_SUBJECT` in `wrangler.toml` as shown, but never commit real keys.

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

## Scripts

Inside `taskify-pwa`:

- `npm run dev` – Vite dev server.
- `npm run build` – production build required before `wrangler deploy`.
- `npm run lint` – ESLint check.

At repository root:

- `wrangler dev` – run Worker locally (requires built assets).
- `wrangler deploy` – deploy Worker + cron + KV bindings.

## Linting & QA

Before committing or deploying run:

```bash
npm run lint
```

## Environment recap

| Location | Purpose |
| --- | --- |
| `.env.local` | `VITE_WORKER_BASE_URL`, `VITE_VAPID_PUBLIC_KEY` |
| `wrangler.toml` | Worker name, KV namespace IDs, asset config, public VAPID key, subject |
| Worker secrets | `VAPID_PRIVATE_KEY` (and optionally others) |

Keep VAPID private keys out of version control. Each device uses the Worker API to synchronise reminders; if you rotate keys, re-enable push in Settings so browsers resubscribe.
