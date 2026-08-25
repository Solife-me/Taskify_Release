import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.ts";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { assertPublicHttpUrl, UnsafePublicUrlError } from "./public-fetch.ts";

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

// ── Test 1: POST /api/voice/extract — returns 501 when GEMINI_API_KEY missing ─
test("POST /api/voice/extract returns 501 when GEMINI_API_KEY not configured", async () => {
  const db = new MockD1WithVoice();
  const env = await makeEnv(db); // no GEMINI_API_KEY

  const req = authenticatedVoiceRequest("https://taskify-v2.solife.me/api/voice/extract", {
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
test("POST /api/voice/extract increments quota after successful Gemini call", async () => {
  const db = new MockD1WithVoice();
  const env = await makeVoiceEnv(db);
  const npub = VOICE_TEST_PUBLIC_KEY;
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

// ── Test 7: POST /api/voice/extract — Gemini failure returns 503 ─
test("POST /api/voice/extract returns 503 when Gemini fails", async () => {
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

// ── Test 8: POST /api/voice/finalize — 501 when GEMINI_API_KEY missing ──────────
test("POST /api/voice/finalize returns 501 when GEMINI_API_KEY not configured", async () => {
  const db = new MockD1WithVoice();
  const env = await makeEnv(db); // no key

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

test("POST /api/voice/finalize returns 503 when Gemini fails", async () => {
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
    assert.equal(body.error, "gemini_unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
