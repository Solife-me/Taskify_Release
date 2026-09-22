import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { prepareVoiceRequest, reserveVoiceQuota } from "./voice.ts";

const env = { VOICE_RATE_LIMITER: { limit: async () => ({ success: true }) } } as any;
const request = (body: string, headers = {}) => new Request("https://taskify.test/api/voice/extract", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body,
});

test("voice protection fails closed and kill switch prevents requests", async () => {
  for (const config of [{}, { ...env, VOICE_DISABLED: "true" }]) {
    assert.equal((await prepareVoiceRequest(request("{}"), config as any) as Response).status, 503);
  }
});

test("burst limits use only Cloudflare IP and reject before reading body", async () => {
  let key = "";
  const response = await prepareVoiceRequest(request("{}", { "CF-Connecting-IP": "192.0.2.1", "X-Real-IP": "spoofed" }), {
    VOICE_RATE_LIMITER: { limit: async (input: any) => { key = input.key; return { success: false }; } },
  } as any) as Response;
  assert.equal(response.status, 429);
  assert.equal(key, "voice:192.0.2.1");
  assert.equal(response.headers.get("Retry-After"), "60");
});

test("body limits count streamed bytes without trusting Content-Length", async () => {
  assert.equal((await prepareVoiceRequest(request("x".repeat(32769)), env) as Response).status, 413);
  assert.equal((await prepareVoiceRequest(request("{}", { "Content-Type": "text/plain" }), env) as Response).status, 415);
  const original = '{ "transcript": "call dentist" }';
  const prepared = await prepareVoiceRequest(request(original), env);
  assert.ok(prepared instanceof Request);
  assert.equal(await prepared.text(), original, "signature bytes must remain unchanged");
});

test("real SQLite conditional reservations cannot overrun a shared quota", async () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec("CREATE TABLE voice_quota (npub TEXT, date TEXT, session_count INTEGER, total_seconds INTEGER, PRIMARY KEY(npub,date))");
  const db = { prepare(query: string) { return { bind(...values: any[]) { return { async first() { return sql.prepare(query).get(...values) ?? null; } }; } }; } } as any;
  try {
    const results = await Promise.all(Array.from({ length: 50 }, () => reserveVoiceQuota(db, "shared-ip", "2026-09-22", 10)));
    assert.equal(results.filter(Boolean).length, 10);
    assert.equal(await reserveVoiceQuota(db, "shared-ip", "2026-09-23", 10), true);
    assert.equal(await reserveVoiceQuota(db, "user", "2026-09-22", 20, 299), true);
    assert.equal(await reserveVoiceQuota(db, "user", "2026-09-22", 20, 2), false);
  } finally { sql.close(); }
});
