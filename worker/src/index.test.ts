import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.ts";
import { gcalEncryptToken, gcalDecryptToken, verifyGcalAuth } from "./index.ts";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { watchNostrBridgeTestHooks } from "./nostr-bridge.ts";

type DeviceRow = {
  device_id: string;
  platform: "ios" | "android";
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

class MockD1 {
  devices = new Map<string, DeviceRow>();
  reminders: ReminderRow[] = [];
  pending: PendingRow[] = [];
  pendingId = 1;

  prepare(query: string) {
    const db = this;
    const sql = query.replace(/\s+/g, " ").trim();
    let params: unknown[] = [];

    return {
      _sql: sql,
      _getParams: () => params,
      bind(...values: unknown[]) {
        params = values;
        return this;
      },
      async run() {
        if (/^PRAGMA /i.test(sql) || /^CREATE TABLE/i.test(sql) || /^CREATE INDEX/i.test(sql)) {
          return { success: true };
        }

        if (sql.startsWith("INSERT INTO devices ")) {
          const [device_id, platform, endpoint, endpoint_hash, auth, p256dh, updated_at] = params as [
            string,
            "ios" | "android",
            string,
            string,
            string,
            string,
            number,
          ];
          db.devices.set(device_id, {
            device_id,
            platform,
            endpoint,
            endpoint_hash,
            subscription_auth: auth,
            subscription_p256dh: p256dh,
            updated_at,
          });
          return { success: true };
        }

        if (sql.startsWith("INSERT INTO reminders ")) {
          const [device_id, reminder_key, task_id, board_id, title, due_iso, minutes, send_at] = params as [
            string,
            string,
            string,
            string | null,
            string,
            string,
            number,
            number,
          ];
          db.reminders.push({ device_id, reminder_key, task_id, board_id, title, due_iso, minutes, send_at });
          return { success: true };
        }

        if (sql.startsWith("INSERT INTO pending_notifications ")) {
          const [device_id, task_id, board_id, title, due_iso, minutes, created_at] = params as [
            string,
            string,
            string | null,
            string,
            string,
            number,
            number,
          ];
          db.pending.push({ id: db.pendingId++, device_id, task_id, board_id, title, due_iso, minutes, created_at });
          return { success: true };
        }

        if (sql.startsWith("DELETE FROM pending_notifications WHERE device_id = ?")) {
          const [deviceId] = params as [string];
          db.pending = db.pending.filter((p) => p.device_id !== deviceId);
          return { success: true };
        }

        if (sql.startsWith("DELETE FROM reminders WHERE device_id = ? AND reminder_key = ?")) {
          const [deviceId, reminderKey] = params as [string, string];
          db.reminders = db.reminders.filter((r) => !(r.device_id === deviceId && r.reminder_key === reminderKey));
          return { success: true };
        }

        if (sql.startsWith("DELETE FROM reminders WHERE device_id = ?")) {
          const [deviceId] = params as [string];
          db.reminders = db.reminders.filter((r) => r.device_id !== deviceId);
          return { success: true };
        }

        if (sql.startsWith("DELETE FROM pending_notifications WHERE id = ?")) {
          const [id] = params as [number];
          db.pending = db.pending.filter((p) => p.id !== id);
          return { success: true };
        }

        if (sql.startsWith("DELETE FROM devices WHERE device_id = ?")) {
          const [deviceId] = params as [string];
          db.devices.delete(deviceId);
          return { success: true };
        }

        return { success: true };
      },
      async first() {
        if (sql.includes("FROM devices") && sql.includes("WHERE device_id = ?")) {
          const [deviceId] = params as [string];
          return db.devices.get(deviceId) ?? null;
        }
        if (sql.includes("SELECT device_id") && sql.includes("FROM devices") && sql.includes("endpoint_hash = ?")) {
          const [hash] = params as [string];
          const found = [...db.devices.values()].find((d) => d.endpoint_hash === hash);
          return found ? ({ device_id: found.device_id } as any) : null;
        }
        if (sql.includes("SELECT endpoint_hash") && sql.includes("FROM devices") && sql.includes("WHERE device_id = ?")) {
          const [deviceId] = params as [string];
          const d = db.devices.get(deviceId);
          return d ? ({ endpoint_hash: d.endpoint_hash } as any) : null;
        }
        return null;
      },
      async all() {
        if (sql.includes("FROM pending_notifications") && sql.includes("WHERE device_id = ?")) {
          const [deviceId] = params as [string];
          const rows = db.pending
            .filter((p) => p.device_id === deviceId)
            .sort((a, b) => (a.created_at - b.created_at) || (a.id - b.id));
          return { success: true, results: rows };
        }
        if (sql.includes("FROM reminders") && sql.includes("WHERE send_at <= ?")) {
          const [now, limit] = params as [number, number];
          const rows = db.reminders
            .filter((r) => r.send_at <= now)
            .sort((a, b) => a.send_at - b.send_at)
            .slice(0, limit);
          return { success: true, results: rows };
        }
        return { success: true, results: [] };
      },
    };
  }

  async batch(statements: any[]) {
    const out: any[] = [];
    for (const st of statements) {
      out.push(await st.run());
    }
    return out;
  }
}

function base64UrlEncode(buffer: Uint8Array): string {
  let s = "";
  for (const b of buffer) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function createVapidFixture() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));

  const pemBody = btoa(String.fromCharCode(...pkcs8)).match(/.{1,64}/g)?.join("\n") ?? "";
  const privatePem = `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----`;

  const uncompressed = spki.slice(-65);
  const publicKey = base64UrlEncode(uncompressed);

  return { privatePem, publicKey };
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeEnv(db: MockD1) {
  const vapid = await createVapidFixture();
  return {
    ASSETS: {
      fetch: async () => new Response("asset", { status: 200 }),
    },
    TASKIFY_DB: db as any,
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privatePem,
    VAPID_SUBJECT: "mailto:test@example.com",
  } as any;
}

test("GET /api/config returns worker origin and vapid key", async () => {
  const db = new MockD1();
  const env = await makeEnv(db);

  const req = new Request("https://taskify-v2.solife.me/api/config", { method: "GET" });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.workerBaseUrl, "https://taskify-v2.solife.me");
  assert.equal(body.vapidPublicKey, env.VAPID_PUBLIC_KEY);
});

test("static assets are served with security headers", async () => {
  const db = new MockD1();
  const env = await makeEnv(db);

  const res = await worker.fetch(
    new Request("https://taskify-v2.solife.me/", { method: "GET" }),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(res.headers.get("Referrer-Policy"), "same-origin");
  assert.equal(
    res.headers.get("Permissions-Policy"),
    "camera=(), microphone=(), geolocation=()",
  );
});

test("static assets and config do not initialize the D1 schema", async () => {
  const env = await makeEnv(new MockD1());
  env.TASKIFY_DB = {
    prepare() {
      throw new Error("D1 should not be touched for this route");
    },
  };

  const config = await worker.fetch(new Request("https://taskify-v2.solife.me/api/config"), env);
  assert.equal(config.status, 200);
  const asset = await worker.fetch(new Request("https://taskify-v2.solife.me/app.js"), env);
  assert.equal(asset.status, 200);
});

test("removed cloud-backup API returns 404 instead of the PWA shell", async () => {
  const env = await makeEnv(new MockD1());
  const res = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/backups?npub=npub1obsolete"),
    env,
  );
  assert.equal(res.status, 404);
});

test("sw.js is served with no-cache and worker-allowed scope", async () => {
  const db = new MockD1();
  const env = await makeEnv(db);

  const res = await worker.fetch(
    new Request("https://taskify-v2.solife.me/sw.js", { method: "GET" }),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-cache");
  assert.equal(res.headers.get("Service-Worker-Allowed"), "/");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
});

test("PUT /api/reminders returns 404 for unknown device", async () => {
  const db = new MockD1();
  const env = await makeEnv(db);

  const req = new Request("https://taskify-v2.solife.me/api/reminders", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "missing", reminders: [] }),
  });

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 404);
});

test("POST /api/reminders/poll retains notifications until the client acknowledges them", async () => {
  const db = new MockD1();
  const env = await makeEnv(db);

  const endpoint = "https://push.example/dev-1";
  db.devices.set("dev-1", {
    device_id: "dev-1",
    platform: "ios",
    endpoint,
    endpoint_hash: await sha256Hex(endpoint),
    subscription_auth: "auth",
    subscription_p256dh: "p256dh",
    updated_at: Date.now(),
  });

  db.pending.push({
    id: 1,
    device_id: "dev-1",
    task_id: "task-1",
    board_id: "board-1",
    title: "Task",
    due_iso: new Date(Date.now() + 60000).toISOString(),
    minutes: 15,
    created_at: Date.now(),
  });

  const req = new Request("https://taskify-v2.solife.me/api/reminders/poll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const body = await res.json() as any[];
  assert.equal(body.length, 1);
  assert.equal(body[0].notificationId, 1);
  assert.equal(db.pending.length, 1, "poll response alone must not destroy an undelivered notification");

  const ack = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/reminders/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint, acknowledgeIds: [body[0].notificationId], ackOnly: true }),
    }),
    env,
  );
  assert.equal(ack.status, 204);
  assert.equal(db.pending.length, 0);
});

test("reminder mutations require the registered subscription capability", async () => {
  const db = new MockD1();
  const env = await makeEnv(db);
  const endpoint = "https://push.example/capability";
  const subscriptionId = await sha256Hex(endpoint);
  db.devices.set("dev-cap", {
    device_id: "dev-cap",
    platform: "ios",
    endpoint,
    endpoint_hash: subscriptionId,
    subscription_auth: "auth",
    subscription_p256dh: "p256dh",
    updated_at: Date.now(),
  });
  db.pending.push({
    id: 99,
    device_id: "dev-cap",
    task_id: "already-due",
    board_id: null,
    title: "Already due",
    due_iso: new Date().toISOString(),
    minutes: 5,
    created_at: Date.now(),
  });

  const withoutCapability = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/reminders", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "dev-cap", reminders: [] }),
    }),
    env,
  );
  assert.equal(withoutCapability.status, 404);

  const withCapability = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/reminders", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "dev-cap",
        subscriptionId,
        reminders: [{
          taskId: "task-cap",
          title: "Capability reminder",
          dueISO: new Date(Date.now() + 10 * 60_000).toISOString(),
          minutesBefore: [5],
        }],
      }),
    }),
    env,
  );
  assert.equal(withCapability.status, 204);
  assert.equal(db.reminders.length, 1);
  assert.equal(db.pending.length, 1, "schedule sync must not clear already-fired notifications");

  const badDelete = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/devices/dev-cap", { method: "DELETE" }),
    env,
  );
  assert.equal(badDelete.status, 404);
  assert.equal(db.devices.has("dev-cap"), true);

  const goodDelete = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/devices/dev-cap", {
      method: "DELETE",
      headers: { "X-Taskify-Subscription": subscriptionId },
    }),
    env,
  );
  assert.equal(goodDelete.status, 204);
  assert.equal(db.devices.has("dev-cap"), false);
});

test("device registration cannot rebind an existing device without its prior capability", async () => {
  const db = new MockD1();
  const env = await makeEnv(db);
  const oldEndpoint = "https://push.example/original";
  const oldSubscriptionId = await sha256Hex(oldEndpoint);
  db.devices.set("dev-rebind", {
    device_id: "dev-rebind",
    platform: "ios",
    endpoint: oldEndpoint,
    endpoint_hash: oldSubscriptionId,
    subscription_auth: "old-auth",
    subscription_p256dh: "old-p256dh",
    updated_at: Date.now(),
  });

  const registrationBody = {
    deviceId: "dev-rebind",
    platform: "ios",
    subscription: {
      endpoint: "https://push.example/replacement",
      keys: { auth: "new-auth", p256dh: "new-p256dh" },
    },
  };
  const denied = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/devices", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(registrationBody),
    }),
    env,
  );
  assert.equal(denied.status, 404);
  assert.equal(db.devices.get("dev-rebind")?.endpoint, oldEndpoint);

  const allowed = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/devices", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...registrationBody, subscriptionId: oldSubscriptionId }),
    }),
    env,
  );
  assert.equal(allowed.status, 200);
  assert.equal(db.devices.get("dev-rebind")?.endpoint, registrationBody.subscription.endpoint);
});

test("scheduled due reminders send push ping with VAPID headers and enqueue pending", async () => {
  const db = new MockD1();
  const env = await makeEnv(db);

  const endpoint = "https://push.example/send";
  const endpointHash = await sha256Hex(endpoint);
  db.devices.set("dev-1", {
    device_id: "dev-1",
    platform: "ios",
    endpoint,
    endpoint_hash: endpointHash,
    subscription_auth: "auth",
    subscription_p256dh: "p256dh",
    updated_at: Date.now(),
  });
  db.reminders.push({
    device_id: "dev-1",
    reminder_key: "task-1:15",
    task_id: "task-1",
    board_id: "board-1",
    title: "Task A",
    due_iso: new Date(Date.now() + 60_000).toISOString(),
    minutes: 15,
    send_at: Date.now() - 1_000,
  });

  const originalFetch = globalThis.fetch;
  const pushCalls: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    pushCalls.push({ url: String(url), headers });
    return new Response("", { status: 201 });
  }) as any;

  try {
    await worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" } as any, env, undefined as any);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(pushCalls.length, 1);
  const call = pushCalls[0];
  assert.equal(call.url, endpoint);
  assert.match(call.headers.get("Authorization") || "", /^WebPush\s+/);
  assert.ok((call.headers.get("Crypto-Key") || "").includes("p256ecdsa="));
  assert.ok(Number(call.headers.get("TTL") || 0) >= 300);
  assert.equal(db.pending.length, 1);
  assert.equal(db.reminders.length, 0);
});

test("scheduled handles 410 by removing expired device", async () => {
  const db = new MockD1();
  const env = await makeEnv(db);

  const endpoint = "https://push.example/expired";
  const endpointHash = await sha256Hex(endpoint);
  db.devices.set("dev-expired", {
    device_id: "dev-expired",
    platform: "android",
    endpoint,
    endpoint_hash: endpointHash,
    subscription_auth: "auth",
    subscription_p256dh: "p256dh",
    updated_at: Date.now(),
  });
  db.reminders.push({
    device_id: "dev-expired",
    reminder_key: "task-z:5",
    task_id: "task-z",
    board_id: null,
    title: "Task Z",
    due_iso: new Date(Date.now() + 30_000).toISOString(),
    minutes: 5,
    send_at: Date.now() - 1_000,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("gone", { status: 410 })) as any;

  try {
    await worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" } as any, env, undefined as any);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(db.devices.has("dev-expired"), false, "expired device should be deleted");
  assert.equal(db.reminders.length, 0, "due reminder row should be consumed");
});

test("scheduled batches multiple devices and sends one push per device", async () => {
  const db = new MockD1();
  const env = await makeEnv(db);

  const endpointA = "https://push.example/a";
  const endpointB = "https://push.example/b";
  db.devices.set("dev-a", {
    device_id: "dev-a",
    platform: "ios",
    endpoint: endpointA,
    endpoint_hash: await sha256Hex(endpointA),
    subscription_auth: "auth-a",
    subscription_p256dh: "p256dh-a",
    updated_at: Date.now(),
  });
  db.devices.set("dev-b", {
    device_id: "dev-b",
    platform: "android",
    endpoint: endpointB,
    endpoint_hash: await sha256Hex(endpointB),
    subscription_auth: "auth-b",
    subscription_p256dh: "p256dh-b",
    updated_at: Date.now(),
  });

  const now = Date.now();
  db.reminders.push(
    {
      device_id: "dev-a",
      reminder_key: "a1:15",
      task_id: "a1",
      board_id: "board-a",
      title: "A1",
      due_iso: new Date(now + 120_000).toISOString(),
      minutes: 15,
      send_at: now - 1_000,
    },
    {
      device_id: "dev-a",
      reminder_key: "a2:5",
      task_id: "a2",
      board_id: "board-a",
      title: "A2",
      due_iso: new Date(now + 180_000).toISOString(),
      minutes: 5,
      send_at: now - 500,
    },
    {
      device_id: "dev-b",
      reminder_key: "b1:10",
      task_id: "b1",
      board_id: "board-b",
      title: "B1",
      due_iso: new Date(now + 90_000).toISOString(),
      minutes: 10,
      send_at: now - 700,
    },
  );

  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return new Response("", { status: 201 });
  }) as any;

  try {
    await worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" } as any, env, undefined as any);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(urls.length, 2, "one push ping per device");
  assert.ok(urls.includes(endpointA));
  assert.ok(urls.includes(endpointB));

  const pendingA = db.pending.filter((p) => p.device_id === "dev-a");
  const pendingB = db.pending.filter((p) => p.device_id === "dev-b");
  assert.equal(pendingA.length, 2, "all dev-a due reminders should be pending");
  assert.equal(pendingB.length, 1, "all dev-b due reminders should be pending");
  assert.equal(db.reminders.length, 0, "all processed due reminders should be removed");
});

test("scheduled processing does not delete a reminder when pending insertion fails", async () => {
  class FailingPendingD1 extends MockD1 {
    override async batch(statements: any[]) {
      if (statements.some((statement) => /^INSERT INTO pending_notifications /i.test(statement._sql ?? ""))) {
        throw new Error("simulated pending insert failure");
      }
      return super.batch(statements);
    }
  }

  const db = new FailingPendingD1();
  const env = await makeEnv(db);
  const endpoint = "https://push.example/durable";
  db.devices.set("dev-durable", {
    device_id: "dev-durable",
    platform: "ios",
    endpoint,
    endpoint_hash: await sha256Hex(endpoint),
    subscription_auth: "auth",
    subscription_p256dh: "p256dh",
    updated_at: Date.now(),
  });
  db.reminders.push({
    device_id: "dev-durable",
    reminder_key: "task-durable:5",
    task_id: "task-durable",
    board_id: "board-durable",
    title: "Durable reminder",
    due_iso: new Date(Date.now() + 60_000).toISOString(),
    minutes: 5,
    send_at: Date.now() - 1_000,
  });

  await assert.rejects(
    () => worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" } as any, env, undefined as any),
    /simulated pending insert failure/,
  );
  assert.equal(db.pending.length, 0);
  assert.equal(db.reminders.length, 1, "source reminder must remain retryable");
});

// ─────────────────────────────────────────────────────────────────────────────
// Voice dictation endpoint tests
// These tests are EXPECTED TO FAIL until the implementation is added.
// ─────────────────────────────────────────────────────────────────────────────

// Extend MockD1 to support voice_quota table.
// We patch MockD1's prepare() to handle voice_quota queries inline by
// checking for the table name in the SQL string.
//
// Rather than modifying MockD1 above (shared with existing tests), we create
// a subclass used only for voice tests.
class MockD1WithVoice extends MockD1 {
  // key: `${npub}:${date}`
  quota = new Map<string, { session_count: number; total_seconds: number }>();

  override prepare(query: string) {
    const base = super.prepare(query);
    const sql = query.replace(/\s+/g, " ").trim();
    const db = this;

    // For voice_quota queries, intercept first() and run()
    if (!sql.toLowerCase().includes("voice_quota")) {
      return base;
    }

    let params: unknown[] = [];

    return {
      _sql: sql,
      bind(...values: unknown[]) {
        params = values;
        return this;
      },
      async run() {
        // CREATE TABLE
        if (/^CREATE TABLE/i.test(sql)) return { success: true };

        // INSERT ... ON CONFLICT DO UPDATE (upsert quota)
        if (/^INSERT INTO voice_quota/i.test(sql)) {
          const [npub, date, , addSeconds] = params as [string, string, number, number];
          const key = `${npub}:${date}`;
          const existing = db.quota.get(key) ?? { session_count: 0, total_seconds: 0 };
          db.quota.set(key, {
            session_count: existing.session_count + 1,
            total_seconds: existing.total_seconds + (addSeconds as number),
          });
          return { success: true };
        }

        return { success: true };
      },
      async first() {
        // SELECT * FROM voice_quota WHERE npub=? AND date=?
        if (/SELECT .* FROM voice_quota/i.test(sql)) {
          const [npub, date] = params as [string, string];
          const row = db.quota.get(`${npub}:${date}`);
          if (!row) return null;
          return { npub, date, ...row } as any;
        }
        return null;
      },
      async all() {
        return { success: true, results: [] };
      },
    };
  }
}

async function makeVoiceEnv(db: MockD1WithVoice, geminiApiKey = "fake-gemini-key") {
  const base = await makeEnv(db);
  return { ...base, GEMINI_API_KEY: geminiApiKey } as any;
}

// ── Test 1: POST /api/voice/extract — returns 501 when GEMINI_API_KEY missing ─
test("POST /api/voice/extract returns 501 when GEMINI_API_KEY not configured", async () => {
  const db = new MockD1WithVoice();
  const env = await makeEnv(db); // no GEMINI_API_KEY

  const req = new Request("https://taskify-v2.solife.me/api/voice/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ npub: "npub1abc", transcript: "call dentist tomorrow", sessionDurationSeconds: 5 }),
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 501, "should be 501 when GEMINI_API_KEY absent");
  const body = await res.json() as any;
  assert.ok(body.error, "should have error field");
});

// ── Test 2: POST /api/voice/extract — 400 on missing npub ─────────────────────
test("POST /api/voice/extract returns 400 when npub is missing", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const req = new Request("https://taskify-v2.solife.me/api/voice/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: "call dentist tomorrow", sessionDurationSeconds: 5 }),
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 400);
  const body = await res.json() as any;
  assert.ok(body.error);
});

// ── Test 3: POST /api/voice/extract — 400 on empty transcript ─────────────────
test("POST /api/voice/extract returns 400 when transcript is empty", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const req = new Request("https://taskify-v2.solife.me/api/voice/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ npub: "npub1abc", transcript: "   ", sessionDurationSeconds: 0 }),
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 400);
  const body = await res.json() as any;
  assert.ok(body.error);
});

// ── Test 4: POST /api/voice/extract — happy path: calls Gemini, returns operations ─
test("POST /api/voice/extract calls Gemini and returns operations on success", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const geminiOperations = [
    { type: "create_task", title: "Call dentist", dueText: "tomorrow" },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: JSON.stringify({ operations: geminiOperations }) }] } },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 200 });
  }) as any;

  try {
    const req = new Request("https://taskify-v2.solife.me/api/voice/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        npub: "npub1abc",
        transcript: "call dentist tomorrow",
        candidates: [],
        sessionDurationSeconds: 10,
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.operations), "should have operations array");
    assert.equal(body.operations.length, 1);
    assert.equal(body.operations[0].type, "create_task");
    assert.equal(body.operations[0].title, "Call dentist");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Test 5: POST /api/voice/extract — quota is incremented after successful call ─
test("POST /api/voice/extract increments quota after successful Gemini call", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);
  const npub = "npub1quotatest";
  const date = new Date().toISOString().slice(0, 10);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ operations: [] }) }] } }],
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 200 });
  }) as any;

  try {
    const req = new Request("https://taskify-v2.solife.me/api/voice/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ npub, transcript: "hello world", candidates: [], sessionDurationSeconds: 15 }),
    });
    await worker.fetch(req, env);
    const row = db.quota.get(`${npub}:${date}`);
    assert.ok(row, "quota row should exist");
    assert.equal(row!.session_count, 1);
    assert.equal(row!.total_seconds, 15);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Test 6: POST /api/voice/extract — returns 429 when quota exceeded ─
test("POST /api/voice/extract returns 429 when quota exceeded", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);
  const npub = "npub1overquota";
  const date = new Date().toISOString().slice(0, 10);

  // Pre-seed quota at limit
  db.quota.set(`${npub}:${date}`, { session_count: 5, total_seconds: 300 });

  const req = new Request("https://taskify-v2.solife.me/api/voice/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ npub, transcript: "call dentist and pick up groceries", sessionDurationSeconds: 10 }),
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 429);
  const body = await res.json() as any;
  assert.equal(body.error, "quota_exceeded");
  assert.ok(typeof body.message === "string");
});

// ── Test 7: POST /api/voice/extract — Gemini failure returns 503 ─
test("POST /api/voice/extract returns 503 when Gemini fails", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("error", { status: 503 })) as any;

  try {
    const req = new Request("https://taskify-v2.solife.me/api/voice/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        npub: "npub1abc",
        transcript: "call dentist, pick up groceries",
        candidates: [],
        sessionDurationSeconds: 8,
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 503, "should return 503 when Gemini is unavailable");
    const body = await res.json() as any;
    assert.equal(body.error, "gemini_unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/voice/extract falls back to Cloudflare Workers AI when Gemini fails", async () => {
  const db = new MockD1WithVoice();
  const env = {
    ...(await makeVoiceEnv(db)),
    CLOUDFLARE_ACCOUNT_ID: "acc-123",
    CLOUDFLARE_API_TOKEN: "cf-token",
  } as any;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("generativelanguage.googleapis.com")) {
      return new Response("gemini down", { status: 503 });
    }
    if (u.includes("/ai/run/@cf/zai-org/glm-4.7-flash")) {
      return new Response(
        JSON.stringify({
          result: {
            response: JSON.stringify({
              tasks: [{ title: "Call dentist", dueText: "tomorrow", subtasks: [] }],
            }),
          },
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 404 });
  }) as any;

  try {
    const req = new Request("https://taskify-v2.solife.me/api/voice/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        npub: "npub1abc",
        transcript: "call dentist tomorrow",
        candidates: [],
        sessionDurationSeconds: 8,
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.operations));
    assert.equal(body.operations[0].title, "Call dentist");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/voice/extract applies correction phrases to prior task dueText", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      tasks: [
                        { title: "Play date", dueText: "tomorrow at noon", subtasks: [] },
                        { title: "then next Sunday at 2 PM we have a dinner after church", dueText: "next Sunday at 2 PM", subtasks: [] },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 200 });
  }) as any;

  try {
    const req = new Request("https://taskify-v2.solife.me/api/voice/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        npub: "npub1abc",
        transcript: "I am going to the park tomorrow at noon for a play date. Actually change the noon play date to 1 PM. then next Sunday at 2 PM we have a dinner after church",
        candidates: [],
        sessionDurationSeconds: 20,
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.operations));
    assert.equal(body.operations[0].title, "Play date");
    assert.equal(body.operations[0].dueText, "tomorrow at 1 pm");
    assert.equal(body.operations[1].title, "Dinner after church");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/voice/extract preserves explicit reminder requests", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      tasks: [
                        {
                          title: "Remind me to call dentist",
                          dueText: "tomorrow at 2 PM",
                          reminderText: "at due time",
                          subtasks: [],
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 200 });
  }) as any;

  try {
    const req = new Request("https://taskify-v2.solife.me/api/voice/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        npub: "npub1abc",
        transcript: "remind me to call dentist tomorrow at 2 PM",
        candidates: [],
        sessionDurationSeconds: 10,
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.operations[0].title, "call dentist");
    assert.equal(body.operations[0].dueText, "tomorrow at 2 PM");
    assert.equal(body.operations[0].reminderText, "at due time");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Test 8: POST /api/voice/finalize — 501 when GEMINI_API_KEY missing ──────────
test("POST /api/voice/finalize returns 501 when GEMINI_API_KEY not configured", async () => {
  const db = new MockD1WithVoice();
  const env = await makeEnv(db); // no key

  const req = new Request("https://taskify-v2.solife.me/api/voice/finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      npub: "npub1abc",
      candidates: [{ id: "1", title: "Call dentist", dueText: "tomorrow", status: "confirmed" }],
      referenceDate: new Date().toISOString(),
    }),
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 501);
});

// ── Test 9: POST /api/voice/finalize — 400 when no confirmed candidates ─────────
test("POST /api/voice/finalize returns 400 when candidates array has no confirmed tasks", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const req = new Request("https://taskify-v2.solife.me/api/voice/finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      npub: "npub1abc",
      candidates: [
        { id: "1", title: "Call dentist", status: "dismissed" },
        { id: "2", title: "Groceries", status: "draft" },
      ],
      referenceDate: new Date().toISOString(),
    }),
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 400);
  const body = await res.json() as any;
  assert.ok(body.error);
});

// ── Test 10: POST /api/voice/finalize — happy path: returns normalized tasks ────
test("POST /api/voice/finalize returns normalized FinalTask array from confirmed candidates", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const referenceDate = "2026-03-24T18:00:00.000Z";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      // Simulate Gemini normalizing the task
      return new Response(
        JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  tasks: [
                    {
                      id: "c1",
                      title: "Call Dentist",
                      dueISO: "2026-03-25T14:00:00.000Z",
                      subtasks: [],
                      notes: null,
                      boardId: null,
                      priority: null,
                    },
                  ],
                }),
              }],
            },
          }],
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 200 });
  }) as any;

  try {
    const req = new Request("https://taskify-v2.solife.me/api/voice/finalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        npub: "npub1abc",
        candidates: [
          { id: "c1", title: "call dentist", dueText: "tomorrow 2pm", status: "confirmed" },
          { id: "c2", title: "pick up groceries", status: "dismissed" }, // should be excluded
        ],
        boardId: "board-xyz",
        referenceDate,
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.tasks), "should have tasks array");
    assert.equal(body.tasks.length, 1, "only confirmed candidates returned");
    assert.equal(body.tasks[0].title, "Call Dentist");
    assert.equal(body.tasks[0].dueISO, "2026-03-25T14:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/voice/finalize only returns reminders for explicit reminder requests", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  tasks: [
                    {
                      id: "c1",
                      title: "Call Dentist",
                      dueISO: "2026-03-25T14:00:00.000Z",
                      subtasks: [],
                      notes: null,
                      boardId: null,
                      priority: null,
                      reminderMinutesBeforeDue: [15],
                      reminderTime: null,
                    },
                    {
                      id: "c2",
                      title: "Pay Water Bill",
                      dueISO: "2026-03-26T17:00:00.000Z",
                      subtasks: [],
                      notes: null,
                      boardId: null,
                      priority: null,
                      reminderMinutesBeforeDue: [60],
                      reminderTime: null,
                    },
                  ],
                }),
              }],
            },
          }],
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 200 });
  }) as any;

  try {
    const req = new Request("https://taskify-v2.solife.me/api/voice/finalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        npub: "npub1abc",
        candidates: [
          { id: "c1", title: "call dentist", dueText: "tomorrow 2pm", reminderText: "15 minutes before", status: "confirmed" },
          { id: "c2", title: "pay water bill", dueText: "Thursday at 5pm", status: "confirmed" },
        ],
        referenceDate: "2026-03-24T18:00:00.000Z",
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.deepEqual(body.tasks[0].reminderMinutesBeforeDue, [15]);
    assert.equal(body.tasks[1].reminderMinutesBeforeDue, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Test 11: POST /api/voice/finalize — Gemini failure returns 503 ─
test("POST /api/voice/finalize falls back to Cloudflare Workers AI when Gemini fails", async () => {
  const db = new MockD1WithVoice();
  const env = {
    ...(await makeVoiceEnv(db)),
    CLOUDFLARE_ACCOUNT_ID: "acc-123",
    CLOUDFLARE_API_TOKEN: "cf-token",
  } as any;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("generativelanguage.googleapis.com")) {
      return new Response("error", { status: 503 });
    }
    if (u.includes("/ai/run/@cf/zai-org/glm-4.7-flash")) {
      return new Response(
        JSON.stringify({
          result: {
            response: JSON.stringify({
              tasks: [
                {
                  id: "c1",
                  title: "Call Dentist",
                  dueISO: "2026-03-25T14:00:00.000Z",
                  subtasks: [],
                  notes: null,
                  boardId: null,
                  priority: null,
                },
              ],
            }),
          },
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 404 });
  }) as any;

  try {
    const req = new Request("https://taskify-v2.solife.me/api/voice/finalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        npub: "npub1abc",
        candidates: [{ id: "c1", title: "call dentist", dueText: "tomorrow", status: "confirmed" }],
        referenceDate: new Date().toISOString(),
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.tasks));
    assert.equal(body.tasks[0].title, "Call Dentist");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/voice/finalize returns 503 when Gemini fails", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("error", { status: 503 })) as any;

  try {
    const req = new Request("https://taskify-v2.solife.me/api/voice/finalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        npub: "npub1abc",
        candidates: [
          { id: "c1", title: "call dentist", dueText: "tomorrow", status: "confirmed" },
        ],
        referenceDate: new Date().toISOString(),
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 503, "must return 503 when Gemini is unavailable");
    const body = await res.json() as any;
    assert.equal(body.error, "gemini_unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/voice/finalize returns 503 (no local due parsing fallback) when Gemini fails", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("error", { status: 503 })) as any;

  try {
    const req = new Request("https://taskify-v2.solife.me/api/voice/finalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        npub: "npub1abc",
        candidates: [
          { id: "c1", title: "Ashley's birthday party", dueText: "tomorrow at 2 PM", status: "confirmed" },
          { id: "c2", title: "Go for a walk", dueText: "Friday at noon", status: "confirmed" },
        ],
        referenceDate: "2026-03-24T18:00:00.000Z",
        referenceOffsetMinutes: 300,
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 503);
    const body = await res.json() as any;
    assert.equal(body.error, "gemini_unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// =============================================================================
// GCal Integration Tests
// =============================================================================

// ── Helpers ──────────────────────────────────────────────────────────────────

function gcalBytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function gcalHexToBytes(h: string): Uint8Array {
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// Minimal bech32 encode (standard bech32, used only to generate test npub strings)
const B32_CHARSET_TEST = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const B32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function b32Polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= B32_GEN[i];
  }
  return chk;
}
function b32HrpExpand(hrp: string): number[] {
  const r: number[] = [];
  for (const c of hrp) r.push(c.charCodeAt(0) >> 5);
  r.push(0);
  for (const c of hrp) r.push(c.charCodeAt(0) & 31);
  return r;
}
function convertTo5Bits(data: Uint8Array): number[] {
  let acc = 0, bits = 0;
  const out: number[] = [];
  for (const b of data) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}
function npubEncode(pubkeyHex: string): string {
  const words = convertTo5Bits(gcalHexToBytes(pubkeyHex));
  const hrp = "npub";
  const polymod = b32Polymod([...b32HrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (polymod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => B32_CHARSET_TEST[w]).join("")}`;
}

// Produce NIP-01 auth headers for a gcal request
function makeGcalAuthHeaders(privKey: Uint8Array, pubkeyHex: string, body = ""): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  const msgHash = sha256(new TextEncoder().encode(`${ts}.${body}`));
  const sig = schnorr.sign(msgHash, privKey);
  return {
    "X-Taskify-Npub": pubkeyHex,
    "X-Taskify-Timestamp": String(ts),
    "X-Taskify-Sig": gcalBytesToHex(sig),
  };
}

// Gcal-aware MockD1 subclass
type GcalCalRow = {
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

class MockD1WithGcal extends MockD1 {
  gcalCalendars = new Map<string, GcalCalRow>();
  lastEventsQuery: string | null = null;

  override prepare(query: string) {
    const sql = query.replace(/\s+/g, " ").trim();
    const db = this;

    if (/FROM gcal_events e/i.test(sql)) {
      db.lastEventsQuery = sql;
    }

    if (!sql.toLowerCase().includes("gcal_calendars")) {
      return super.prepare(query);
    }

    let params: unknown[] = [];
    return {
      _sql: sql,
      bind(...values: unknown[]) {
        params = values;
        return this;
      },
      async run() {
        if (/^CREATE TABLE/i.test(sql) || /^CREATE INDEX/i.test(sql)) return { success: true };
        // UPDATE gcal_calendars SET selected = ?, updated_at = ? WHERE id = ? AND npub = ?
        if (/UPDATE gcal_calendars SET selected/i.test(sql)) {
          const [selected, , calId, npub] = params as [number, number, string, string];
          const row = db.gcalCalendars.get(calId as string);
          if (row && row.npub === npub) row.selected = selected as number;
          return { success: true };
        }
        return { success: true };
      },
      async first() {
        if (sql.includes("WHERE watch_channel_id = ?")) {
          const [channelId] = params as [string];
          const row = [...db.gcalCalendars.values()].find((c) => c.watch_channel_id === channelId);
          return row ?? null;
        }
        return null;
      },
      async all() {
        return { success: true, results: [] };
      },
    };
  }
}

type GcalOauthStateRow = {
  state_hash: string;
  npub: string;
  browser_nonce_hash: string;
  redirect_uri: string;
  expires_at: number;
  created_at: number;
};

class MockD1WithGcalOauth extends MockD1 {
  oauthStates = new Map<string, GcalOauthStateRow>();

  override prepare(query: string) {
    const sql = query.replace(/\s+/g, " ").trim();
    const db = this;
    if (!sql.toLowerCase().includes("gcal_oauth_states")) {
      return super.prepare(query);
    }

    let params: unknown[] = [];
    return {
      _sql: sql,
      bind(...values: unknown[]) {
        params = values;
        return this;
      },
      async run() {
        if (/^CREATE TABLE/i.test(sql) || /^CREATE INDEX/i.test(sql)) return { success: true };
        if (/^DELETE FROM gcal_oauth_states WHERE expires_at/i.test(sql)) {
          const [nowSec] = params as [number];
          for (const [key, row] of db.oauthStates) {
            if (row.expires_at < nowSec) db.oauthStates.delete(key);
          }
          return { success: true };
        }
        if (/^INSERT INTO gcal_oauth_states/i.test(sql)) {
          const [state_hash, npub, browser_nonce_hash, redirect_uri, expires_at, created_at] = params as [
            string,
            string,
            string,
            string,
            number,
            number,
          ];
          db.oauthStates.set(state_hash, {
            state_hash,
            npub,
            browser_nonce_hash,
            redirect_uri,
            expires_at,
            created_at,
          });
          return { success: true };
        }
        return { success: true };
      },
      async first() {
        if (/^DELETE FROM gcal_oauth_states/i.test(sql) && /RETURNING npub, redirect_uri/i.test(sql)) {
          const [stateHash, browserNonceHash, nowSec] = params as [string, string, number];
          const row = db.oauthStates.get(stateHash);
          if (!row || row.browser_nonce_hash !== browserNonceHash || row.expires_at < nowSec) return null;
          db.oauthStates.delete(stateHash);
          return { npub: row.npub, redirect_uri: row.redirect_uri };
        }
        return null;
      },
      async all() {
        return { success: true, results: [] };
      },
    };
  }
}

const TEST_GCAL_ENC_KEY = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const TEST_WEBHOOK_SECRET = "gcal-webhook-test-secret";

async function makeGcalEnv(db: MockD1 = new MockD1()) {
  const base = await makeEnv(db);
  return {
    ...base,
    GCAL_CLIENT_ID: "test-client-id",
    GCAL_CLIENT_SECRET: "test-client-secret",
    GCAL_TOKEN_ENC_KEY: TEST_GCAL_ENC_KEY,
    GCAL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  } as any;
}

const mockCtx = { waitUntil: (_p: Promise<unknown>) => void _p } as any;

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0];
}

// ── A. AES-256-GCM encryption round-trip ─────────────────────────────────────

test("gcal crypto: encrypt then decrypt returns original plaintext", async () => {
  const plaintext = "access_token_abc123";
  const { enc, iv, tag } = await gcalEncryptToken(plaintext, TEST_GCAL_ENC_KEY);
  const decrypted = await gcalDecryptToken(enc, iv, tag, TEST_GCAL_ENC_KEY);
  assert.equal(decrypted, plaintext);
});

test("gcal crypto: different IVs produced on each encrypt call", async () => {
  const { iv: iv1 } = await gcalEncryptToken("token", TEST_GCAL_ENC_KEY);
  const { iv: iv2 } = await gcalEncryptToken("token", TEST_GCAL_ENC_KEY);
  assert.notEqual(iv1, iv2, "IVs must be non-deterministic");
});

test("gcal crypto: wrong key fails to decrypt", async () => {
  const { enc, iv, tag } = await gcalEncryptToken("secret", TEST_GCAL_ENC_KEY);
  const wrongKey = "deadbeef".repeat(8); // 64 hex chars
  await assert.rejects(
    () => gcalDecryptToken(enc, iv, tag, wrongKey),
    "decryption with wrong key must throw",
  );
});

test("gcal OAuth state is opaque, signed-user-bound, and browser-cookie-bound", async () => {
  const db = new MockD1WithGcalOauth();
  const env = await makeGcalEnv(db);
  const privateKey = schnorr.utils.randomSecretKey();
  const pubkey = gcalBytesToHex(schnorr.getPublicKey(privateKey));
  const authResponse = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/gcal/auth/url", {
      headers: makeGcalAuthHeaders(privateKey, pubkey),
    }),
    env,
  );

  assert.equal(authResponse.status, 200);
  const setCookie = authResponse.headers.get("Set-Cookie") ?? "";
  assert.match(setCookie, /^__Host-taskify_gcal_oauth=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  const { url: authorizationUrl } = await authResponse.json() as { url: string };
  const oauthUrl = new URL(authorizationUrl);
  const state = oauthUrl.searchParams.get("state") ?? "";
  assert.ok(state.length >= 40);
  assert.equal(state.includes(pubkey), false, "state must not expose the user's public key");
  assert.equal(oauthUrl.searchParams.get("redirect_uri"), "https://taskify-v2.solife.me/api/gcal/auth/callback");
  assert.equal(db.oauthStates.size, 1);
  assert.equal([...db.oauthStates.values()][0].npub, pubkey);

  const wrongBrowser = await worker.fetch(
    new Request(`https://taskify-v2.solife.me/api/gcal/auth/callback?code=test-code&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: "__Host-taskify_gcal_oauth=wrong-browser" },
    }),
    env,
  );
  assert.equal(wrongBrowser.status, 400);
  assert.equal(db.oauthStates.size, 1, "a wrong browser must not consume another browser's state");

  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "https://oauth2.googleapis.com/token") {
      tokenCalls += 1;
      // Deliberately incomplete: state consumption happens before exchange.
      return Response.json({ access_token: "access-only" });
    }
    throw new Error(`Unexpected OAuth fetch: ${String(input)}`);
  }) as any;
  try {
    const callbackUrl = `https://taskify-v2.solife.me/api/gcal/auth/callback?code=test-code&state=${encodeURIComponent(state)}`;
    const callbackHeaders = { Cookie: cookiePair(setCookie) };
    const firstCallback = await worker.fetch(new Request(callbackUrl, { headers: callbackHeaders }), env);
    assert.equal(firstCallback.status, 502);
    assert.equal(db.oauthStates.size, 0, "valid state must be consumed atomically");

    const replay = await worker.fetch(new Request(callbackUrl, { headers: callbackHeaders }), env);
    assert.equal(replay.status, 400);
    assert.equal(tokenCalls, 1, "a replay must be rejected before token exchange");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── B. verifyGcalAuth ─────────────────────────────────────────────────────────

test("verifyGcalAuth: missing X-Taskify-Npub returns null", async () => {
  const ts = Math.floor(Date.now() / 1000);
  const req = new Request("https://example.com/api/gcal/status", {
    method: "GET",
    headers: { "X-Taskify-Timestamp": String(ts), "X-Taskify-Sig": "a".repeat(128) },
  });
  assert.equal(await verifyGcalAuth(req), null);
});

test("verifyGcalAuth: missing X-Taskify-Timestamp returns null", async () => {
  const req = new Request("https://example.com/api/gcal/status", {
    method: "GET",
    headers: { "X-Taskify-Npub": "a".repeat(64), "X-Taskify-Sig": "a".repeat(128) },
  });
  assert.equal(await verifyGcalAuth(req), null);
});

test("verifyGcalAuth: missing X-Taskify-Sig returns null", async () => {
  const ts = Math.floor(Date.now() / 1000);
  const req = new Request("https://example.com/api/gcal/status", {
    method: "GET",
    headers: { "X-Taskify-Npub": "a".repeat(64), "X-Taskify-Timestamp": String(ts) },
  });
  assert.equal(await verifyGcalAuth(req), null);
});

test("verifyGcalAuth: timestamp older than 300s returns null", async () => {
  const privKey = schnorr.utils.randomSecretKey();
  const pubKeyHex = gcalBytesToHex(schnorr.getPublicKey(privKey));
  const staleTs = Math.floor(Date.now() / 1000) - 301;
  const msgHash = sha256(new TextEncoder().encode(`${staleTs}.`));
  const sig = schnorr.sign(msgHash, privKey);
  const req = new Request("https://example.com/api/gcal/status", {
    method: "GET",
    headers: {
      "X-Taskify-Npub": pubKeyHex,
      "X-Taskify-Timestamp": String(staleTs),
      "X-Taskify-Sig": gcalBytesToHex(sig),
    },
  });
  assert.equal(await verifyGcalAuth(req), null);
});

test("verifyGcalAuth: timestamp in future beyond 300s returns null", async () => {
  const privKey = schnorr.utils.randomSecretKey();
  const pubKeyHex = gcalBytesToHex(schnorr.getPublicKey(privKey));
  const futureTs = Math.floor(Date.now() / 1000) + 301;
  const msgHash = sha256(new TextEncoder().encode(`${futureTs}.`));
  const sig = schnorr.sign(msgHash, privKey);
  const req = new Request("https://example.com/api/gcal/status", {
    method: "GET",
    headers: {
      "X-Taskify-Npub": pubKeyHex,
      "X-Taskify-Timestamp": String(futureTs),
      "X-Taskify-Sig": gcalBytesToHex(sig),
    },
  });
  assert.equal(await verifyGcalAuth(req), null);
});

test("verifyGcalAuth: invalid signature returns null", async () => {
  const privKey = schnorr.utils.randomSecretKey();
  const pubKeyHex = gcalBytesToHex(schnorr.getPublicKey(privKey));
  const ts = Math.floor(Date.now() / 1000);
  // Sign a *different* payload (wrong message)
  const wrongHash = sha256(new TextEncoder().encode("completely-wrong-payload"));
  const wrongSig = schnorr.sign(wrongHash, privKey);
  const req = new Request("https://example.com/api/gcal/status", {
    method: "GET",
    headers: {
      "X-Taskify-Npub": pubKeyHex,
      "X-Taskify-Timestamp": String(ts),
      "X-Taskify-Sig": gcalBytesToHex(wrongSig),
    },
  });
  assert.equal(await verifyGcalAuth(req), null);
});

test("verifyGcalAuth: valid hex pubkey + correct sig returns { npub: hexPubkey }", async () => {
  const privKey = schnorr.utils.randomSecretKey();
  const pubKeyHex = gcalBytesToHex(schnorr.getPublicKey(privKey));
  const ts = Math.floor(Date.now() / 1000);
  const body = '{"hello":"world"}';
  const msgHash = sha256(new TextEncoder().encode(`${ts}.${body}`));
  const sig = schnorr.sign(msgHash, privKey);
  const req = new Request("https://example.com/api/gcal/status", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Taskify-Npub": pubKeyHex,
      "X-Taskify-Timestamp": String(ts),
      "X-Taskify-Sig": gcalBytesToHex(sig),
    },
    body,
  });
  const result = await verifyGcalAuth(req);
  assert.ok(result, "should return a result");
  assert.equal(result.npub, pubKeyHex);
});

test("verifyGcalAuth: valid bech32 npub + correct sig on GET (empty body) returns { npub }", async () => {
  const privKey = schnorr.utils.randomSecretKey();
  const pubKeyHex = gcalBytesToHex(schnorr.getPublicKey(privKey));
  const npub = npubEncode(pubKeyHex);
  const ts = Math.floor(Date.now() / 1000);
  const msgHash = sha256(new TextEncoder().encode(`${ts}.`));
  const sig = schnorr.sign(msgHash, privKey);
  const req = new Request("https://example.com/api/gcal/status", {
    method: "GET",
    headers: {
      "X-Taskify-Npub": npub,
      "X-Taskify-Timestamp": String(ts),
      "X-Taskify-Sig": gcalBytesToHex(sig),
    },
  });
  const result = await verifyGcalAuth(req);
  assert.ok(result, "bech32 npub should be accepted");
  assert.equal(result.npub, pubKeyHex, "should normalise to hex pubkey");
});

test("verifyGcalAuth: tampered body returns null", async () => {
  const privKey = schnorr.utils.randomSecretKey();
  const pubKeyHex = gcalBytesToHex(schnorr.getPublicKey(privKey));
  const ts = Math.floor(Date.now() / 1000);
  const originalBody = '{"key":"value"}';
  const tamperedBody = '{"key":"tampered"}';
  // Sign original body
  const msgHash = sha256(new TextEncoder().encode(`${ts}.${originalBody}`));
  const sig = schnorr.sign(msgHash, privKey);
  // But send tampered body
  const req = new Request("https://example.com/api/gcal/status", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Taskify-Npub": pubKeyHex,
      "X-Taskify-Timestamp": String(ts),
      "X-Taskify-Sig": gcalBytesToHex(sig),
    },
    body: tamperedBody,
  });
  assert.equal(await verifyGcalAuth(req), null);
});

test("Watch Nostr bridge only accepts bounded public wss relay URLs", () => {
  const relays = watchNostrBridgeTestHooks.normalizedRelayURLs([
    "wss://relay.example/",
    "wss://relay.example",
    "ws://insecure.example",
    "wss://localhost",
    "wss://127.0.0.1",
    ...Array.from({ length: 12 }, (_, index) => `wss://relay-${index}.example`),
  ]);

  assert.equal(relays[0], "wss://relay.example");
  assert.equal(relays.length, 8);
  assert.ok(relays.every((relay) => relay.startsWith("wss://")));
});

test("Watch Nostr bridge narrows query filters to Taskify task authors", () => {
  const author = "ab".repeat(32);
  assert.deepEqual(
    watchNostrBridgeTestHooks.normalizedFilter({
      kinds: [1, 30_301],
      authors: [author, author, "invalid"],
      limit: 50_000,
      since: 0,
    }),
    { kinds: [30_301], authors: [author], limit: 1_000 },
  );
});

test("POST /api/watch/nostr/query requires signed Taskify authentication", async () => {
  const env = await makeGcalEnv();
  const response = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/watch/nostr/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relays: ["wss://relay.example"], filter: {} }),
    }),
    env,
  );
  assert.equal(response.status, 401);
});

test("POST /api/watch/nostr/query rejects broad filters before opening relays", async () => {
  const privateKey = schnorr.utils.randomSecretKey();
  const publicKey = gcalBytesToHex(schnorr.getPublicKey(privateKey));
  const body = JSON.stringify({ relays: ["wss://relay.example"], filter: { kinds: [1] } });
  const env = await makeGcalEnv();
  const response = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/watch/nostr/query", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...makeGcalAuthHeaders(privateKey, publicKey, body) },
      body,
    }),
    env,
  );
  assert.equal(response.status, 400);
});

// ── C. Endpoint isolation: 401 without valid auth ────────────────────────────

test("GET /api/gcal/status with no auth headers returns 401", async () => {
  const env = await makeGcalEnv();
  const res = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/gcal/status", { method: "GET" }),
    env,
  );
  assert.equal(res.status, 401);
});

test("GET /api/gcal/calendars with no auth headers returns 401", async () => {
  const env = await makeGcalEnv();
  const res = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/gcal/calendars", { method: "GET" }),
    env,
  );
  assert.equal(res.status, 401);
});

test("GET /api/gcal/events with no auth headers returns 401", async () => {
  const env = await makeGcalEnv();
  const res = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/gcal/events", { method: "GET" }),
    env,
  );
  assert.equal(res.status, 401);
});

test("POST /api/gcal/sync with no auth headers returns 401", async () => {
  const env = await makeGcalEnv();
  const res = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/gcal/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test("PATCH /api/gcal/calendars/abc with no auth headers returns 401", async () => {
  const env = await makeGcalEnv();
  const res = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/gcal/calendars/abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: '{"selected":true}',
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test("DELETE /api/gcal/connection with no auth headers returns 401", async () => {
  const env = await makeGcalEnv();
  const res = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/gcal/connection", { method: "DELETE" }),
    env,
  );
  assert.equal(res.status, 401);
});

test("GET /api/gcal/events filters out calendars the user deselected", async () => {
  const db = new MockD1WithGcal();
  const env = await makeGcalEnv(db);
  const privateKey = schnorr.utils.randomSecretKey();
  const pubkey = gcalBytesToHex(schnorr.getPublicKey(privateKey));
  const res = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/gcal/events", {
      headers: makeGcalAuthHeaders(privateKey, pubkey),
    }),
    env,
  );

  assert.equal(res.status, 200);
  assert.match(db.lastEventsQuery ?? "", /AND c\.selected = 1/i);
});

// ── D. Webhook security ───────────────────────────────────────────────────────

test("POST /api/gcal/webhook/channel123 with wrong X-Goog-Channel-Token returns 403", async () => {
  const db = new MockD1WithGcal();
  const env = await makeGcalEnv(db);
  const res = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/gcal/webhook/channel123", {
      method: "POST",
      headers: { "X-Goog-Channel-Token": "wrong-secret" },
    }),
    env,
    mockCtx,
  );
  assert.equal(res.status, 403);
});

test("POST /api/gcal/webhook/channel123 with correct token but unknown channelId returns 404", async () => {
  const db = new MockD1WithGcal();
  const env = await makeGcalEnv(db);
  // No calendar with watch_channel_id = "channel123" in DB
  const res = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/gcal/webhook/channel123", {
      method: "POST",
      headers: { "X-Goog-Channel-Token": TEST_WEBHOOK_SECRET },
    }),
    env,
    mockCtx,
  );
  assert.equal(res.status, 404);
});

test("POST /api/gcal/webhook/channel123 with correct token and known channelId returns 200", async () => {
  const db = new MockD1WithGcal();
  db.gcalCalendars.set("cal-1", {
    id: "cal-1",
    npub: "aa".repeat(32),
    provider_cal_id: "primary",
    name: "Primary",
    primary_cal: 1,
    selected: 1,
    color: null,
    timezone: null,
    sync_token: null,
    watch_channel_id: "channel123",
    watch_expiry: null,
  });
  const env = await makeGcalEnv(db);
  const res = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/gcal/webhook/channel123", {
      method: "POST",
      headers: { "X-Goog-Channel-Token": TEST_WEBHOOK_SECRET },
    }),
    env,
    mockCtx,
  );
  assert.equal(res.status, 200);
});

// ── E. Calendar toggle isolation ─────────────────────────────────────────────

test("PATCH /api/gcal/calendars: user A cannot toggle user B's calendar", async () => {
  const db = new MockD1WithGcal();

  // User B's private/public key
  const privKeyB = schnorr.utils.randomSecretKey();
  const pubKeyB = gcalBytesToHex(schnorr.getPublicKey(privKeyB));

  // Seed user B's calendar (selected = 1)
  db.gcalCalendars.set("cal-b", {
    id: "cal-b",
    npub: pubKeyB,
    provider_cal_id: "b-primary",
    name: "B Primary",
    primary_cal: 1,
    selected: 1,
    color: null,
    timezone: null,
    sync_token: null,
    watch_channel_id: null,
    watch_expiry: null,
  });

  // User A's private/public key (different from B)
  const privKeyA = schnorr.utils.randomSecretKey();
  const pubKeyA = gcalBytesToHex(schnorr.getPublicKey(privKeyA));

  const patchBody = '{"selected":false}';
  const authHeaders = makeGcalAuthHeaders(privKeyA, pubKeyA, patchBody);

  const env = await makeGcalEnv(db);
  const res = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/gcal/calendars/cal-b", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: patchBody,
    }),
    env,
  );

  // Request succeeds (200) but no rows were matched because npub didn't match
  assert.equal(res.status, 200);

  // User B's calendar must still be selected = 1 — user A's update had no effect
  const calRow = db.gcalCalendars.get("cal-b");
  assert.equal(calRow?.selected, 1, "user B's calendar must remain unchanged");
});
