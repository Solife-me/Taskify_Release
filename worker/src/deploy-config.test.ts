import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * `wrangler deploy` uploads wrangler.toml as the Worker's whole configuration: a variable set only
 * in the dashboard is dropped, and `name` picks which Worker is replaced. taskify.solife.me is
 * served by `taskify-public`; `taskify` is the retired v1 Worker on taskify-v1.solife.me.
 */
const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");

function topLevel(key: string): string | undefined {
  const head = toml.split(/^\[/m)[0];
  return head.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
}

function section(name: string): string {
  return toml.match(new RegExp(`^\\[${name.replace(".", "\\.")}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m"))?.[1] ?? "";
}

function variable(key: string): string | undefined {
  return section("vars").match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
}

test("a deploy replaces the Worker that serves taskify.solife.me", () => {
  assert.equal(topLevel("name"), "taskify-public");
});

test("a deploy carries the push settings reminders are sent with", () => {
  // Without these the cron signs nothing and every reminder ping fails ("Push ping error").
  const publicKey = variable("VAPID_PUBLIC_KEY");
  assert.ok(publicKey, "VAPID_PUBLIC_KEY is in [vars]");
  const point = Buffer.from(publicKey, "base64url");
  assert.equal(point.length, 65, "an uncompressed P-256 public key");
  assert.equal(point[0], 0x04);
  assert.match(variable("VAPID_SUBJECT") ?? "", /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/);
});

test("a deploy keeps request URLs out of the Worker's logs", () => {
  // Invocation logs record every request's URL and headers (F1A-9). Console logs stay on; they
  // carry only what the code chooses to write.
  const logs = section("observability.logs");
  assert.match(logs, /^enabled\s*=\s*true\s*$/m);
  assert.match(logs, /^invocation_logs\s*=\s*false\s*$/m);
});

test("a deploy binds none of the retired KV stores", () => {
  // Devices, reminders and pending notifications live in D1. The KV namespaces they came from
  // are retired; binding them again would invite code that reads them.
  for (const binding of ["TASKIFY_DEVICES", "TASKIFY_REMINDERS", "TASKIFY_PENDING"]) {
    assert.doesNotMatch(toml, new RegExp(`binding\\s*=\\s*"${binding}"`), binding);
  }
});

