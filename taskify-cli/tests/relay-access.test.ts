import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateSecretKey, getEventHash, getPublicKey } from "nostr-tools";
import { countLeadingZeroBits, mineEventTemplate } from "taskify-runtime-nostr";
import { nodeProofOfWorkHashFactory, parsePowDifficulty } from "../src/shared/relaySettings.ts";

type CommandResult = { code: number | null; stdout: string; stderr: string };

async function fixtureHome(profile: Record<string, unknown> = {}): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "taskify-relay-access-"));
  await mkdir(join(home, ".taskify-cli"), { recursive: true });
  await writeFile(join(home, ".taskify-cli", "config.json"), JSON.stringify({
    activeProfile: "default",
    profiles: { default: { relays: ["wss://relay.example.test"], ...profile } },
  }), { mode: 0o600 });
  return home;
}

async function runCli(home: string, args: string[]): Promise<CommandResult> {
  return await new Promise((resolveResult, reject) => {
    // Assertions read plain text; a developer shell may force colour on.
    const env = { ...process.env, HOME: home, FORCE_COLOR: "0", NO_COLOR: "1" };
    delete env.TASKIFY_NSEC;
    const child = spawn(process.execPath, [resolve("dist/index.js"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    // Strip any ANSI styling that still gets through.
    const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
    child.on("close", (code) => resolveResult({ code, stdout: plain(stdout), stderr: plain(stderr) }));
  });
}

async function profile(home: string): Promise<Record<string, unknown>> {
  const stored = JSON.parse(await readFile(join(home, ".taskify-cli", "config.json"), "utf8"));
  return stored.profiles.default;
}

test("Node's native hasher mines events that verify under NIP-01 hashing", async () => {
  const key = generateSecretKey();
  const template = { kind: 30301, created_at: 1_790_000_000, content: "ünïcode ✓ \"quoted\"", tags: [["d", "task"], ["b", "board"]] };
  const mined = await mineEventTemplate(template, key, 12, { hashFactory: nodeProofOfWorkHashFactory });
  assert.ok(countLeadingZeroBits(getEventHash({ ...mined, pubkey: getPublicKey(key) })) >= 12);
  assert.equal(mined.tags.find((tag) => tag[0] === "nonce")?.[2], "12");
});

test("PoW difficulties are whole numbers from 0 to 32", () => {
  assert.equal(parsePowDifficulty("0"), 0);
  assert.equal(parsePowDifficulty(" 20 "), 20);
  assert.equal(parsePowDifficulty(32), 32);
  for (const bad of ["33", "-1", "1.5", "twenty", ""]) assert.equal(parsePowDifficulty(bad), null, bad);
});

test("config set pow stores, validates and clears the profile's NIP-13 floor", async () => {
  const home = await fixtureHome();
  const set = await runCli(home, ["config", "set", "pow", "16"]);
  assert.equal(set.code, 0, set.stderr);
  assert.equal((await profile(home)).powDifficulty, 16);

  const invalid = await runCli(home, ["config", "set", "pow", "40"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /0 to 32/);
  assert.equal((await profile(home)).powDifficulty, 16);

  const clear = await runCli(home, ["config", "set", "pow", "0"]);
  assert.equal(clear.code, 0, clear.stderr);
  assert.equal((await profile(home)).powDifficulty, undefined);
});

test("relay add normalizes relay URLs and refuses anything else", async () => {
  const home = await fixtureHome();
  const bad = await runCli(home, ["relay", "add", "https://not-a-relay.example"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Not a relay URL/);

  assert.equal((await runCli(home, ["relay", "add", "wss://Relay.Two.example/"])).code, 0);
  assert.equal((await runCli(home, ["relay", "add", "wss://relay.two.example"])).code, 0);
  assert.deepEqual((await profile(home)).relays, ["wss://relay.example.test", "wss://relay.two.example"]);

  assert.equal((await runCli(home, ["relay", "remove", "wss://relay.two.example/"])).code, 0);
  assert.deepEqual((await profile(home)).relays, ["wss://relay.example.test"]);
});

test("relay info reports NIP-42 and NIP-13 requirements, including learned ones", async () => {
  const server = createServer((request, response) => {
    if (!String(request.headers.accept).includes("application/nostr+json")) return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/nostr+json" });
    response.end(JSON.stringify({
      name: "Gated \u001b[2Jrelay",
      software: "test-relay",
      supported_nips: [1, 11, 13, 42],
      limitation: { auth_required: true, min_pow_difficulty: 12, restricted_writes: true },
    }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const relay = `ws://127.0.0.1:${port}`;
  try {
    const home = await fixtureHome();
    // A target learned from an earlier `pow:` rejection, as the CLI persists it.
    await writeFile(join(home, ".taskify-cli", "relay-info.json"), JSON.stringify({
      "relay-info-cache:pow": JSON.stringify({ [`http://127.0.0.1:${port}/`]: { difficulty: 20, learnedAt: Date.now() } }),
    }));

    const json = await runCli(home, ["relay", "info", relay, "--json"]);
    assert.equal(json.code, 0, json.stderr);
    const info = JSON.parse(json.stdout);
    assert.equal(info.authRequired, true);
    assert.equal(info.minPowDifficulty, 12);
    assert.equal(info.learnedPowDifficulty, 20);
    assert.equal(info.restrictedWrites, true);
    assert.deepEqual(info.supportedNips, [1, 11, 13, 42]);
    assert.equal(info.name, "Gated [2Jrelay", "terminal control characters are stripped");

    const human = await runCli(home, ["relay", "info", relay]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /Auth \(NIP-42\):\s+required/);
    assert.match(human.stdout, /PoW \(NIP-13\):\s+difficulty 12/);
    assert.match(human.stdout, /Learned PoW:\s+difficulty 20/);

    const invalid = await runCli(home, ["relay", "info", "relay.example"]);
    assert.equal(invalid.code, 1);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
