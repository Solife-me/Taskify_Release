import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPublicKey, nip19 } from "nostr-tools";
import type { NostrEvent } from "nostr-tools";
import { runCli, type CliDependencies } from "../dist/cli.js";
import type { TaskifyConfig } from "../src/config.ts";
import {
  NIP51_CONTACTS_KIND,
  NIP51_LEGACY_CONTACTS_D_TAG,
  NIP51_PRIVATE_CONTACTS_D_TAG,
  buildNip51PrivateItems,
  decryptNip51PrivateItems,
  encryptNip51PrivateItems,
  extractNip51PrivateContacts,
} from "../src/shared/nip51Contacts.ts";
import { captureConsole, harnessConfig, harnessDependencies, recordingRuntime } from "./helpers/cliHarness.ts";

/**
 * C12-3 stage 3: contact, profile and bot-list reads and writes go through one standalone relay
 * session that is always closed. A recording fake stands in for the relays.
 */

const relays = ["wss://relay.example"];
const userSecretHex = "01".repeat(32);
const userPubkey = getPublicKey(Buffer.from(userSecretHex, "hex"));
const keys = { privateKeyHex: userSecretHex, publicKeyHex: userPubkey };
const friendHex = "ab".repeat(32);
const now = () => new Date("2026-10-25T12:00:00Z");

function config(changes: Partial<TaskifyConfig> = {}): TaskifyConfig {
  const value = structuredClone(harnessConfig);
  value.relays = relays;
  value.profiles.test.relays = relays;
  return Object.assign(value, changes);
}

type Recorded = Array<[string, ...unknown[]]>;

/** A `withStandaloneSession` that answers reads from `events` and records everything. */
function fakeSessions(events: NostrEvent[], options: { failWith?: Error } = {}) {
  const recorded: Recorded = [];
  const withStandaloneSession = (async (open: { relays: string[]; secretKeyHex?: string }, work: (session: unknown) => Promise<unknown>) => {
    recorded.push(["open", { relays: open.relays, signs: Boolean(open.secretKeyHex) }]);
    const session = {
      async fetchVerified(filter: Record<string, unknown>) {
        recorded.push(["fetch", filter]);
        if (options.failWith) throw options.failWith;
        const kinds = (filter.kinds as number[]) ?? [];
        return events.filter((event) => kinds.includes(event.kind));
      },
      async publish(template: { kind: number; content: string; tags: string[][] }) {
        recorded.push(["publish", template]);
        return { event: { ...template, id: "e".repeat(64), pubkey: userPubkey, created_at: 1, sig: "s" }, relays: open.relays };
      },
    };
    try {
      return await work(session);
    } finally {
      recorded.push(["close"]);
    }
  }) as NonNullable<CliDependencies["withStandaloneSession"]>;
  return { withStandaloneSession, recorded };
}

function run(argv: string[], sessions: ReturnType<typeof fakeSessions>, value = config()) {
  const { runtime } = recordingRuntime({});
  const harness = harnessDependencies(runtime, { now, withStandaloneSession: sessions.withStandaloneSession }, value);
  return captureConsole(() => runCli(["node", "taskify", ...argv], harness.dependencies)).then((result) => ({ ...result, saved: harness.saved }));
}

function event(kind: number, pubkey: string, content: string, tags: string[][] = [], createdAt = 100): NostrEvent {
  return { id: `${kind}-${createdAt}`.padEnd(64, "0"), pubkey, kind, content, tags, created_at: createdAt, sig: "s" };
}

test("contact fetch reads the profile anonymously, saves the contact, and closes the session", async () => {
  const sessions = fakeSessions([event(0, friendHex, JSON.stringify({ name: "alice", display_name: "Alice", nip05: "alice@example.test" }))]);
  const result = await run(["contact", "fetch", nip19.npubEncode(friendHex)], sessions);

  assert.equal(result.status, 0);
  assert.deepEqual(sessions.recorded, [
    ["open", { relays, signs: false }],
    ["fetch", { kinds: [0], authors: [friendHex], limit: 1 }],
    ["close"],
  ]);
  const contact = result.saved.at(-1)?.contacts?.find((c) => c.pubkey === friendHex);
  assert.equal(contact?.name, "alice");
  assert.equal(contact?.displayName, "Alice");
  assert.equal(contact?.nip05, "alice@example.test");
  assert.equal(contact?.updatedAt, Math.floor(now().getTime() / 1000));
});

test("contact fetch reports a relay failure, saves nothing, and still closes the session", async () => {
  const sessions = fakeSessions([], { failWith: new Error("relay unavailable") });
  const result = await run(["contact", "fetch", nip19.npubEncode(friendHex)], sessions);
  assert.equal(result.status, 1);
  assert.deepEqual(result.saved, []);
  assert.deepEqual(sessions.recorded.at(-1), ["close"]);
  assert.match(result.stderr.join("\n"), /relay unavailable/);
});

test("contact sync merges the encrypted and legacy lists, then publishes one encrypted list", async () => {
  const carol = "cd".repeat(32);
  const dave = "ef".repeat(32);
  const privateList = event(NIP51_CONTACTS_KIND, userPubkey,
    await encryptNip51PrivateItems(buildNip51PrivateItems([{ pubkey: carol, npub: nip19.npubEncode(carol), name: "Carol", addedAt: 1 }]), keys),
    [["d", NIP51_PRIVATE_CONTACTS_D_TAG]], 200);
  const legacyList = event(NIP51_CONTACTS_KIND, userPubkey, "", [["d", NIP51_LEGACY_CONTACTS_D_TAG], ["p", dave, "", "Dave"]], 150);
  const sessions = fakeSessions([privateList, legacyList]);
  const local = config({ contacts: [{ pubkey: friendHex, npub: nip19.npubEncode(friendHex), name: "Alice", addedAt: 1 }] });

  const result = await run(["contact", "sync", "--json"], sessions, local);

  assert.equal(result.status, 0);
  assert.deepEqual(sessions.recorded[0], ["open", { relays, signs: true }]);
  assert.deepEqual(sessions.recorded[1], ["fetch", {
    kinds: [NIP51_CONTACTS_KIND], authors: [userPubkey],
    "#d": [NIP51_PRIVATE_CONTACTS_D_TAG, NIP51_LEGACY_CONTACTS_D_TAG], limit: 5,
  }]);
  assert.deepEqual(sessions.recorded.at(-1), ["close"]);

  const saved = result.saved.at(-1)?.contacts?.map((c) => c.pubkey).sort();
  assert.deepEqual(saved, [friendHex, carol, dave].sort());

  const published = sessions.recorded.find(([name]) => name === "publish")?.[1] as { kind: number; content: string; tags: string[][] };
  assert.equal(published.kind, NIP51_CONTACTS_KIND);
  assert.deepEqual(published.tags, [["d", NIP51_PRIVATE_CONTACTS_D_TAG]], "nobody's key is published in the clear");
  const decrypted = extractNip51PrivateContacts(await decryptNip51PrivateItems(published.content, keys));
  assert.deepEqual(decrypted.map((c) => c.pubkey).sort(), [friendHex, carol, dave].sort());
});

test("contact sync --pull reads without publishing", async () => {
  const sessions = fakeSessions([]);
  const result = await run(["contact", "sync", "--pull"], sessions, config({ contacts: [{ pubkey: friendHex, npub: nip19.npubEncode(friendHex), addedAt: 1 }] }));
  assert.equal(result.status, 0);
  assert.ok(!sessions.recorded.some(([name]) => name === "publish"));
  assert.deepEqual(sessions.recorded.at(-1), ["close"]);
});

test("bot publish-commands publishes the list to the profile's and inbox relays; show-commands reads it", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "taskify-bot-"));
  try {
    const file = path.join(directory, "commands.json");
    writeFileSync(file, JSON.stringify([{ name: "status", description: "Show status" }]));
    const inbox = event(10050, userPubkey, "", [["relay", "wss://inbox.example"]]);
    const publish = fakeSessions([inbox]);
    const published = await run(["bot", "publish-commands", file, "--json"], publish);
    assert.equal(published.status, 0, published.stderr.join("\n"));
    const opens = publish.recorded.filter(([name]) => name === "open");
    const [, lastOpen] = opens.at(-1) as [string, { relays: string[]; signs: boolean }];
    assert.deepEqual([...lastOpen.relays].sort(), [...relays, "wss://inbox.example"].sort());
    assert.equal(lastOpen.signs, true);
    const template = publish.recorded.find(([name]) => name === "publish")?.[1] as { kind: number; tags: string[][] };
    assert.equal(template.kind, 30078);
    assert.ok(template.tags.some((tag) => tag[0] === "d" && tag[1] === "taskify-bot-commands"));
    assert.equal(publish.recorded.filter(([name]) => name === "close").length, opens.length, "every session closed");

    const listed = event(30078, friendHex, "", template.tags);
    const show = fakeSessions([listed]);
    const shown = await run(["bot", "show-commands", nip19.npubEncode(friendHex), "--json"], show);
    assert.equal(shown.status, 0, shown.stderr.join("\n"));
    assert.deepEqual(JSON.parse(shown.stdout.join("\n")).commands.map((c: { name: string }) => c.name), ["status"]);
    assert.equal(show.recorded.filter(([name]) => name === "close").length, show.recorded.filter(([name]) => name === "open").length);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
