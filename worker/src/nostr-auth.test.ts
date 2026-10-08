import test from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import worker from "./index.ts";
import { taskifyAuthV2Message, verifyTaskifyAuth } from "./nostr-auth.ts";
import { watchNostrBridgeTestHooks } from "./nostr-bridge.ts";

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function signedHeaders(
  privateKey: Uint8Array,
  publicKey: string,
  body = "",
  timestamp = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const hash = sha256(new TextEncoder().encode(`${timestamp}.${body}`));
  return {
    "X-Taskify-Npub": publicKey,
    "X-Taskify-Timestamp": String(timestamp),
    "X-Taskify-Sig": bytesToHex(schnorr.sign(hash, privateKey)),
  };
}

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values: number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < 5; index += 1) {
      if ((top >> index) & 1) checksum ^= BECH32_GENERATORS[index];
    }
  }
  return checksum;
}

function bech32HrpExpand(hrp: string): number[] {
  return [
    ...[...hrp].map((character) => character.charCodeAt(0) >> 5),
    0,
    ...[...hrp].map((character) => character.charCodeAt(0) & 31),
  ];
}

function convertToFiveBits(data: Uint8Array): number[] {
  let accumulator = 0;
  let bits = 0;
  const words: number[] = [];
  for (const byte of data) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((accumulator >> bits) & 31);
    }
  }
  if (bits > 0) words.push((accumulator << (5 - bits)) & 31);
  return words;
}

function encodeNpub(publicKeyHex: string): string {
  const hrp = "npub";
  const words = convertToFiveBits(hexToBytes(publicKeyHex));
  const checksumValue = bech32Polymod([
    ...bech32HrpExpand(hrp),
    ...words,
    0, 0, 0, 0, 0, 0,
  ]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5]
    .map((index) => (checksumValue >> (5 * (5 - index))) & 31);
  return `${hrp}1${[...words, ...checksum].map((word) => BECH32_CHARSET[word]).join("")}`;
}

test("Taskify auth rejects incomplete headers", async () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = "a".repeat(128);
  assert.equal(await verifyTaskifyAuth(new Request("https://example.com", {
    headers: { "X-Taskify-Timestamp": timestamp, "X-Taskify-Sig": signature },
  })), null);
  assert.equal(await verifyTaskifyAuth(new Request("https://example.com", {
    headers: { "X-Taskify-Npub": "a".repeat(64), "X-Taskify-Sig": signature },
  })), null);
  assert.equal(await verifyTaskifyAuth(new Request("https://example.com", {
    headers: { "X-Taskify-Npub": "a".repeat(64), "X-Taskify-Timestamp": timestamp },
  })), null);
});

test("Taskify auth rejects stale and excessively future timestamps", async () => {
  const privateKey = schnorr.utils.randomSecretKey();
  const publicKey = bytesToHex(schnorr.getPublicKey(privateKey));
  for (const timestamp of [
    Math.floor(Date.now() / 1000) - 301,
    Math.floor(Date.now() / 1000) + 301,
  ]) {
    const request = new Request("https://example.com", {
      headers: signedHeaders(privateKey, publicKey, "", timestamp),
    });
    assert.equal(await verifyTaskifyAuth(request), null);
  }
});

test("Taskify auth rejects invalid signatures and tampered bodies", async () => {
  const privateKey = schnorr.utils.randomSecretKey();
  const publicKey = bytesToHex(schnorr.getPublicKey(privateKey));
  const timestamp = Math.floor(Date.now() / 1000);
  const invalidSignature = bytesToHex(schnorr.sign(
    sha256(new TextEncoder().encode("wrong-payload")),
    privateKey,
  ));
  assert.equal(await verifyTaskifyAuth(new Request("https://example.com", {
    headers: {
      "X-Taskify-Npub": publicKey,
      "X-Taskify-Timestamp": String(timestamp),
      "X-Taskify-Sig": invalidSignature,
    },
  })), null);

  const originalBody = '{"key":"value"}';
  const request = new Request("https://example.com", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...signedHeaders(privateKey, publicKey, originalBody),
    },
    body: '{"key":"tampered"}',
  });
  assert.equal(await verifyTaskifyAuth(request), null);
});

test("Taskify auth accepts hex and npub public keys and canonicalizes to hex", async () => {
  const privateKey = schnorr.utils.randomSecretKey();
  const publicKey = bytesToHex(schnorr.getPublicKey(privateKey));
  const body = '{"hello":"world"}';
  const hexRequest = new Request("https://example.com", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signedHeaders(privateKey, publicKey, body) },
    body,
  });
  assert.deepEqual(await verifyTaskifyAuth(hexRequest), { npub: publicKey, version: 1 });

  const npub = encodeNpub(publicKey);
  const npubRequest = new Request("https://example.com", {
    headers: signedHeaders(privateKey, npub),
  });
  assert.deepEqual(await verifyTaskifyAuth(npubRequest), { npub: publicKey, version: 1 });
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
  assert.deepEqual(watchNostrBridgeTestHooks.normalizedFilter({
    kinds: [1, 30_301],
    authors: [author, author, "invalid"],
    limit: 50_000,
    since: 0,
  }), { kinds: [30_301], authors: [author], limit: 1_000 });
});

/** Enough of D1 for schema setup and the replay record. */
function replayDb() {
  const used = new Set<string>();
  return {
    used,
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { params = values; return statement; },
        async run() { return { success: true }; },
        async first() {
          if (!/INSERT INTO request_signatures/.test(sql)) return null;
          const signature = String(params[0]);
          if (used.has(signature)) return null;
          used.add(signature);
          return { signature };
        },
        async all() { return { results: [] }; },
      };
      return statement;
    },
  };
}

const routeTestEnv = {
  ASSETS: { fetch: async () => new Response("asset") },
  TASKIFY_DB: replayDb(),
} as any;

test("Watch Nostr query requires signed Taskify authentication", async () => {
  const response = await worker.fetch(new Request("https://taskify.example/api/watch/nostr/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relays: ["wss://relay.example"], filter: {} }),
  }), routeTestEnv);
  assert.equal(response.status, 401);
});

test("Watch Nostr query rejects broad filters before opening relays", async () => {
  const privateKey = schnorr.utils.randomSecretKey();
  const publicKey = bytesToHex(schnorr.getPublicKey(privateKey));
  const body = JSON.stringify({ relays: ["wss://relay.example"], filter: { kinds: [1] } });
  const response = await worker.fetch(new Request("https://taskify.example/api/watch/nostr/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signedHeaders(privateKey, publicKey, body) },
    body,
  }), routeTestEnv);
  assert.equal(response.status, 400);
});

test("retired Google Calendar API routes return 404", async () => {
  const response = await worker.fetch(
    new Request("https://taskify.example/api/gcal/status"),
    routeTestEnv,
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
});

test("Watch Nostr bridge rate-limits each account before opening relays", async () => {
  const privateKey = schnorr.utils.randomSecretKey();
  const publicKey = bytesToHex(schnorr.getPublicKey(privateKey));
  const keys: string[] = [];
  const env = {
    ...routeTestEnv,
    WATCH_NOSTR_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: false }; } },
  } as any;
  for (const path of ["publish", "query"]) {
    const body = JSON.stringify({ relays: ["wss://relay.example"], filter: { kinds: [30_301], authors: [publicKey] } });
    const response = await worker.fetch(new Request(`https://taskify.example/api/watch/nostr/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signedHeaders(privateKey, publicKey, body) },
      body,
    }), env);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");
  }
  // Keyed by the signed account, not the (shared) client address.
  assert.ok(keys.every((key) => key.endsWith(publicKey)), keys.join(","));
});

function signedHeadersV2(
  privateKey: Uint8Array,
  publicKey: string,
  method: string,
  url: string,
  body = "",
  timestamp = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const message = taskifyAuthV2Message(method, new URL(url), timestamp, bytesToHex(sha256(new TextEncoder().encode(body))));
  return {
    "X-Taskify-Auth": "v2",
    "X-Taskify-Npub": publicKey,
    "X-Taskify-Timestamp": String(timestamp),
    "X-Taskify-Sig": bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(message)), privateKey)),
  };
}

test("the version-2 message matches the vector the PWA, iOS, and Watch tests use", () => {
  const body = JSON.stringify({ a: 1 });
  const message = taskifyAuthV2Message(
    "post",
    new URL("https://taskify.solife.me/api/voice/extract"),
    1_790_000_000,
    bytesToHex(sha256(new TextEncoder().encode(body))),
  );
  assert.equal(message, "taskify-request-v2\nPOST\ntaskify.solife.me\n/api/voice/extract\n1790000000\n015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
  assert.equal(bytesToHex(sha256(new TextEncoder().encode(message))), "c0a46a916c09e41e1657f3fd34913825aeaaece8de15596f4fb7a850f6d42e50");
});

test("a version-2 signature is bound to its method, host, route, and minute, and used once", async () => {
  const privateKey = schnorr.utils.randomSecretKey();
  const publicKey = bytesToHex(schnorr.getPublicKey(privateKey));
  const url = "https://taskify.solife.me/api/watch/nostr/publish";
  const body = '{"x":1}';
  const request = (target: string, method: string, headers: Record<string, string>) =>
    new Request(target, { method, headers: { "Content-Type": "application/json", ...headers }, body: method === "GET" ? undefined : body });

  const headers = signedHeadersV2(privateKey, publicKey, "POST", url, body);
  const db = replayDb();
  assert.deepEqual(await verifyTaskifyAuth(request(url, "POST", headers), { replayStore: db as any }), { npub: publicKey, version: 2 });
  assert.equal(await verifyTaskifyAuth(request(url, "POST", headers), { replayStore: db as any }), null, "replayed");

  assert.equal(await verifyTaskifyAuth(request("https://taskify.solife.me/api/watch/nostr/query", "POST", headers)), null, "other route");
  assert.equal(await verifyTaskifyAuth(request("https://beta.example.workers.dev/api/watch/nostr/publish", "POST", headers)), null, "other host");
  assert.equal(await verifyTaskifyAuth(request(url, "PUT", headers)), null, "other method");
  const tampered = new Request(url, { method: "POST", headers, body: '{"x":2}' });
  assert.equal(await verifyTaskifyAuth(tampered), null, "other body");

  const stale = signedHeadersV2(privateKey, publicKey, "POST", url, body, Math.floor(Date.now() / 1000) - 61);
  assert.equal(await verifyTaskifyAuth(request(url, "POST", stale)), null, "older than 60 seconds");
});

test("version-1 signatures are refused once the Worker is told to", async () => {
  const privateKey = schnorr.utils.randomSecretKey();
  const publicKey = bytesToHex(schnorr.getPublicKey(privateKey));
  const body = '{"x":1}';
  const v1 = () => new Request("https://taskify.solife.me/api/voice/extract", { method: "POST", headers: signedHeaders(privateKey, publicKey, body), body });
  assert.equal((await verifyTaskifyAuth(v1()))?.version, 1);
  assert.equal(await verifyTaskifyAuth(v1(), { allowV1: false }), null);
});


test("the Watch publish route accepts a version-2 request once and refuses its replay", async () => {
  const privateKey = schnorr.utils.randomSecretKey();
  const publicKey = bytesToHex(schnorr.getPublicKey(privateKey));
  const env = {
    ASSETS: { fetch: async () => new Response("asset") },
    TASKIFY_DB: replayDb(),
    // Refusing at the rate limit proves authentication passed without opening relays.
    WATCH_NOSTR_RATE_LIMITER: { limit: async () => ({ success: false }) },
  } as any;
  const url = "https://taskify.example/api/watch/nostr/publish";
  const body = JSON.stringify({ relays: ["wss://relay.example"] });
  const headers = { "Content-Type": "application/json", ...signedHeadersV2(privateKey, publicKey, "POST", url, body) };
  const first = await worker.fetch(new Request(url, { method: "POST", headers, body }), env);
  assert.equal(first.status, 429);
  const replay = await worker.fetch(new Request(url, { method: "POST", headers, body }), env);
  assert.equal(replay.status, 401);
});
