// Google Calendar Integration — extracted from index.ts (Item #12 worker module split).
// Handles OAuth, calendar/event sync, push webhooks, and AES-256-GCM token encryption.

import { schnorr } from "@noble/curves/secp256k1.js";
import type { Env, D1Database } from "./index.ts";
import { requireDb, jsonResponse, base64UrlEncode, base64UrlDecode, parseJson } from "./index.ts";

// =============================================================================

// --- gcalCrypto helpers -------------------------------------------------------

// AES-256-GCM encrypt. Returns { enc, iv, tag } all base64url strings.
async function gcalEncryptToken(
  plaintext: string,
  keyHex: string,
): Promise<{ enc: string; iv: string; tag: string }> {
  const keyBytes = hexToBytes(keyHex);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ivBuf = new ArrayBuffer(12);
  const iv = new Uint8Array(ivBuf);
  crypto.getRandomValues(iv);
  const encoded = new TextEncoder().encode(plaintext);
  // AES-GCM in Web Crypto appends 16-byte tag to ciphertext
  const cipherWithTag = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ivBuf, tagLength: 128 },
    cryptoKey,
    encoded,
  );
  const cipherArr = new Uint8Array(cipherWithTag);
  const enc = base64UrlEncode(cipherArr.slice(0, cipherArr.length - 16));
  const tag = base64UrlEncode(cipherArr.slice(cipherArr.length - 16));
  return { enc, iv: base64UrlEncode(iv), tag };
}

// AES-256-GCM decrypt. Takes { enc, iv, tag } base64url strings + keyHex.
async function gcalDecryptToken(
  enc: string,
  iv: string,
  tag: string,
  keyHex: string,
): Promise<string> {
  const keyBytes = hexToBytes(keyHex);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const encBytes = base64UrlDecode(enc);
  const tagBytes = base64UrlDecode(tag);
  const ivBytes = base64UrlDecode(iv);
  // Web Crypto expects ciphertext + tag concatenated
  const cipherBuf = new ArrayBuffer(encBytes.length + tagBytes.length);
  const cipherWithTag = new Uint8Array(cipherBuf);
  cipherWithTag.set(encBytes);
  cipherWithTag.set(tagBytes, encBytes.length);
  const ivBuf = new ArrayBuffer(ivBytes.length);
  new Uint8Array(ivBuf).set(ivBytes);
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBuf, tagLength: 128 },
    cryptoKey,
    cipherBuf,
  );
  return new TextDecoder().decode(plainBuf);
}

// Get the right key hex for a given keyVersion, falling back to PREV during rotation.
function gcalGetKeyForVersion(version: number, env: Env): string {
  const current = gcalCurrentKeyVersion(env);
  if (version === current) {
    return env.GCAL_TOKEN_ENC_KEY;
  }
  if (env.GCAL_TOKEN_ENC_KEY_PREV) {
    return env.GCAL_TOKEN_ENC_KEY_PREV;
  }
  throw new Error(`No key available for version ${version}`);
}

// Get the current key version number (from env.GCAL_KEY_VERSION, default 1).
function gcalCurrentKeyVersion(env: Env): number {
  const v = parseInt(env.GCAL_KEY_VERSION ?? "1", 10);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
  const buf = new ArrayBuffer(hex.length / 2);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// --- NIP-01 auth verification helper -----------------------------------------

// Minimal bech32 decode for npub (no checksum verification — sufficient for auth use)
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Decode(str: string): { hrp: string; data: Uint8Array } | null {
  const s = str.toLowerCase();
  const sep = s.lastIndexOf("1");
  if (sep < 1 || sep + 7 > s.length) return null;
  const hrp = s.slice(0, sep);
  const dataPart = s.slice(sep + 1);
  // Decode 5-bit words (strip 6-char checksum suffix)
  const words: number[] = [];
  for (let i = 0; i < dataPart.length - 6; i++) {
    const idx = BECH32_CHARSET.indexOf(dataPart[i]);
    if (idx < 0) return null;
    words.push(idx);
  }
  // Convert 5-bit groups → 8-bit bytes
  let acc = 0, bits = 0;
  const bytes: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return { hrp, data: new Uint8Array(bytes) };
}

// Accept either raw 64-hex pubkey or bech32 "npub1…" string → lowercase hex
function npubToHex(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
  const decoded = bech32Decode(trimmed);
  if (!decoded || decoded.hrp !== "npub" || decoded.data.length !== 32) return null;
  return [...decoded.data].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// NIP-01 Schnorr request authentication
// Headers: X-Taskify-Npub, X-Taskify-Timestamp, X-Taskify-Sig
// Sig is a hex Schnorr signature over SHA-256(timestamp + "." + body)
// GET requests use empty string as body.
async function verifyGcalAuth(request: Request): Promise<{ npub: string } | null> {
  const npubHeader = request.headers.get("X-Taskify-Npub");
  const tsHeader = request.headers.get("X-Taskify-Timestamp");
  const sigHeader = request.headers.get("X-Taskify-Sig");

  if (!npubHeader || !tsHeader || !sigHeader) return null;

  const ts = parseInt(tsHeader, 10);
  if (!Number.isFinite(ts)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) return null;

  const pubkeyHex = npubToHex(npubHeader);
  if (!pubkeyHex) return null;

  // Compute signing payload: SHA-256(timestamp + "." + body)
  const body = await request.clone().text();
  const payload = `${ts}.${body}`;
  const msgHashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const msgHash = new Uint8Array(msgHashBuf);

  try {
    const valid = schnorr.verify(hexToBytes(sigHeader), msgHash, hexToBytes(pubkeyHex));
    if (!valid) return null;
  } catch {
    return null;
  }

  return { npub: pubkeyHex };
}

// --- ensureGcalSchema --------------------------------------------------------

async function ensureGcalSchema(env: Env): Promise<void> {
  const db = requireDb(env);

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS gcal_connections (
       npub              TEXT    PRIMARY KEY,
       google_email      TEXT    NOT NULL,
       access_token_enc  TEXT    NOT NULL,
       access_token_iv   TEXT    NOT NULL,
       access_token_tag  TEXT    NOT NULL,
       refresh_token_enc TEXT    NOT NULL,
       refresh_token_iv  TEXT    NOT NULL,
       refresh_token_tag TEXT    NOT NULL,
       token_expiry      INTEGER NOT NULL,
       key_version       INTEGER NOT NULL DEFAULT 1,
       status            TEXT    NOT NULL DEFAULT 'active',
       last_sync_at      INTEGER,
       last_error        TEXT,
       created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
       updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
     )`,
  ).run();

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS gcal_calendars (
       id               TEXT    PRIMARY KEY,
       npub             TEXT    NOT NULL,
       provider_cal_id  TEXT    NOT NULL,
       name             TEXT    NOT NULL,
       primary_cal      INTEGER NOT NULL DEFAULT 0,
       selected         INTEGER NOT NULL DEFAULT 1,
       color            TEXT,
       timezone         TEXT,
       sync_token       TEXT,
       watch_channel_id TEXT,
       watch_expiry     INTEGER,
       created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
       updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
       FOREIGN KEY (npub) REFERENCES gcal_connections(npub) ON DELETE CASCADE,
       UNIQUE (npub, provider_cal_id)
     )`,
  ).run();

  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_gcal_calendars_npub ON gcal_calendars(npub)`,
  ).run();
  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_gcal_calendars_watch ON gcal_calendars(watch_channel_id)`,
  ).run();
  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_gcal_calendars_watch_expiry ON gcal_calendars(watch_expiry)`,
  ).run();

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS gcal_events (
       id                TEXT    PRIMARY KEY,
       npub              TEXT    NOT NULL,
       calendar_id       TEXT    NOT NULL,
       provider_event_id TEXT    NOT NULL,
       title             TEXT    NOT NULL DEFAULT '',
       description       TEXT,
       location          TEXT,
       start_iso         TEXT    NOT NULL,
       end_iso           TEXT    NOT NULL,
       all_day           INTEGER NOT NULL DEFAULT 0,
       status            TEXT    NOT NULL DEFAULT 'confirmed',
       html_link         TEXT,
       created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
       updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
       FOREIGN KEY (calendar_id) REFERENCES gcal_calendars(id) ON DELETE CASCADE,
       UNIQUE (npub, calendar_id, provider_event_id)
     )`,
  ).run();

  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_gcal_events_npub ON gcal_events(npub)`,
  ).run();
  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_gcal_events_calendar ON gcal_events(calendar_id)`,
  ).run();
  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_gcal_events_start ON gcal_events(npub, start_iso)`,
  ).run();
}

// --- GCal DB row types -------------------------------------------------------

type GcalConnectionRow = {
  npub: string;
  google_email: string;
  access_token_enc: string;
  access_token_iv: string;
  access_token_tag: string;
  refresh_token_enc: string;
  refresh_token_iv: string;
  refresh_token_tag: string;
  token_expiry: number;
  key_version: number;
  status: string;
  last_sync_at: number | null;
  last_error: string | null;
};

type GcalCalendarRow = {
  id: string;
  npub: string;
  provider_cal_id: string;
  name: string;
  primary_cal: number;
  selected: number;
  color: string | null;
  timezone: string | null;
  sync_token: string | null;
  watch_channel_id: string | null;
  watch_expiry: number | null;
};

type GcalEventRow = {
  id: string;
  npub: string;
  calendar_id: string;
  provider_event_id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_iso: string;
  end_iso: string;
  all_day: number;
  status: string;
  html_link: string | null;
  calendar_name?: string | null;
  calendar_color?: string | null;
};

// --- Token helpers -----------------------------------------------------------

async function gcalDecryptAccessToken(row: GcalConnectionRow, env: Env): Promise<string> {
  const keyHex = gcalGetKeyForVersion(row.key_version, env);
  return gcalDecryptToken(row.access_token_enc, row.access_token_iv, row.access_token_tag, keyHex);
}

async function gcalDecryptRefreshToken(row: GcalConnectionRow, env: Env): Promise<string> {
  const keyHex = gcalGetKeyForVersion(row.key_version, env);
  return gcalDecryptToken(row.refresh_token_enc, row.refresh_token_iv, row.refresh_token_tag, keyHex);
}

// --- refreshGcalTokenIfNeeded ------------------------------------------------

async function refreshGcalTokenIfNeeded(npub: string, env: Env): Promise<string> {
  const db = requireDb(env);
  const row = await db
    .prepare<GcalConnectionRow>(`SELECT * FROM gcal_connections WHERE npub = ?`)
    .bind(npub)
    .first<GcalConnectionRow>();
  if (!row) throw new Error("No GCal connection for npub");

  const nowSec = Math.floor(Date.now() / 1000);
  if (row.token_expiry > nowSec + 300) {
    return gcalDecryptAccessToken(row, env);
  }

  // Need to refresh
  const refreshToken = await gcalDecryptRefreshToken(row, env);
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GCAL_CLIENT_ID,
      client_secret: env.GCAL_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (resp.status === 400 || resp.status === 401) {
    await db
      .prepare(`UPDATE gcal_connections SET status = 'needs_reauth', updated_at = ? WHERE npub = ?`)
      .bind(nowSec, npub)
      .run();
    throw new Error("GCal token refresh failed: needs_reauth");
  }

  if (!resp.ok) {
    throw new Error(`GCal token refresh failed: HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    expires_in: number;
  };

  const keyVersion = gcalCurrentKeyVersion(env);
  const keyHex = env.GCAL_TOKEN_ENC_KEY;
  const encAcc = await gcalEncryptToken(data.access_token, keyHex);
  const newExpiry = nowSec + (data.expires_in ?? 3600);

  await db
    .prepare(
      `UPDATE gcal_connections
         SET access_token_enc = ?, access_token_iv = ?, access_token_tag = ?,
             token_expiry = ?, key_version = ?, status = 'active', updated_at = ?
       WHERE npub = ?`,
    )
    .bind(
      encAcc.enc, encAcc.iv, encAcc.tag,
      newExpiry, keyVersion, nowSec,
      npub,
    )
    .run();

  return data.access_token;
}

// --- registerGcalWatch -------------------------------------------------------

async function registerGcalWatch(
  npub: string,
  calendarId: string,
  providerCalId: string,
  accessToken: string,
  env: Env,
): Promise<void> {
  const db = requireDb(env);
  const channelId = crypto.randomUUID();
  const webhookAddress = `https://taskify.solife.me/api/gcal/webhook/${channelId}`;

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalId)}/events/watch`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address: webhookAddress,
        token: env.GCAL_WEBHOOK_SECRET,
      }),
    },
  );

  if (!resp.ok) {
    console.warn("registerGcalWatch failed", { calendarId, status: resp.status });
    return;
  }

  const data = (await resp.json()) as { expiration?: string };
  const watchExpiry = data.expiration ? Math.floor(Number(data.expiration) / 1000) : null;
  const nowSec = Math.floor(Date.now() / 1000);

  await db
    .prepare(
      `UPDATE gcal_calendars
         SET watch_channel_id = ?, watch_expiry = ?, updated_at = ?
       WHERE id = ? AND npub = ?`,
    )
    .bind(channelId, watchExpiry, nowSec, calendarId, npub)
    .run();
}

// --- syncCalendarEvents ------------------------------------------------------

async function syncCalendarEvents(
  npub: string,
  calendarId: string,
  accessToken: string,
  env: Env,
): Promise<void> {
  const db = requireDb(env);

  // Verify calendar belongs to this npub (critical security check)
  const calRow = await db
    .prepare<GcalCalendarRow>(`SELECT * FROM gcal_calendars WHERE id = ? AND npub = ?`)
    .bind(calendarId, npub)
    .first<GcalCalendarRow>();
  if (!calRow) throw new Error(`Calendar ${calendarId} not found for npub`);

  const providerCalId = calRow.provider_cal_id;
  const nowSec = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = new Date((nowSec - 7 * 86400) * 1000).toISOString();
  const sixMonthsAhead = new Date((nowSec + 180 * 86400) * 1000).toISOString();

  let pageToken: string | undefined;
  let syncToken: string | undefined;

  const doSync = async (url: string): Promise<void> => {
    let nextPageToken: string | undefined;
    do {
      const fetchUrl = nextPageToken ? `${url}&pageToken=${encodeURIComponent(nextPageToken)}` : url;
      const resp = await fetch(fetchUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (resp.status === 410) {
        // Sync token expired — clear it and do full re-fetch
        await db
          .prepare(`UPDATE gcal_calendars SET sync_token = NULL, updated_at = ? WHERE id = ? AND npub = ?`)
          .bind(nowSec, calendarId, npub)
          .run();
        const fullUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalId)}/events?timeMin=${encodeURIComponent(sevenDaysAgo)}&timeMax=${encodeURIComponent(sixMonthsAhead)}&singleEvents=true`;
        await doSync(fullUrl);
        return;
      }

      if (!resp.ok) {
        throw new Error(`GCal events fetch failed: HTTP ${resp.status}`);
      }

      const data = (await resp.json()) as {
        items?: GoogleCalendarEvent[];
        nextPageToken?: string;
        nextSyncToken?: string;
      };

      for (const item of data.items ?? []) {
        await upsertGcalEvent(npub, calendarId, item, db);
      }

      nextPageToken = data.nextPageToken;
      syncToken = data.nextSyncToken ?? syncToken;
    } while (nextPageToken);
  };

  let baseUrl: string;
  if (calRow.sync_token) {
    baseUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalId)}/events?syncToken=${encodeURIComponent(calRow.sync_token)}`;
  } else {
    baseUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalId)}/events?timeMin=${encodeURIComponent(sevenDaysAgo)}&timeMax=${encodeURIComponent(sixMonthsAhead)}&singleEvents=true`;
  }

  await doSync(baseUrl);

  if (syncToken) {
    await db
      .prepare(`UPDATE gcal_calendars SET sync_token = ?, updated_at = ? WHERE id = ? AND npub = ?`)
      .bind(syncToken, nowSec, calendarId, npub)
      .run();
  }

  void pageToken; // suppress unused var warning
}

type GoogleCalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  status?: string;
  htmlLink?: string;
};

async function upsertGcalEvent(
  npub: string,
  calendarId: string,
  item: GoogleCalendarEvent,
  db: D1Database,
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const allDay = !item.start?.dateTime ? 1 : 0;
  const startIso = item.start?.dateTime ?? item.start?.date ?? "";
  const endIso = item.end?.dateTime ?? item.end?.date ?? "";
  const eventId = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO gcal_events
         (id, npub, calendar_id, provider_event_id, title, description, location,
          start_iso, end_iso, all_day, status, html_link, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (npub, calendar_id, provider_event_id) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         location = excluded.location,
         start_iso = excluded.start_iso,
         end_iso = excluded.end_iso,
         all_day = excluded.all_day,
         status = excluded.status,
         html_link = excluded.html_link,
         updated_at = excluded.updated_at`,
    )
    .bind(
      eventId, npub, calendarId, item.id ?? "",
      item.summary ?? "", item.description ?? null, item.location ?? null,
      startIso, endIso, allDay,
      item.status ?? "confirmed", item.htmlLink ?? null,
      nowSec, nowSec,
    )
    .run();
}

// --- fetchAndSyncCalendars ---------------------------------------------------

async function fetchAndSyncCalendars(npub: string, accessToken: string, env: Env): Promise<void> {
  const db = requireDb(env);
  const nowSec = Math.floor(Date.now() / 1000);

  const resp = await fetch(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) throw new Error(`GCal calendarList fetch failed: HTTP ${resp.status}`);

  const data = (await resp.json()) as {
    items?: Array<{
      id: string;
      summary?: string;
      primary?: boolean;
      backgroundColor?: string;
      timeZone?: string;
    }>;
  };

  for (const cal of data.items ?? []) {
    const calId = crypto.randomUUID();

    await db
      .prepare(
        `INSERT INTO gcal_calendars
           (id, npub, provider_cal_id, name, primary_cal, selected, color, timezone, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (npub, provider_cal_id) DO UPDATE SET
           name = excluded.name,
           primary_cal = excluded.primary_cal,
           color = excluded.color,
           timezone = excluded.timezone,
           updated_at = excluded.updated_at`,
      )
      .bind(
        calId, npub, cal.id,
        cal.summary ?? cal.id,
        cal.primary ? 1 : 0,
        1, // default selected
        cal.backgroundColor ?? null,
        cal.timeZone ?? null,
        nowSec, nowSec,
      )
      .run();

    // Fetch the actual calendar row to get its id (may differ from calId on conflict)
    const calRow = await db
      .prepare<GcalCalendarRow>(`SELECT * FROM gcal_calendars WHERE npub = ? AND provider_cal_id = ?`)
      .bind(npub, cal.id)
      .first<GcalCalendarRow>();
    if (!calRow) continue;

    try {
      await registerGcalWatch(npub, calRow.id, cal.id, accessToken, env);
    } catch (err) {
      console.warn("registerGcalWatch error", { calendarId: calRow.id, error: (err as Error).message });
    }

    try {
      await syncCalendarEvents(npub, calRow.id, accessToken, env);
    } catch (err) {
      console.warn("syncCalendarEvents error", { calendarId: calRow.id, error: (err as Error).message });
    }
  }

  await db
    .prepare(`UPDATE gcal_connections SET last_sync_at = ?, updated_at = ? WHERE npub = ?`)
    .bind(nowSec, nowSec, npub)
    .run();
}

// --- Route handlers ----------------------------------------------------------

async function handleGcalAuthUrl(request: Request, env: Env): Promise<Response> {
  const auth = await verifyGcalAuth(request);
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);

  const state = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ npub: auth.npub })));
  const params = new URLSearchParams({
    client_id: env.GCAL_CLIENT_ID,
    redirect_uri: "https://taskify.solife.me/api/gcal/auth/callback",
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return jsonResponse({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
}

async function handleGcalAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  if (!code || !stateRaw) {
    return new Response("Missing code or state", { status: 400 });
  }

  let npub: string;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(stateRaw)));
    npub = decoded.npub;
    if (!npub) throw new Error("no npub");
  } catch {
    return new Response("Invalid state", { status: 400 });
  }

  // Exchange code for tokens
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GCAL_CLIENT_ID,
      client_secret: env.GCAL_CLIENT_SECRET,
      redirect_uri: "https://taskify.solife.me/api/gcal/auth/callback",
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResp.ok) {
    return new Response("Token exchange failed", { status: 502 });
  }
  const tokens = (await tokenResp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!tokens.access_token || !tokens.refresh_token) {
    return new Response("Incomplete token response", { status: 502 });
  }

  // Get Google email
  const userResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userResp.ok) {
    return new Response("Failed to get userinfo", { status: 502 });
  }
  const userInfo = (await userResp.json()) as { email?: string };
  const googleEmail = userInfo.email ?? "";

  const nowSec = Math.floor(Date.now() / 1000);
  const keyVersion = gcalCurrentKeyVersion(env);
  const keyHex = env.GCAL_TOKEN_ENC_KEY;

  const encAcc = await gcalEncryptToken(tokens.access_token, keyHex);
  const encRef = await gcalEncryptToken(tokens.refresh_token, keyHex);
  const tokenExpiry = nowSec + (tokens.expires_in ?? 3600);

  const db = requireDb(env);
  await db
    .prepare(
      `INSERT INTO gcal_connections
         (npub, google_email,
          access_token_enc, access_token_iv, access_token_tag,
          refresh_token_enc, refresh_token_iv, refresh_token_tag,
          token_expiry, key_version, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT (npub) DO UPDATE SET
         google_email = excluded.google_email,
         access_token_enc = excluded.access_token_enc,
         access_token_iv = excluded.access_token_iv,
         access_token_tag = excluded.access_token_tag,
         refresh_token_enc = excluded.refresh_token_enc,
         refresh_token_iv = excluded.refresh_token_iv,
         refresh_token_tag = excluded.refresh_token_tag,
         token_expiry = excluded.token_expiry,
         key_version = excluded.key_version,
         status = 'active',
         last_error = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(
      npub, googleEmail,
      encAcc.enc, encAcc.iv, encAcc.tag,
      encRef.enc, encRef.iv, encRef.tag,
      tokenExpiry, keyVersion,
      nowSec, nowSec,
    )
    .run();

  // Initial calendar sync (best-effort)
  try {
    await fetchAndSyncCalendars(npub, tokens.access_token, env);
  } catch (err) {
    console.error("Initial GCal sync error", (err as Error).message);
    await db
      .prepare(`UPDATE gcal_connections SET status = 'sync_failed', last_error = ?, updated_at = ? WHERE npub = ?`)
      .bind((err as Error).message, Math.floor(Date.now() / 1000), npub)
      .run();
  }

  return Response.redirect("https://taskify.solife.me?gcal=connected", 302);
}

async function handleGcalDisconnect(request: Request, env: Env): Promise<Response> {
  const auth = await verifyGcalAuth(request);
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);

  const db = requireDb(env);
  // CASCADE in schema removes gcal_calendars + gcal_events
  await db
    .prepare(`DELETE FROM gcal_connections WHERE npub = ?`)
    .bind(auth.npub)
    .run();

  return jsonResponse({ ok: true });
}

async function handleGcalStatus(request: Request, env: Env): Promise<Response> {
  const auth = await verifyGcalAuth(request);
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);

  const db = requireDb(env);
  const row = await db
    .prepare<GcalConnectionRow>(`SELECT * FROM gcal_connections WHERE npub = ?`)
    .bind(auth.npub)
    .first<GcalConnectionRow>();

  if (!row) {
    return jsonResponse({ connected: false, status: null, googleEmail: null, lastSyncAt: null, lastError: null });
  }

  return jsonResponse({
    connected: true,
    status: row.status,
    googleEmail: row.google_email,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
  });
}

async function handleGcalCalendars(request: Request, env: Env): Promise<Response> {
  const auth = await verifyGcalAuth(request);
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);

  const db = requireDb(env);
  const result = await db
    .prepare<GcalCalendarRow>(
      `SELECT id, name, primary_cal, selected, color, timezone
         FROM gcal_calendars WHERE npub = ? ORDER BY primary_cal DESC, name ASC`,
    )
    .bind(auth.npub)
    .all<GcalCalendarRow>();

  const calendars = (result.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    primary_cal: r.primary_cal === 1,
    selected: r.selected === 1,
    color: r.color,
    timezone: r.timezone,
  }));

  return jsonResponse(calendars);
}

async function handleGcalToggleCalendar(
  request: Request,
  env: Env,
  calendarId: string,
): Promise<Response> {
  const auth = await verifyGcalAuth(request);
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);

  const body = await parseJson(request);
  if (typeof body?.selected !== "boolean") {
    return jsonResponse({ error: "selected (boolean) is required" }, 400);
  }

  const db = requireDb(env);
  const nowSec = Math.floor(Date.now() / 1000);
  // npub scope is mandatory — never just WHERE id = ?
  await db
    .prepare(
      `UPDATE gcal_calendars SET selected = ?, updated_at = ? WHERE id = ? AND npub = ?`,
    )
    .bind(body.selected ? 1 : 0, nowSec, calendarId, auth.npub)
    .run();

  return jsonResponse({ ok: true });
}

async function handleGcalEvents(request: Request, env: Env): Promise<Response> {
  const auth = await verifyGcalAuth(request);
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);

  const url = new URL(request.url);
  const nowSec = Math.floor(Date.now() / 1000);
  const defaultFrom = new Date((nowSec - 7 * 86400) * 1000).toISOString();
  const defaultTo = new Date((nowSec + 180 * 86400) * 1000).toISOString();
  const from = url.searchParams.get("from") ?? defaultFrom;
  const to = url.searchParams.get("to") ?? defaultTo;

  const db = requireDb(env);
  // All WHERE clauses include npub = ? — no cross-user leakage possible
  const result = await db
    .prepare<GcalEventRow>(
      `SELECT e.id, e.npub, e.calendar_id, e.provider_event_id,
              e.title, e.description, e.location,
              e.start_iso, e.end_iso, e.all_day, e.status, e.html_link,
              c.name AS calendar_name, c.color AS calendar_color
         FROM gcal_events e
         JOIN gcal_calendars c ON c.id = e.calendar_id AND c.npub = e.npub
        WHERE e.npub = ?
          AND e.start_iso >= ?
          AND e.start_iso <= ?
          AND e.status != 'cancelled'
        ORDER BY e.start_iso ASC`,
    )
    .bind(auth.npub, from, to)
    .all<GcalEventRow>();

  const events = (result.results ?? []).map((r) => ({
    id: r.id,
    calendarId: r.calendar_id,
    providerEventId: r.provider_event_id,
    calendarName: r.calendar_name ?? r.calendar_id,
    calendarColor: r.calendar_color ?? undefined,
    title: r.title,
    description: r.description,
    location: r.location,
    startISO: r.start_iso,
    endISO: r.end_iso,
    allDay: r.all_day === 1,
    status: r.status,
    htmlLink: r.html_link,
    source: "google" as const,
    kind: "calendar_event" as const,
  }));

  return jsonResponse(events);
}

async function handleGcalSync(request: Request, env: Env): Promise<Response> {
  const auth = await verifyGcalAuth(request);
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);

  const db = requireDb(env);
  const conn = await db
    .prepare<GcalConnectionRow>(`SELECT * FROM gcal_connections WHERE npub = ?`)
    .bind(auth.npub)
    .first<GcalConnectionRow>();

  if (!conn) return jsonResponse({ error: "Not connected" }, 404);

  let accessToken: string;
  try {
    accessToken = await refreshGcalTokenIfNeeded(auth.npub, env);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 502);
  }

  const calendarsResult = await db
    .prepare<GcalCalendarRow>(
      `SELECT * FROM gcal_calendars WHERE npub = ?`,
    )
    .bind(auth.npub)
    .all<GcalCalendarRow>();

  let synced = 0;
  const errors: string[] = [];

  for (const cal of calendarsResult.results ?? []) {
    try {
      await syncCalendarEvents(auth.npub, cal.id, accessToken, env);
      synced++;
    } catch (err) {
      errors.push(`${cal.name}: ${(err as Error).message}`);
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  await db
    .prepare(`UPDATE gcal_connections SET last_sync_at = ?, updated_at = ? WHERE npub = ?`)
    .bind(nowSec, nowSec, auth.npub)
    .run();

  return jsonResponse({ synced, errors });
}

async function handleGcalWebhook(
  request: Request,
  env: Env,
  channelId: string,
  ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  // Validate secret before any DB lookup
  const channelToken = request.headers.get("X-Goog-Channel-Token");
  if (channelToken !== env.GCAL_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const db = requireDb(env);
  const calRow = await db
    .prepare<GcalCalendarRow>(
      `SELECT * FROM gcal_calendars WHERE watch_channel_id = ?`,
    )
    .bind(channelId)
    .first<GcalCalendarRow>();

  if (!calRow) return new Response("Not Found", { status: 404 });

  ctx.waitUntil(
    (async () => {
      try {
        const accessToken = await refreshGcalTokenIfNeeded(calRow.npub, env);
        await syncCalendarEvents(calRow.npub, calRow.id, accessToken, env);
      } catch (err) {
        console.error("Webhook sync error", { channelId, error: (err as Error).message });
      }
    })(),
  );

  return new Response(null, { status: 200 });
}

// --- Cron helpers ------------------------------------------------------------

async function gcalRenewExpiredWatches(env: Env): Promise<void> {
  const db = requireDb(env);
  const nowSec = Math.floor(Date.now() / 1000);

  const result = await db
    .prepare<GcalCalendarRow>(
      `SELECT * FROM gcal_calendars WHERE watch_expiry < ? OR watch_expiry IS NULL`,
    )
    .bind(nowSec + 86400)
    .all<GcalCalendarRow>();

  for (const cal of result.results ?? []) {
    try {
      const accessToken = await refreshGcalTokenIfNeeded(cal.npub, env);
      await registerGcalWatch(cal.npub, cal.id, cal.provider_cal_id, accessToken, env);
    } catch (err) {
      console.error("gcalRenewExpiredWatches error", { calId: cal.id, error: (err as Error).message });
    }
  }
}

async function gcalRetryFailedSyncs(env: Env): Promise<void> {
  const db = requireDb(env);

  const result = await db
    .prepare<GcalConnectionRow>(
      `SELECT * FROM gcal_connections WHERE status = 'sync_failed'`,
    )
    .all<GcalConnectionRow>();

  for (const conn of result.results ?? []) {
    try {
      const accessToken = await refreshGcalTokenIfNeeded(conn.npub, env);
      await fetchAndSyncCalendars(conn.npub, accessToken, env);
      await db
        .prepare(`UPDATE gcal_connections SET status = 'active', last_error = NULL, updated_at = ? WHERE npub = ?`)
        .bind(Math.floor(Date.now() / 1000), conn.npub)
        .run();
    } catch (err) {
      console.error("gcalRetryFailedSyncs error", { npub: conn.npub, error: (err as Error).message });
      await db
        .prepare(`UPDATE gcal_connections SET last_error = ?, updated_at = ? WHERE npub = ?`)
        .bind((err as Error).message, Math.floor(Date.now() / 1000), conn.npub)
        .run();
    }
  }
}

export {
  gcalEncryptToken,
  gcalDecryptToken,
  verifyGcalAuth,
  ensureGcalSchema,
  handleGcalAuthUrl,
  handleGcalAuthCallback,
  handleGcalDisconnect,
  handleGcalStatus,
  handleGcalCalendars,
  handleGcalToggleCalendar,
  handleGcalEvents,
  handleGcalSync,
  handleGcalWebhook,
  gcalRenewExpiredWatches,
  gcalRetryFailedSyncs,
};
