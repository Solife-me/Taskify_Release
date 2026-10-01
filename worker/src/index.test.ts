import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "./index.ts";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { assertPublicHttpUrl, UnsafePublicUrlError } from "./public-fetch.ts";
import { documentHead, isAmazonHost, isEtsyHost, isYouTubeHost } from "./preview.ts";

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function makeTaskifyAuthHeaders(
  privateKey: Uint8Array,
  publicKeyHex: string,
  body = "",
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const hash = sha256(new TextEncoder().encode(`${timestamp}.${body}`));
  const signature = schnorr.sign(hash, privateKey);
  return {
    "X-Taskify-Npub": publicKeyHex,
    "X-Taskify-Timestamp": String(timestamp),
    "X-Taskify-Sig": bytesToHex(signature),
  };
}

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
    VOICE_RATE_LIMITER: { limit: async () => ({ success: true }) },
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

test("public fetch validation blocks local and private network targets", () => {
  for (const target of [
    "http://localhost/admin",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://10.0.0.5/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "https://service.internal/",
  ]) {
    assert.throws(() => assertPublicHttpUrl(target), UnsafePublicUrlError, target);
  }
  assert.equal(assertPublicHttpUrl("https://example.com/path").href, "https://example.com/path");
});

test("preview and NIP-05 endpoints honor their rate-limit bindings", async () => {
  const env = await makeEnv(new MockD1());
  const denied = { limit: async () => ({ success: false }) };
  env.PREVIEW_RATE_LIMITER = denied;
  env.NIP05_RATE_LIMITER = denied;

  const preview = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/preview?url=https://example.com"),
    env,
  );
  const nip05 = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/nip05?address=user@example.com"),
    env,
  );
  assert.equal(preview.status, 429);
  assert.equal(nip05.status, 429);
  assert.equal(preview.headers.get("Retry-After"), "60");
});

test("NIP-05 rejects private-network and malformed domains before fetching", async () => {
  const env = await makeEnv(new MockD1());
  for (const address of ["alice@localhost", "alice@127.0.0.1", "alice@example.com/path"]) {
    const response = await worker.fetch(
      new Request(`https://taskify-v2.solife.me/api/nip05?address=${encodeURIComponent(address)}`),
      env,
    );
    assert.equal(response.status, 400, address);
  }
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
    "camera=(self), microphone=(self), geolocation=()",
  );
  const csp = res.headers.get("Content-Security-Policy") || "";
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  // The Worker's copy and the static _headers file must send the same policy.
  const headersFile = readFileSync(new URL("../../taskify-pwa/public/_headers", import.meta.url), "utf8");
  const fileCsp = headersFile.match(/^\s*Content-Security-Policy: (.+)$/m)?.[1];
  assert.equal(csp, fileCsp);
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

  const endpoint = "https://fcm.googleapis.com/fcm/send/dev-1";
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
  const endpoint = "https://fcm.googleapis.com/fcm/send/capability";
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
  const oldEndpoint = "https://fcm.googleapis.com/fcm/send/original";
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
      endpoint: "https://fcm.googleapis.com/fcm/send/replacement",
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

  const endpoint = "https://fcm.googleapis.com/fcm/send/send";
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

  const endpoint = "https://fcm.googleapis.com/fcm/send/expired";
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

  const endpointA = "https://fcm.googleapis.com/fcm/send/a";
  const endpointB = "https://fcm.googleapis.com/fcm/send/b";
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
  const endpoint = "https://fcm.googleapis.com/fcm/send/durable";
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
        if (/^INSERT INTO voice_quota/i.test(sql)) {
          const [npub, date, seconds, , limit, added] = params as [string, string, number, number, number, number];
          const key = `${npub}:${date}`;
          const old = db.quota.get(key);
          if (old && (old.session_count >= limit || old.total_seconds + added > 300)) return null;
          const row = { session_count: (old?.session_count ?? 0) + 1, total_seconds: (old?.total_seconds ?? 0) + seconds };
          db.quota.set(key, row);
          return row;
        }
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

async function makeVoiceEnv(db: MockD1WithVoice) {
  const base = await makeEnv(db);
  return { ...base, CLOUDFLARE_ACCOUNT_ID: "acc-123", CLOUDFLARE_API_TOKEN: "cf-token" } as any;
}

const VOICE_PRIMARY_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const VOICE_FALLBACK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function isVoiceModelCall(url: RequestInfo | URL): boolean {
  return String(url).startsWith("https://api.cloudflare.com/client/v4/accounts/acc-123/ai/run/");
}

// Workers AI envelope for chat-completions style models.
function workersAiReply(payload: unknown): Response {
  return new Response(
    JSON.stringify({ success: true, result: { choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }] } }),
    { status: 200 },
  );
}

const VOICE_TEST_PRIVATE_KEY = schnorr.utils.randomSecretKey();
const VOICE_TEST_PUBLIC_KEY = bytesToHex(schnorr.getPublicKey(VOICE_TEST_PRIVATE_KEY));

function authenticatedVoiceRequest(input: string, init: RequestInit): Request {
  const parsedBody = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
  if (parsedBody && Object.prototype.hasOwnProperty.call(parsedBody, "npub")) {
    parsedBody.npub = VOICE_TEST_PUBLIC_KEY;
  }
  const body = parsedBody ? JSON.stringify(parsedBody) : "";
  return new Request(input, {
    ...init,
    body,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...makeTaskifyAuthHeaders(VOICE_TEST_PRIVATE_KEY, VOICE_TEST_PUBLIC_KEY, body),
    },
  });
}

test("POST /api/voice/extract rejects unsigned requests", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);
  const response = await worker.fetch(new Request("https://taskify-v2.solife.me/api/voice/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ npub: VOICE_TEST_PUBLIC_KEY, transcript: "call dentist" }),
  }), env);
  assert.equal(response.status, 401);
});

// ── Test 1: POST /api/voice/extract — returns 501 when Workers AI credentials are missing ─
test("POST /api/voice/extract returns 501 when Workers AI is not configured", async () => {
  const db = new MockD1WithVoice();
  const env = await makeEnv(db); // no CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN

  const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ npub: "npub1abc", transcript: "call dentist tomorrow", sessionDurationSeconds: 5 }),
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 501, "should be 501 when Workers AI credentials are absent");
  const body = await res.json() as any;
  assert.ok(body.error, "should have error field");
});

// ── Test 2: POST /api/voice/extract — 400 on missing npub ─────────────────────
test("POST /api/voice/extract returns 400 when npub is missing", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/extract", {
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

  const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ npub: "npub1abc", transcript: "   ", sessionDurationSeconds: 0 }),
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 400);
  const body = await res.json() as any;
  assert.ok(body.error);
});

// ── Test 4: POST /api/voice/extract — happy path: calls the model, returns operations ─
test("POST /api/voice/extract calls Workers AI and returns operations on success", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const modelTasks = [
    { type: "create_task", title: "Call dentist", dueText: "tomorrow" },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (isVoiceModelCall(url)) {
      return workersAiReply({ tasks: modelTasks });
    }
    return new Response("", { status: 200 });
  }) as any;

  try {
    const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/extract", {
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
test("POST /api/voice/extract increments quota after a successful model call", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);
  const npub = VOICE_TEST_PUBLIC_KEY;
  const date = new Date().toISOString().slice(0, 10);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (isVoiceModelCall(url)) {
      return workersAiReply({ operations: [] });
    }
    return new Response("", { status: 200 });
  }) as any;

  try {
    const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/extract", {
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
  const npub = VOICE_TEST_PUBLIC_KEY;
  const date = new Date().toISOString().slice(0, 10);

  // Pre-seed quota at limit
  db.quota.set(`${npub}:${date}`, { session_count: 5, total_seconds: 300 });

  const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/extract", {
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

// ── Test 7: POST /api/voice/extract — model failure returns 503 ─
test("POST /api/voice/extract returns 503 when every model fails", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("error", { status: 503 })) as any;

  try {
    const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/extract", {
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
    assert.equal(res.status, 503, "should return 503 when no model answers");
    const body = await res.json() as any;
    assert.equal(body.error, "voice_unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/voice/extract falls back to the JSON Mode model when the first fails", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith(`/ai/run/${VOICE_PRIMARY_MODEL}`)) {
      return new Response("model unavailable", { status: 503 });
    }
    if (u.endsWith(`/ai/run/${VOICE_FALLBACK_MODEL}`)) {
      assert.deepEqual(JSON.parse(String(init?.body)).response_format, { type: "json_object" });
      // JSON Mode returns `response` already parsed.
      return new Response(
        JSON.stringify({ success: true, result: { response: { tasks: [{ title: "Call dentist", dueText: "tomorrow", subtasks: [] }] } } }),
        { status: 200 },
      );
    }
    return new Response("", { status: 404 });
  }) as any;

  try {
    const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/extract", {
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
    assert.equal(calls.length, 2, "one attempt per model");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/voice/extract applies correction phrases to prior task dueText", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (isVoiceModelCall(url)) {
      return workersAiReply({
        tasks: [
          { title: "Play date", dueText: "tomorrow at noon", subtasks: [] },
          { title: "then next Sunday at 2 PM we have a dinner after church", dueText: "next Sunday at 2 PM", subtasks: [] },
        ],
      });
    }
    return new Response("", { status: 200 });
  }) as any;

  try {
    const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/extract", {
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
    if (isVoiceModelCall(url)) {
      return workersAiReply({
        tasks: [
          {
            title: "Remind me to call dentist",
            dueText: "tomorrow at 2 PM",
            reminderText: "at due time",
            subtasks: [],
          },
        ],
      });
    }
    return new Response("", { status: 200 });
  }) as any;

  try {
    const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/extract", {
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

// ── Test 8: POST /api/voice/finalize — 501 when Workers AI credentials are missing ──
test("POST /api/voice/finalize returns 501 when Workers AI is not configured", async () => {
  const db = new MockD1WithVoice();
  const env = await makeEnv(db); // no credentials

  const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/finalize", {
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

  const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/finalize", {
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
    if (isVoiceModelCall(url)) {
      // Simulate the model normalizing the task
      return workersAiReply({
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
      });
    }
    return new Response("", { status: 200 });
  }) as any;

  try {
    const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/finalize", {
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

test("POST /api/voice/extract carries notes and recurrence text into operations", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (isVoiceModelCall(url)) {
      return workersAiReply({
        tasks: [
          {
            title: "Take out the trash",
            dueText: "Monday evening",
            notes: "Recycling and compost bins too",
            recurrenceText: "every Monday",
            subtasks: [],
          },
        ],
      });
    }
    return new Response("", { status: 200 });
  }) as any;

  try {
    const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        npub: "npub1abc",
        transcript: "remind me to take out the trash every Monday evening, note recycling and compost bins too",
        candidates: [],
        sessionDurationSeconds: 12,
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.operations[0].title, "Take out the trash");
    assert.equal(body.operations[0].notes, "Recycling and compost bins too");
    assert.equal(body.operations[0].recurrenceText, "every Monday");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/voice/finalize normalizes recurrence and validates model-chosen boards and columns", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (isVoiceModelCall(url)) {
      return workersAiReply({
        tasks: [
          {
            id: "c1",
            title: "Trash night",
            dueISO: "2026-08-03T21:00:00.000Z",
            notes: "Recycling too",
            subtasks: [],
            boardId: "board-lists",
            columnId: "col-2",
            recurrence: { type: "weekly", days: [1, 4, 9] },
            priority: 3,
            reminderMinutesBeforeDue: [15, 60],
            reminderTime: null,
          },
          {
            id: "c2",
            title: "Groceries",
            dueISO: null,
            notes: null,
            subtasks: [],
            boardId: "board-hallucinated",
            columnId: "col-9",
            recurrence: { type: "monthlyDay", day: 40 },
            priority: null,
            reminderMinutesBeforeDue: null,
            reminderTime: null,
          },
        ],
      });
    }
    return new Response("", { status: 200 });
  }) as any;

  try {
    const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/finalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        npub: "npub1abc",
        candidates: [
          { id: "c1", title: "trash night", reminderText: "15 minutes before and 1 hour before", status: "confirmed" },
          { id: "c2", title: "groceries", status: "confirmed" },
        ],
        boardId: "board-default",
        referenceDate: "2026-08-01T18:00:00.000Z",
        boards: [
          { id: "board-weekly", name: "Weekly", kind: "week" },
          { id: "board-lists", name: "Errands", kind: "lists", columns: [{ id: "col-1", name: "To buy" }, { id: "col-2", name: "Later" }] },
        ],
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.tasks.length, 2);

    // c1: valid board + valid column, recurrence days sanitized, multi-reminder array kept
    assert.equal(body.tasks[0].boardId, "board-lists");
    assert.equal(body.tasks[0].columnId, "col-2");
    assert.deepEqual(body.tasks[0].recurrence, { type: "weekly", days: [1, 4] });
    assert.deepEqual(body.tasks[0].reminderMinutesBeforeDue, [15, 60]);
    assert.equal(body.tasks[0].notes, undefined, "model must not invent notes");
    assert.equal(body.tasks[0].priority, 3);

    // c2: hallucinated board falls back to the request's default board, invalid
    // recurrence and unmatched column are dropped
    assert.equal(body.tasks[1].boardId, "board-default");
    assert.equal(body.tasks[1].columnId, undefined);
    assert.equal(body.tasks[1].recurrence, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/voice/finalize only returns reminders for explicit reminder requests", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (isVoiceModelCall(url)) {
      return workersAiReply({
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
      });
    }
    return new Response("", { status: 200 });
  }) as any;

  try {
    const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/finalize", {
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

// ── Test 11: POST /api/voice/finalize — second model answers when the first cannot ─
test("POST /api/voice/finalize falls back to the JSON Mode model when the first fails", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.endsWith(`/ai/run/${VOICE_PRIMARY_MODEL}`)) {
      // Answers, but not with JSON.
      return workersAiReply("Sorry, I can only help with tasks.");
    }
    if (u.endsWith(`/ai/run/${VOICE_FALLBACK_MODEL}`)) {
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            response: {
              tasks: [
                { id: "c1", title: "Call Dentist", dueISO: "2026-03-25T14:00:00.000Z", subtasks: [], notes: null, boardId: null, priority: null },
              ],
            },
          },
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 404 });
  }) as any;

  try {
    const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/finalize", {
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

test("POST /api/voice/finalize returns 503 when every model fails", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("error", { status: 503 })) as any;

  try {
    const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/finalize", {
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
    assert.equal(res.status, 503, "must return 503 when no model answers");
    const body = await res.json() as any;
    assert.equal(body.error, "voice_unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/voice/finalize returns 503 (no local due parsing fallback) when every model fails", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("error", { status: 503 })) as any;

  try {
    const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/finalize", {
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
    assert.equal(body.error, "voice_unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const stall of ["headers", "body"] as const) {
  test(`voice extraction times out stalled ${stall} and tries the next model`, async (t) => {
    const env = await makeVoiceEnv(new MockD1WithVoice());
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    let firstSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      attempts++;
      if (attempts === 1) {
        firstSignal = init?.signal ?? undefined;
        assert.ok(firstSignal, "provider calls must have an abort signal");
        const stalled = new Promise<never>((_resolve, reject) => {
          firstSignal!.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true });
        });
        started();
        return stall === "headers" ? stalled : { ok: true, json: () => stalled };
      }
      return workersAiReply({ tasks: [{ title: "Team meeting", dueText: "tomorrow at 8 AM" }] });
    }) as typeof fetch;
    try {
      const request = authenticatedVoiceRequest("https://taskify.solife.me/api/voice/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ npub: "npub1abc", transcript: "Team meeting tomorrow at 8 AM", candidates: [], sessionDurationSeconds: 20 }),
      });
      const pending = worker.fetch(request, env);
      await firstStarted;
      // Let fetch/response.json attach their rejection handlers before expiring the timer.
      await new Promise<void>((resolve) => setImmediate(resolve));
      t.mock.timers.tick(20_000);
      const response = await pending;
      assert.equal(response.status, 200);
      assert.equal(firstSignal?.aborted, true);
      assert.equal(attempts, 2);
      assert.equal(((await response.json()) as any).operations[0].title, "Team meeting");
    } finally {
      globalThis.fetch = originalFetch;
      t.mock.timers.reset();
    }
  });
}

test('voice finalize anchors tomorrow locally and repairs an ambiguous appointment range', async () => {
  const env = await makeVoiceEnv(new MockD1WithVoice());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const prompt = JSON.parse(String(init?.body)).messages[1].content;
    assert.ok(prompt.includes("User's local calendar date (today): 2026-09-11"));
    assert.ok(prompt.includes('Tomorrow in the user\'s time zone: 2026-09-12'));
    return workersAiReply({ tasks: [
      { id: 'c1', title: "Meet the Spectrum guy at Gail's house", dueISO: '2026-09-13T06:00:00Z' },
      { id: 'c2', title: 'Buy groceries', dueISO: '2026-09-13' },
    ] });
  }) as typeof fetch;
  try {
    const request = authenticatedVoiceRequest('https://taskify.solife.me/api/voice/finalize', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ npub: 'npub1abc', referenceDate: '2026-09-12T03:02:00Z', referenceTimeZone: 'America/Chicago', referenceOffsetMinutes: 300,
        candidates: [
          { id: 'c1', title: "Meet the Spectrum guy at Gail's house", dueText: 'tomorrow from 1-2', status: 'confirmed' },
          { id: 'c2', title: 'Buy groceries', dueText: 'tomorrow', status: 'confirmed' },
        ],
      }),
    });
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.tasks[0].dueISO, '2026-09-12T18:00:00.000Z');
    assert.equal(body.tasks[1].dueISO, '2026-09-12');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("voice finalization consumes the same account budget as extraction", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);
  const day = new Date().toISOString().slice(0, 10);
  db.quota.set(`${VOICE_TEST_PUBLIC_KEY}:${day}`, { session_count: 20, total_seconds: 0 });
  const response = await worker.fetch(authenticatedVoiceRequest("https://taskify.test/api/voice/finalize", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ npub: VOICE_TEST_PUBLIC_KEY, candidates: [{ id: "1", title: "Call dentist", status: "confirmed" }] }),
  }), env);
  assert.equal(response.status, 429);
});

test("voice rejects general API parameters and malformed candidates before provider work", async () => {
  const env = await makeVoiceEnv(new MockD1WithVoice());
  for (const extra of [{ model: "anything" }, { messages: [] }, { candidates: [{ id: "1", title: {}, status: "confirmed" }] }, { transcript: "x".repeat(8001) }]) {
    const response = await worker.fetch(authenticatedVoiceRequest("https://taskify.test/api/voice/extract", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ npub: VOICE_TEST_PUBLIC_KEY, transcript: "Call dentist", ...extra }),
    }), env);
    assert.equal(response.status, 400);
  }
});

test("voice sends dictated text only to Workers AI", async () => {
  const env = await makeVoiceEnv(new MockD1WithVoice());
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return workersAiReply({ tasks: [{ title: "Call dentist", dueText: "tomorrow", subtasks: [] }] });
  }) as any;
  try {
    const response = await worker.fetch(authenticatedVoiceRequest("https://taskify.test/api/voice/extract", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ npub: VOICE_TEST_PUBLIC_KEY, transcript: "Call dentist tomorrow" }),
    }), env);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/acc-123/ai/run/${VOICE_PRIMARY_MODEL}`);
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer cf-token");
    const sent = JSON.parse(String(calls[0].init?.body));
    assert.equal(sent.messages[0].role, "system");
    assert.ok(sent.messages[1].content.includes("Call dentist tomorrow"));
    assert.equal(sent.max_completion_tokens, 2048);
    assert.equal(sent.response_format, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test("voice accepts model JSON that is fenced or wrapped in a sentence", async () => {
  const wrapped = [
    "```json\n{\"tasks\":[{\"title\":\"Call dentist\",\"subtasks\":[]}]}\n```",
    "Here is the JSON you asked for: {\"tasks\":[{\"title\":\"Call dentist\",\"subtasks\":[]}]} Let me know if you need more.",
  ];
  const originalFetch = globalThis.fetch;
  try {
    for (const content of wrapped) {
      const env = await makeVoiceEnv(new MockD1WithVoice());
      globalThis.fetch = (async () => new Response(
        JSON.stringify({ success: true, result: { choices: [{ message: { content } }] } }), { status: 200 },
      )) as any;
      const response = await worker.fetch(authenticatedVoiceRequest("https://taskify.test/api/voice/extract", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ npub: VOICE_TEST_PUBLIC_KEY, transcript: "Call dentist" }),
      }), env);
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as any).operations[0].title, "Call dentist");
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("provider failures still charge account, IP and global budgets", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as any;
  try {
    const response = await worker.fetch(authenticatedVoiceRequest("https://taskify.test/api/voice/extract", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ npub: VOICE_TEST_PUBLIC_KEY, transcript: "Call dentist" }),
    }), env);
    assert.equal(response.status, 503);
    assert.equal(db.quota.size, 3);
    for (const row of db.quota.values()) assert.equal(row.session_count, 1);
  } finally { globalThis.fetch = originalFetch; }
});

// ── Audit fixes (2026-09-30): push registration, reminder caps, errors, previews ──

function pushDevice(deviceId: string, endpoint: string, endpointHash: string): DeviceRow {
  return {
    device_id: deviceId,
    platform: "ios",
    endpoint,
    endpoint_hash: endpointHash,
    subscription_auth: "auth",
    subscription_p256dh: "p256dh",
    updated_at: Date.now(),
  };
}

test("device registration accepts only browser push-service endpoints", async () => {
  const env = await makeEnv(new MockD1());
  const register = (endpoint: string, deviceId: string) => worker.fetch(new Request("https://taskify.test/api/devices", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId, platform: "ios", subscription: { endpoint, keys: { auth: "a", p256dh: "b" } } }),
  }), env);
  for (const endpoint of [
    "https://victim.example/any/path",
    "http://fcm.googleapis.com/fcm/send/x",
    "https://10.0.0.5/x",
    "https://fcm.googleapis.com:8443/fcm/send/x",
    "https://user@fcm.googleapis.com/fcm/send/x",
    "https://fcm.googleapis.com.evil.example/x",
    "not a url",
  ]) {
    assert.equal((await register(endpoint, "bad-device")).status, 400, endpoint);
  }
  for (const [index, endpoint] of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QOs0abc",
    "https://wns2-by3p.notify.windows.com/w/?token=abc",
  ].entries()) {
    assert.equal((await register(endpoint, `good-${index}`)).status, 200, endpoint);
  }
});

test("reminder saves are capped, de-duplicated, and truncate long titles", async () => {
  const db = new MockD1();
  const env = await makeEnv(db);
  const endpoint = "https://fcm.googleapis.com/fcm/send/caps";
  const subscriptionId = await sha256Hex(endpoint);
  db.devices.set("caps", pushDevice("caps", endpoint, subscriptionId));
  const due = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
  const soon = new Date(Date.now() + 24 * 60 * 60_000).toISOString(); // kept: the soonest win
  const reminders = [
    { taskId: "dup", title: "x", dueISO: soon, minutesBefore: [5, 5, 5] },
    { taskId: "long", title: "T".repeat(10_000), dueISO: soon, minutesBefore: [0] },
    ...Array.from({ length: 600 }, (_, i) => ({ taskId: `t-${i}`, title: "t", dueISO: due, minutesBefore: [i] })),
  ];
  const response = await worker.fetch(new Request("https://taskify.test/api/reminders", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "caps", subscriptionId, reminders }),
  }), env);
  assert.equal(response.status, 204);
  assert.equal(db.reminders.length, 500);
  assert.equal(db.reminders.filter((row) => row.task_id === "dup").length, 1);
  const long = db.reminders.find((row) => row.task_id === "long");
  assert.equal(long?.title.length, 200);
});

test("oversized push bodies are refused before parsing", async () => {
  const env = await makeEnv(new MockD1());
  const response = await worker.fetch(new Request("https://taskify.test/api/devices", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(300 * 1024) }),
  }), env);
  assert.equal(response.status, 413);
});

test("push routes honor their rate-limit binding", async () => {
  const env = await makeEnv(new MockD1());
  env.PUSH_RATE_LIMITER = { limit: async () => ({ success: false }) };
  const response = await worker.fetch(new Request("https://taskify.test/api/reminders", {
    method: "PUT", headers: { "content-type": "application/json" }, body: "{}",
  }), env);
  assert.equal(response.status, 429);
});

test("errors do not reveal internal detail", async () => {
  const env = await makeEnv(new MockD1());
  const malformed = await worker.fetch(new Request("https://taskify.test/api/devices/%E0%A4%A", { method: "DELETE" }), env);
  assert.equal(malformed.status, 400);
  env.TASKIFY_DB = { prepare() { throw new Error("D1_ERROR: secret table detail"); } };
  const failing = await worker.fetch(new Request("https://taskify.test/api/reminders", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: "x", subscriptionId: "y", reminders: [] }),
  }), env);
  assert.equal(failing.status, 500);
  assert.deepEqual(await failing.json(), { error: "Internal error" });
});

test("cron removes devices stored with endpoints that are no longer allowed, without contacting them", async () => {
  const db = new MockD1();
  const env = await makeEnv(db);
  const endpoint = "https://victim.example/legacy";
  db.devices.set("legacy", pushDevice("legacy", endpoint, await sha256Hex(endpoint)));
  db.reminders.push({ device_id: "legacy", reminder_key: "t:0", task_id: "t", board_id: null, title: "x", due_iso: new Date().toISOString(), minutes: 0, send_at: Date.now() - 1_000 });
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => { calls.push(String(url)); return new Response("", { status: 201 }); }) as any;
  try {
    await worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" } as any, env, undefined as any);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(calls, []);
  assert.equal(db.devices.has("legacy"), false);
});

test("one cron tick handles a bounded number of due reminders", async () => {
  const db = new MockD1();
  const env = await makeEnv(db);
  for (let i = 0; i < 300; i++) {
    const endpoint = `https://fcm.googleapis.com/fcm/send/bulk-${i}`;
    db.devices.set(`bulk-${i}`, pushDevice(`bulk-${i}`, endpoint, await sha256Hex(endpoint)));
    db.reminders.push({ device_id: `bulk-${i}`, reminder_key: "t:0", task_id: "t", board_id: null, title: "x", due_iso: new Date().toISOString(), minutes: 0, send_at: Date.now() - 1_000 });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 201 })) as any;
  try {
    await worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" } as any, env, undefined as any);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(db.pending.length, 200);
  assert.equal(db.reminders.length, 100, "the rest waits for the next tick");
});

test("Watch bridge bodies are bounded before the signature is checked", async () => {
  const env = await makeEnv(new MockD1());
  const response = await worker.fetch(new Request("https://taskify.test/api/watch/nostr/query", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Taskify-Npub": "ab".repeat(32), "X-Taskify-Timestamp": String(Math.floor(Date.now() / 1000)), "X-Taskify-Sig": "cd".repeat(64) },
    body: "x".repeat(300 * 1024),
  }), env);
  assert.equal(response.status, 413);
});

test("rate-limit keys group IPv6 callers by /64", async () => {
  const { rateLimitAddress } = await import("./lib.ts");
  assert.equal(rateLimitAddress("192.0.2.7"), "192.0.2.7");
  assert.equal(rateLimitAddress("2001:db8:1:1::abcd"), "2001:db8:1:1::/64");
  assert.equal(rateLimitAddress("2001:0db8:0001:0001:0000:0000:0000:0001"), "2001:db8:1:1::/64");
  assert.equal(rateLimitAddress("2001:db8:1:1::1"), rateLimitAddress("2001:db8:1:1:ffff:ffff:ffff:ffff"));
  assert.notEqual(rateLimitAddress("2001:db8:1:1::1"), rateLimitAddress("2001:db8:1:2::1"));
});

test("link previews never return a non-http final URL, image, or icon", async () => {
  const env = await makeEnv(new MockD1());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://attacker.example/")) {
      return new Response(null, { status: 302, headers: { Location: "https://www.google.com/url?q=javascript:alert(document.domain)" } });
    }
    return new Response("<html><head><title>Redirect</title><meta property='og:image' content='javascript:alert(1)'></head><body></body></html>", { status: 200, headers: { "Content-Type": "text/html" } });
  }) as any;
  try {
    const response = await worker.fetch(new Request(`https://taskify.test/api/preview?url=${encodeURIComponent("https://attacker.example/r")}`), env);
    const body = await response.json() as any;
    for (const field of ["finalUrl", "image", "icon"]) {
      const value = body.preview?.[field];
      if (value !== undefined) assert.match(value, /^https?:\/\//, field);
    }
    assert.equal(body.preview.finalUrl, "https://attacker.example/r");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Audit fix pass 2 ──

test("the public-address guard expands IPv6 before checking ranges", () => {
  for (const target of [
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:7f00:1]/",
    "http://[64:ff9b::a00:1]/",
    "http://[2002:a00:1::]/",
    "http://[::127.0.0.1]/",
    "http://[2001:db8::1]/",
    "http://[ff02::1]/",
  ]) {
    assert.throws(() => assertPublicHttpUrl(target), UnsafePublicUrlError, target);
  }
  for (const target of ["http://[::ffff:8.8.8.8]/", "http://[2606:4700:4700::1111]/"]) {
    assert.doesNotThrow(() => assertPublicHttpUrl(target), target);
  }
});

test("the Watch bridge drops relay targets that are not public hosts", async () => {
  const { watchNostrBridgeTestHooks } = await import("./nostr-bridge.ts");
  const kept = watchNostrBridgeTestHooks.normalizedRelayURLs([
    "wss://10.0.0.1", "wss://192.168.1.1:8443", "wss://169.254.169.254", "wss://[::ffff:7f00:1]",
    "wss://service.internal", "wss://printer.local", "wss://localhost", "wss://relay.damus.io",
  ]);
  assert.deepEqual(kept, ["wss://relay.damus.io"]);
});

test("hourly pruning deletes week-old voice counters and two-week-old undelivered notifications", async () => {
  const { pruneStaleRows } = await import("./index.ts");
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const statement = { sql, params: [] as unknown[], bind(...params: unknown[]) { statement.params = params; return statement; } };
      return statement;
    },
    async batch(list: any[]) { statements.push(...list.map((s) => ({ sql: s.sql, params: s.params }))); return []; },
  };
  const now = Date.parse("2026-09-30T12:17:00Z");
  await pruneStaleRows({ TASKIFY_DB: db } as any, now);
  assert.deepEqual(statements, [
    { sql: "DELETE FROM voice_quota WHERE date < ?", params: ["2026-09-23"] },
    { sql: "DELETE FROM pending_notifications WHERE created_at < ?", params: [now - 14 * 24 * 60 * 60 * 1000] },
  ]);
});


test("API responses carry no CORS grant, so other sites cannot read them", async () => {
  const env = await makeEnv(new MockD1());
  const preflight = await worker.fetch(
    new Request("https://taskify-v2.solife.me/api/preview?url=https://example.com", {
      method: "OPTIONS",
      headers: { Origin: "https://elsewhere.example", "Access-Control-Request-Method": "GET" },
    }),
    env,
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), null);
  const config = await worker.fetch(new Request("https://taskify-v2.solife.me/api/config"), env);
  assert.equal(config.headers.get("Access-Control-Allow-Origin"), null);
});

test("NIP-05 refuses an oversized response", async () => {
  const env = await makeEnv(new MockD1());
  const originalFetch = globalThis.fetch;
  const huge = JSON.stringify({ names: { alice: "a".repeat(64) }, padding: "x".repeat(300 * 1024) });
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(init?.signal, "the lookup has a timeout signal");
    return new Response(huge, { status: 200, headers: { "Content-Type": "application/json" } });
  }) as any;
  try {
    const res = await worker.fetch(new Request("https://taskify-v2.solife.me/api/nip05?address=alice@example.com"), env);
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as any).error, /too large/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("site fallbacks match hosts exactly", () => {
  assert.ok(isYouTubeHost("www.youtube.com") && isYouTubeHost("youtu.be") && isYouTubeHost("m.youtube.com"));
  assert.ok(isAmazonHost("www.amazon.co.uk") && isAmazonHost("amazon.com") && isAmazonHost("amzn.to"));
  assert.ok(isEtsyHost("www.etsy.com"));
  for (const host of ["youtube.amazon.etsy.example", "notyoutube.com", "amazon.evil.co", "etsy.com.evil.example"]) {
    assert.ok(!isYouTubeHost(host) && !isAmazonHost(host) && !isEtsyHost(host), host);
  }
});

test("the library parser gets only the document head", () => {
  const html = `<html><head><title>T</title><meta property="og:image" content="https://x.example/i.png"></head><body>${"<p>body</p>".repeat(50_000)}</body></html>`;
  const head = documentHead(html);
  assert.ok(head.includes("og:image"));
  assert.ok(!head.includes("<p>body</p>"));
  assert.ok(documentHead("<p>" + "x".repeat(200_000)).length <= 64_000);
});
