import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker from "./index.ts";

// Own file: the Worker caches the imported signing key per isolate, so a key set by another test
// in the same process would be reused.

function d1FromMigrations() {
  const sqlite = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
  }
  const prepare = (sql: string) => {
    let params: any[] = [];
    const statement = {
      bind: (...values: any[]) => { params = values; return statement; },
      run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } }),
      first: async () => sqlite.prepare(sql).get(...params) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
      _run: () => sqlite.prepare(sql).run(...params),
    };
    return statement;
  };
  return {
    sqlite,
    db: {
      prepare,
      batch: async (statements: Array<{ _run: () => unknown }>) => {
        sqlite.exec("BEGIN");
        try { for (const statement of statements) statement._run(); sqlite.exec("COMMIT"); } catch (err) { sqlite.exec("ROLLBACK"); throw err; }
        return statements.map(() => ({ success: true }));
      },
    },
  };
}

test("a raw base64url VAPID private key, as a secret, signs reminder pings", async () => {
  // The format the deleted KV namespace held, and what `wrangler secret put` receives now.
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");

  const { sqlite, db } = d1FromMigrations();
  const endpoint = "https://web.push.apple.com/QOs0secret";
  sqlite.prepare("INSERT INTO devices (device_id, platform, endpoint, endpoint_hash, subscription_auth, subscription_p256dh, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("phone", "ios", endpoint, "h", "a", "p", Date.now());
  sqlite.prepare("INSERT INTO reminders (device_id, reminder_key, task_id, board_id, title, due_iso, minutes, send_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("phone", "t:0", "t", null, "", new Date().toISOString(), 0, Date.now() - 1_000);

  const env = {
    TASKIFY_DB: db,
    VAPID_PUBLIC_KEY: publicKey,
    VAPID_PRIVATE_KEY: jwk.d,
    VAPID_SUBJECT: "mailto:dev@solife.me",
  } as any;
  const sent: Array<{ url: string; authorization: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization") ?? "" });
    return new Response(null, { status: 201 });
  }) as any;
  try {
    await worker.scheduled({ scheduledTime: Date.now(), cron: "*/1 * * * *" } as any, env, undefined as any);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, endpoint);
  const token = sent[0].authorization.replace(/^WebPush /, "");
  const [header, payload, signature] = token.split(".");
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pair.publicKey,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  assert.ok(verified, "the ping's VAPID token is signed by the secret key");
});
