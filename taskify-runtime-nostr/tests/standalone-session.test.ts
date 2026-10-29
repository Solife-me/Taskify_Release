import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  RelayPublishBudget,
  RuntimeSessionClosedError,
  StandaloneNostrSession,
  normalizeRelayUrls,
  withStandaloneSession,
} from "../dist/index.js";
import { startMockRelay } from "./helpers/mockRelay.ts";

/** C12-3: one-off reads and writes share verification, bounded waits and a complete close. */

test("reads return only events whose signatures verify", async () => {
  const relay = await startMockRelay();
  try {
    const secret = generateSecretKey();
    const good = finalizeEvent({ kind: 0, content: '{"name":"Real"}', tags: [], created_at: 100 }, secret);
    const forged = { ...finalizeEvent({ kind: 0, content: '{"name":"Real"}', tags: [], created_at: 200 }, secret), content: '{"name":"Forged"}' };
    relay.events.push(good, forged);

    const events = await withStandaloneSession({ relays: [relay.url] }, (session) =>
      session.fetchVerified({ kinds: [0], authors: [getPublicKey(secret)] }, { timeoutMs: 5_000 }));
    assert.deepEqual(events.map((event) => event.id), [good.id]);
  } finally {
    await relay.close();
  }
});

test("writes are signed by the account and accepted by the relay", async () => {
  const relay = await startMockRelay();
  try {
    const secret = generateSecretKey();
    const result = await withStandaloneSession({ relays: [relay.url], secretKeyHex: bytesToHex(secret) }, (session) =>
      session.publish({ kind: 30078, content: "settings", tags: [["d", "app"]] }));
    assert.equal(result.event.pubkey, getPublicKey(secret));
    assert.deepEqual(result.relays, normalizeRelayUrls([relay.url]));
    assert.deepEqual(relay.events.map((event) => event.id), [result.event.id]);

    await assert.rejects(
      withStandaloneSession({ relays: [relay.url] }, (session) => session.publish({ kind: 1, content: "x", tags: [] })),
      /signing identity is required/,
    );
  } finally {
    await relay.close();
  }
});

test("one-off publishers honor a shared relay budget across sessions", async () => {
  const relay = await startMockRelay();
  try {
    const secretKeyHex = bytesToHex(generateSecretKey());
    const publishBudget = new RelayPublishBudget({
      burst: 1,
      refillIntervalMs: 60_000,
      refillJitterMs: 0,
      firstPartyRelays: [],
    });
    await withStandaloneSession({ relays: [relay.url], secretKeyHex, publishBudget }, (session) =>
      session.publish({ kind: 1, content: "first", tags: [] }));
    await assert.rejects(
      withStandaloneSession({ relays: [relay.url], secretKeyHex, publishBudget }, (session) =>
        session.publish({ kind: 1, content: "second", tags: [] })),
      /being paced/,
    );
    assert.deepEqual(relay.events.map((event) => event.content), ["first"]);
  } finally {
    await relay.close();
  }
});

test("close is idempotent, and nothing works after it", async () => {
  const relay = await startMockRelay();
  try {
    const session = await StandaloneNostrSession.open({ relays: [relay.url], secretKeyHex: bytesToHex(generateSecretKey()) });
    await session.close();
    await session.close();
    await assert.rejects(session.fetchVerified({ kinds: [0] }), RuntimeSessionClosedError);
    await assert.rejects(session.publish({ kind: 1, content: "x", tags: [] }), RuntimeSessionClosedError);
  } finally {
    await relay.close();
  }
});

for (const mode of ["success", "error", "timeout"]) {
  test(`a process exits by itself after a standalone session ends in ${mode}`, async () => {
    const relay = await startMockRelay();
    try {
      const child = spawn(process.execPath, [path.join(import.meta.dirname, "helpers/standaloneSessionChild.mjs"), relay.url, mode], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const exited = await new Promise<number | null | "still running">((resolve) => {
        const timer = setTimeout(() => resolve("still running"), 8_000);
        child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
      });
      if (exited === "still running") child.kill();
      assert.equal(stdout.trim(), `closed ${mode}`, stderr);
      assert.equal(exited, 0, "the process kept running after the session closed");
    } finally {
      await relay.close();
    }
  });
}
