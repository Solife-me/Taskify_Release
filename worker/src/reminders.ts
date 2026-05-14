// Reminders, devices, and push notification delivery — extracted from
// index.ts (Item #12 worker module split, pass 3).
//
// Owns the full lifecycle:
//   - device registration / lookup (D1 + KV migration)
//   - reminder schedule storage and per-minute cron processing
//   - VAPID-authenticated Web Push delivery
//   - PEM/JSON key resolution for the VAPID private key

import type { Env, D1Database } from "./lib.ts";
import { requireDb, jsonResponse, base64UrlEncode, base64UrlDecode, parseJson, JSON_HEADERS } from "./lib.ts";

// ---- Module-level state (caches + key-lookup constants) ----

let cachedPrivateKey: CryptoKey | null = null;
const PRIVATE_KEY_KV_KEYS = ["VAPID_PRIVATE_KEY", "private-key", "key"] as const;

// ---- Types ----

type PushPlatform = "ios" | "android";

type SubscriptionRecord = {
  endpoint: string;
  keys: { auth: string; p256dh: string };
};

type DeviceRecord = {
  deviceId: string;
  platform: PushPlatform;
  subscription: SubscriptionRecord;
  endpointHash: string;
};

type ReminderTaskInput = {
  taskId: string;
  boardId?: string;
  title: string;
  dueISO: string;
  minutesBefore: number[];
};

type ReminderEntry = {
  reminderKey: string;
  taskId: string;
  boardId?: string;
  title: string;
  dueISO: string;
  minutes: number;
  sendAt: number;
};

type PendingReminder = {
  taskId: string;
  boardId?: string;
  title: string;
  dueISO: string;
  minutes: number;
};

type DeviceRow = {
  device_id: string;
  platform: PushPlatform;
  endpoint: string;
  endpoint_hash: string;
  subscription_auth: string;
  subscription_p256dh: string;
  updated_at: number;
};

type ReminderRow = {
  device_id: string;
  reminder_key: string;
  task_id: string;
  board_id: string | null;
  title: string;
  due_iso: string;
  minutes: number;
  send_at: number;
};

type PendingRow = {
  id: number;
  device_id: string;
  task_id: string;
  board_id: string | null;
  title: string;
  due_iso: string;
  minutes: number;
  created_at: number;
};

// ---- Handlers / scheduled tasks ----

async function handleRegisterDevice(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const { deviceId, platform, subscription } = body || {};
  if (!deviceId || typeof deviceId !== "string") {
    return jsonResponse({ error: "deviceId is required" }, 400);
  }
  if (platform !== "ios" && platform !== "android") {
    return jsonResponse({ error: "platform must be ios or android" }, 400);
  }
  if (!subscription || typeof subscription !== "object" || typeof subscription.endpoint !== "string") {
    return jsonResponse({ error: "subscription is required" }, 400);
  }
  if (!subscription.keys || typeof subscription.keys.auth !== "string" || typeof subscription.keys.p256dh !== "string") {
    return jsonResponse({ error: "subscription keys are invalid" }, 400);
  }

  const endpointHash = await hashEndpoint(subscription.endpoint);

  let resolvedDeviceId = deviceId;
  const existingById = await getDeviceRecord(env, deviceId);
  if (!existingById) {
    const existingByEndpoint = await findDeviceIdByEndpoint(env, subscription.endpoint);
    if (existingByEndpoint) {
      resolvedDeviceId = existingByEndpoint;
    }
  }

  const record: DeviceRecord = {
    deviceId: resolvedDeviceId,
    platform,
    subscription: {
      endpoint: subscription.endpoint,
      keys: {
        auth: subscription.keys.auth,
        p256dh: subscription.keys.p256dh,
      },
    },
    endpointHash,
  };
  await upsertDevice(env, record, Date.now());

  return jsonResponse({ subscriptionId: endpointHash, deviceId: resolvedDeviceId });
}



async function handleDeleteDevice(deviceId: string, env: Env): Promise<Response> {
  const db = requireDb(env);
  const existing = await db
    .prepare<{ endpoint_hash: string | null }>(
      `SELECT endpoint_hash
       FROM devices
       WHERE device_id = ?`,
    )
    .bind(deviceId)
    .first<{ endpoint_hash: string | null }>();

  await db.batch([
    db.prepare("DELETE FROM pending_notifications WHERE device_id = ?").bind(deviceId),
    db.prepare("DELETE FROM reminders WHERE device_id = ?").bind(deviceId),
    db.prepare("DELETE FROM devices WHERE device_id = ?").bind(deviceId),
  ]);

  if (env.TASKIFY_DEVICES) {
    await env.TASKIFY_DEVICES.delete(deviceKey(deviceId)).catch(() => {});
    const endpointHash = existing?.endpoint_hash;
    if (endpointHash) {
      await env.TASKIFY_DEVICES.delete(endpointKey(endpointHash)).catch(() => {});
    }
  }
  await env.TASKIFY_REMINDERS?.delete(remindersKey(deviceId)).catch(() => {});
  await env.TASKIFY_PENDING?.delete(pendingKey(deviceId)).catch(() => {});

  return new Response(null, { status: 204, headers: JSON_HEADERS });
}

async function handleSaveReminders(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const { deviceId, reminders } = body || {};
  if (!deviceId || typeof deviceId !== "string") {
    return jsonResponse({ error: "deviceId is required" }, 400);
  }
  if (!(await getDeviceRecord(env, deviceId))) {
    return jsonResponse({ error: "Unknown device" }, 404);
  }
  if (!Array.isArray(reminders)) {
    return jsonResponse({ error: "reminders must be an array" }, 400);
  }

  const db = requireDb(env);
  const now = Date.now();
  const entries: ReminderEntry[] = [];
  for (const item of reminders as ReminderTaskInput[]) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.taskId !== "string" || typeof item.title !== "string" || typeof item.dueISO !== "string") continue;
    if (!Array.isArray(item.minutesBefore)) continue;
    const dueTime = Date.parse(item.dueISO);
    if (Number.isNaN(dueTime)) continue;
    for (const minutes of item.minutesBefore) {
      if (!Number.isFinite(minutes)) continue;
      const sendAt = dueTime - minutes * MINUTE_MS;
      if (sendAt <= now - MINUTE_MS) continue; // skip very old reminders
      const reminderKey = `${item.taskId}:${minutes}`;
      entries.push({
        reminderKey,
        taskId: item.taskId,
        boardId: item.boardId,
        title: item.title,
        dueISO: item.dueISO,
        minutes,
        sendAt,
      });
    }
  }

  const statements = [db.prepare("DELETE FROM reminders WHERE device_id = ?").bind(deviceId)];
  if (entries.length > 0) {
    entries.sort((a, b) => a.sendAt - b.sendAt);
    for (const entry of entries) {
      statements.push(
        db
          .prepare(
            `INSERT INTO reminders (device_id, reminder_key, task_id, board_id, title, due_iso, minutes, send_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            deviceId,
            entry.reminderKey,
            entry.taskId,
            entry.boardId ?? null,
            entry.title,
            entry.dueISO,
            entry.minutes,
            entry.sendAt,
          ),
      );
    }
  }

  await db.batch(statements);
  await db.prepare("DELETE FROM pending_notifications WHERE device_id = ?").bind(deviceId).run();

  return new Response(null, { status: 204, headers: JSON_HEADERS });
}

async function handlePollReminders(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const { endpoint, deviceId } = body || {};
  let resolvedDeviceId = typeof deviceId === "string" ? deviceId : undefined;
  if (!resolvedDeviceId && typeof endpoint === "string") {
    resolvedDeviceId = await findDeviceIdByEndpoint(env, endpoint);
  }
  if (!resolvedDeviceId) {
    return jsonResponse({ error: "Device not registered" }, 404);
  }
  const db = requireDb(env);
  const pendingRows = await db
    .prepare<PendingRow>(
      `SELECT id, task_id, board_id, title, due_iso, minutes
       FROM pending_notifications
       WHERE device_id = ?
       ORDER BY created_at, id`,
    )
    .bind(resolvedDeviceId)
    .all<PendingRow>();

  const rows = pendingRows.results ?? [];
  if (!rows.length) {
    return jsonResponse([]);
  }
  const deleteStatements = rows.map((row) => db.prepare("DELETE FROM pending_notifications WHERE id = ?").bind(row.id));
  await db.batch(deleteStatements);

  return jsonResponse(
    rows.map((row) => ({
      taskId: row.task_id,
      boardId: row.board_id ?? undefined,
      title: row.title,
      dueISO: row.due_iso,
      minutes: row.minutes,
    })),
  );
}

async function processDueReminders(env: Env): Promise<void> {
  const now = Date.now();
  const batchSize = 256;
  const db = requireDb(env);

  // Process in batches to keep cron executions bounded.
  while (true) {
    const dueResult = await db
      .prepare<ReminderRow>(
        `SELECT device_id, reminder_key, task_id, board_id, title, due_iso, minutes, send_at
         FROM reminders
         WHERE send_at <= ?
         ORDER BY send_at
         LIMIT ?`,
      )
      .bind(now, batchSize)
      .all<ReminderRow>();

    const dueReminders = dueResult.results ?? [];
    if (!dueReminders.length) {
      break;
    }

    const deleteStatements = dueReminders.map((reminder) =>
      db
        .prepare("DELETE FROM reminders WHERE device_id = ? AND reminder_key = ?")
        .bind(reminder.device_id, reminder.reminder_key),
    );
    await db.batch(deleteStatements);

    const grouped = new Map<string, ReminderRow[]>();
    for (const reminder of dueReminders) {
      const existing = grouped.get(reminder.device_id);
      if (existing) {
        existing.push(reminder);
      } else {
        grouped.set(reminder.device_id, [reminder]);
      }
    }

    for (const [deviceId, reminders] of grouped) {
      const device = await getDeviceRecord(env, deviceId);
      if (!device) {
        await db.prepare("DELETE FROM pending_notifications WHERE device_id = ?").bind(deviceId).run();
        continue;
      }
      const pendingNotifications: PendingReminder[] = reminders.map((reminder) => ({
        taskId: reminder.task_id,
        boardId: reminder.board_id ?? undefined,
        title: reminder.title,
        dueISO: reminder.due_iso,
        minutes: reminder.minutes,
      }));
      await appendPending(env, deviceId, pendingNotifications);
      const ttlSeconds = computeReminderTTL(pendingNotifications, now);
      await sendPushPing(env, device, deviceId, ttlSeconds);
    }

    if (dueReminders.length < batchSize) {
      break;
    }
  }
}

async function appendPending(env: Env, deviceId: string, notifications: PendingReminder[]): Promise<void> {
  if (!notifications.length) return;
  const now = Date.now();
  const db = requireDb(env);
  const statements = notifications.map((notification) =>
    db
      .prepare(
        `INSERT INTO pending_notifications (device_id, task_id, board_id, title, due_iso, minutes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        deviceId,
        notification.taskId,
        notification.boardId ?? null,
        notification.title,
        notification.dueISO,
        notification.minutes,
        now,
      ),
  );
  await db.batch(statements);
}

async function upsertDevice(env: Env, record: DeviceRecord, updatedAt: number): Promise<void> {
  const db = requireDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO devices (device_id, platform, endpoint, endpoint_hash, subscription_auth, subscription_p256dh, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           platform = excluded.platform,
           endpoint = excluded.endpoint,
           endpoint_hash = excluded.endpoint_hash,
           subscription_auth = excluded.subscription_auth,
           subscription_p256dh = excluded.subscription_p256dh,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.deviceId,
        record.platform,
        record.subscription.endpoint,
        record.endpointHash,
        record.subscription.keys.auth,
        record.subscription.keys.p256dh,
        updatedAt,
      ),
  ]);
}

async function getDeviceRecord(env: Env, deviceId: string): Promise<DeviceRecord | null> {
  const db = requireDb(env);
  const row = await db
    .prepare<DeviceRow>(
      `SELECT device_id, platform, endpoint, endpoint_hash, subscription_auth, subscription_p256dh
       FROM devices
       WHERE device_id = ?`,
    )
    .bind(deviceId)
    .first<DeviceRow>();
  if (!row) {
    return migrateDeviceFromKv(env, deviceId);
  }
  return {
    deviceId: row.device_id,
    platform: row.platform,
    endpointHash: row.endpoint_hash,
    subscription: {
      endpoint: row.endpoint,
      keys: {
        auth: row.subscription_auth,
        p256dh: row.subscription_p256dh,
      },
    },
  };
}

async function findDeviceIdByEndpoint(env: Env, endpoint: string): Promise<string | undefined> {
  const hash = await hashEndpoint(endpoint);
  const db = requireDb(env);
  const row = await db
    .prepare<{ device_id: string }>(
      `SELECT device_id
       FROM devices
       WHERE endpoint_hash = ?`,
    )
    .bind(hash)
    .first<{ device_id: string }>();
  if (row?.device_id) {
    return row.device_id;
  }
  if (!env.TASKIFY_DEVICES) {
    return undefined;
  }
  const legacyDeviceId = await env.TASKIFY_DEVICES.get(endpointKey(hash));
  if (!legacyDeviceId) {
    return undefined;
  }
  await migrateDeviceFromKv(env, legacyDeviceId);
  return legacyDeviceId;
}

async function migrateDeviceFromKv(env: Env, deviceId: string): Promise<DeviceRecord | null> {
  const kvDevices = env.TASKIFY_DEVICES;
  if (!kvDevices) return null;

  const raw = await kvDevices.get(deviceKey(deviceId));
  if (!raw) return null;

  let parsed: DeviceRecord | null = null;
  try {
    const maybe = JSON.parse(raw) as DeviceRecord;
    if (
      maybe &&
      typeof maybe.deviceId === "string" &&
      (maybe.platform === "ios" || maybe.platform === "android") &&
      maybe.subscription &&
      typeof maybe.subscription.endpoint === "string" &&
      maybe.subscription.keys &&
      typeof maybe.subscription.keys.auth === "string" &&
      typeof maybe.subscription.keys.p256dh === "string"
    ) {
      parsed = maybe;
    }
  } catch (err) {
    console.warn("Failed to parse legacy device record", deviceId, err);
    return null;
  }

  if (!parsed) return null;

  if (!parsed.endpointHash) {
    parsed.endpointHash = await hashEndpoint(parsed.subscription.endpoint);
  }

  await upsertDevice(env, parsed, Date.now());

  await migrateRemindersFromKv(env, deviceId);
  await migratePendingFromKv(env, deviceId);

  await Promise.all([
    kvDevices.delete(deviceKey(deviceId)).catch(() => {}),
    parsed.endpointHash ? kvDevices.delete(endpointKey(parsed.endpointHash)).catch(() => {}) : Promise.resolve(),
  ]);

  return parsed;
}

async function migrateRemindersFromKv(env: Env, deviceId: string): Promise<void> {
  const kvReminders = env.TASKIFY_REMINDERS;
  if (!kvReminders) return;

  const raw = await kvReminders.get(remindersKey(deviceId));
  if (!raw) return;

  let entries: ReminderEntry[] = [];
  try {
    const maybe = JSON.parse(raw);
    if (Array.isArray(maybe)) {
      entries = maybe as ReminderEntry[];
    }
  } catch (err) {
    console.warn("Failed to parse legacy reminders", { deviceId, err });
    entries = [];
  }

  if (!entries.length) {
    await kvReminders.delete(remindersKey(deviceId)).catch(() => {});
    return;
  }

  const db = requireDb(env);
  const statements = [db.prepare("DELETE FROM reminders WHERE device_id = ?").bind(deviceId)];
  entries.sort((a, b) => (a?.sendAt ?? 0) - (b?.sendAt ?? 0));
  for (const entry of entries) {
    if (!entry || typeof entry.reminderKey !== "string" || typeof entry.taskId !== "string") continue;
    if (typeof entry.title !== "string" || typeof entry.dueISO !== "string" || typeof entry.minutes !== "number") continue;
    if (typeof entry.sendAt !== "number") continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO reminders (device_id, reminder_key, task_id, board_id, title, due_iso, minutes, send_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
        .bind(
          deviceId,
          entry.reminderKey,
          entry.taskId,
          entry.boardId ?? null,
          entry.title,
          entry.dueISO,
          entry.minutes,
          entry.sendAt,
        ),
    );
  }

  if (statements.length > 1) {
    await db.batch(statements);
  } else {
    await statements[0].run();
  }

  await kvReminders.delete(remindersKey(deviceId)).catch(() => {});
}

async function migratePendingFromKv(env: Env, deviceId: string): Promise<void> {
  const kvPending = env.TASKIFY_PENDING;
  if (!kvPending) return;

  const raw = await kvPending.get(pendingKey(deviceId));
  if (!raw) return;

  let entries: PendingReminder[] = [];
  try {
    const maybe = JSON.parse(raw);
    if (Array.isArray(maybe)) {
      entries = maybe as PendingReminder[];
    }
  } catch (err) {
    console.warn("Failed to parse legacy pending payload", { deviceId, err });
    entries = [];
  }

  const normalized = entries.filter(
    (entry) =>
      entry &&
      typeof entry.taskId === "string" &&
      typeof entry.title === "string" &&
      typeof entry.dueISO === "string" &&
      typeof entry.minutes === "number",
  );

  if (!normalized.length) {
    await kvPending.delete(pendingKey(deviceId)).catch(() => {});
    return;
  }

  const db = requireDb(env);
  await db.prepare("DELETE FROM pending_notifications WHERE device_id = ?").bind(deviceId).run();
  await appendPending(env, deviceId, normalized);
  await kvPending.delete(pendingKey(deviceId)).catch(() => {});
}

function deviceKey(deviceId: string): string {
  return `device:${deviceId}`;
}

function remindersKey(deviceId: string): string {
  return `reminders:${deviceId}`;
}

function pendingKey(deviceId: string): string {
  return `pending:${deviceId}`;
}

function endpointKey(hash: string): string {
  return `endpoint:${hash}`;
}

function computeReminderTTL(reminders: PendingReminder[], now: number): number {
  let ttl = 300; // minimum of 5 minutes to give the device time to wake
  for (const reminder of reminders) {
    if (!reminder || typeof reminder.dueISO !== "string") continue;
    const due = Date.parse(reminder.dueISO);
    if (Number.isNaN(due)) continue;
    const secondsUntilDue = Math.max(0, Math.ceil((due - now) / 1000));
    ttl = Math.max(ttl, secondsUntilDue + 120); // allow a small buffer past due time
  }
  return Math.max(300, Math.min(86400, ttl));
}

async function sendPushPing(env: Env, device: DeviceRecord, deviceId: string, ttlSeconds: number): Promise<void> {
  try {
    const endpoint = device.subscription.endpoint;
    const url = new URL(endpoint);
    const aud = `${url.protocol}//${url.host}`;
    const token = await createVapidJWT(env, aud);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        TTL: String(ttlSeconds),
        Authorization: `WebPush ${token}`,
        "Crypto-Key": `p256ecdsa=${env.VAPID_PUBLIC_KEY}`,
        "Content-Length": "0",
      },
    });

    if (response.status === 404 || response.status === 410) {
      console.warn("Subscription expired", deviceId);
      await handleDeleteDevice(deviceId, env);
      return;
    }

    if (!response.ok) {
      const text = await response.text();
      console.warn("Push ping failed", response.status, text);
    }
  } catch (err) {
    console.error("Push ping error", err);
  }
}

async function createVapidJWT(env: Env, aud: string): Promise<string> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_SUBJECT) {
    throw new Error("VAPID keys are not configured");
  }
  const subject = normalizeVapidSubject(env.VAPID_SUBJECT);
  if (!subject) {
    throw new Error("VAPID subject is not configured");
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 12 * 60 * 60; // 12 hours
  const header = base64UrlEncodeJSON({ alg: "ES256", typ: "JWT" });
  const payload = base64UrlEncodeJSON({ aud, exp, sub: subject });
  const signingInput = `${header}.${payload}`;
  const key = await getPrivateKey(env);
  const signatureBuffer = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  const signature = base64UrlEncode(new Uint8Array(signatureBuffer));
  return `${signingInput}.${signature}`;
}

async function getPrivateKey(env: Env): Promise<CryptoKey> {
  if (cachedPrivateKey) return cachedPrivateKey;
  const pem = await resolvePrivateKeyPem(env);
  const keyBytes = decodePemKey(pem);
  if (!keyBytes.length) {
    throw new Error("VAPID private key material is empty");
  }

  try {
    cachedPrivateKey = await crypto.subtle.importKey(
      "pkcs8",
      keyBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    return cachedPrivateKey;
  } catch (err) {
    if (!shouldAttemptRawVapidImport(err, keyBytes)) {
      throw err;
    }
    cachedPrivateKey = await importRawVapidPrivateKey(env, keyBytes);
    return cachedPrivateKey;
  }
}

async function resolvePrivateKeyPem(env: Env): Promise<string> {
  const binding = env.VAPID_PRIVATE_KEY as unknown;
  if (typeof binding === "string") {
    const trimmed = binding.trim();
    if (trimmed) return trimmed;
  }

  const maybeKv = binding as KVNamespace | undefined;
  if (maybeKv && typeof maybeKv.get === "function") {
    for (const candidate of PRIVATE_KEY_KV_KEYS) {
      try {
        const value = await maybeKv.get(candidate);
        if (value && value.trim()) return value.trim();
      } catch {
        // ignore and try next candidate
      }
    }
  }

  throw new Error("VAPID private key is not configured");
}

function shouldAttemptRawVapidImport(err: unknown, keyBytes: Uint8Array): boolean {
  if (!keyBytes || keyBytes.length !== 32) return false;
  if (!err) return false;
  const name = typeof (err as { name?: string }).name === "string" ? (err as { name?: string }).name : "";
  if (name === "DataError") return true;
  const message = typeof (err as Error).message === "string" ? (err as Error).message : "";
  return /invalid pkcs8/i.test(message);
}

async function importRawVapidPrivateKey(env: Env, scalar: Uint8Array): Promise<CryptoKey> {
  if (scalar.length !== 32) {
    throw new Error("Raw VAPID private key must be 32 bytes");
  }
  if (!env.VAPID_PUBLIC_KEY) {
    throw new Error("VAPID public key is required to import raw private key material");
  }
  const publicBytes = base64UrlDecode(env.VAPID_PUBLIC_KEY.trim());
  if (publicBytes.length !== 65 || publicBytes[0] !== 4) {
    throw new Error("VAPID public key is not a valid uncompressed P-256 point");
  }
  const xBytes = publicBytes.slice(1, 33);
  const yBytes = publicBytes.slice(33, 65);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    ext: false,
    key_ops: ["sign"],
    d: base64UrlEncode(scalar),
    x: base64UrlEncode(xBytes),
    y: base64UrlEncode(yBytes),
  } as JsonWebKey;

  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

// ---- Push delivery helpers (endpoint hash, PEM/JSON key decode, VAPID JWT encoding) ----

async function hashEndpoint(endpoint: string): Promise<string> {
  const data = new TextEncoder().encode(endpoint);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function decodePemKey(pem: string): Uint8Array {
  const trimmed = pem.trim();
  if (!trimmed) return new Uint8Array();

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const nested = typeof parsed?.privateKey === "string"
        ? parsed.privateKey
        : typeof parsed?.key === "string"
          ? parsed.key
          : typeof parsed?.value === "string"
            ? parsed.value
            : undefined;
      if (nested) {
        return decodePemKey(nested);
      }
    } catch {
      // fall through to base64 decoding
    }
  }

  const cleaned = trimmed
    .replace(/-----BEGIN [^-----]+-----/g, "")
    .replace(/-----END [^-----]+-----/g, "")
    .replace(/\s+/g, "");

  if (!cleaned) return new Uint8Array();
  return base64UrlDecode(cleaned);
}

function base64UrlEncodeJSON(value: unknown): string {
  const text = JSON.stringify(value);
  return base64UrlEncode(new TextEncoder().encode(text));
}

function normalizeVapidSubject(subjectRaw: string): string {
  if (typeof subjectRaw !== "string") return "";
  const trimmed = subjectRaw.trim();
  if (!trimmed) return "";

  if (/^mailto:/i.test(trimmed)) {
    const mailto = trimmed.replace(/^mailto:/i, "").replace(/\s+/g, "");
    return mailto ? `mailto:${mailto}` : "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\s+/g, "");
  }

  return trimmed;
}



export {
  handleRegisterDevice,
  handleDeleteDevice,
  handleSaveReminders,
  handlePollReminders,
  processDueReminders,
};
