import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generateSecretKey, nip19, verifyEvent } from "nostr-tools";
import { uploadBlobToBlossom } from "../src/blossomUpload.ts";

test("Blossom uploads PUT the bytes with a signed BUD-01 authorization", async (t) => {
  const bytes = new TextEncoder().encode("opaque ciphertext");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ url: `https://media.example/${hash}.bin`, sha256: hash }), { status: 201 });
  });

  const remote = await uploadBlobToBlossom({
    serverUrl: "https://media.example/",
    bytes,
    nsec: nip19.nsecEncode(generateSecretKey()),
  });

  assert.equal(remote, `https://media.example/${hash}.bin`);
  assert.equal(calls[0].url, "https://media.example/upload");
  assert.equal(calls[0].init.method, "PUT");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.match(headers.Authorization, /^Nostr [A-Za-z0-9_-]+$/);
  const event = JSON.parse(Buffer.from(headers.Authorization.slice(6), "base64url").toString());
  assert.equal(verifyEvent(event), true);
  assert.equal(event.kind, 24242);
  assert.deepEqual(event.tags.find((tag: string[]) => tag[0] === "x"), ["x", hash]);
  assert.deepEqual(event.tags.find((tag: string[]) => tag[0] === "t"), ["t", "upload"]);
});

test("Blossom upload failures carry the server's message", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ message: "Pubkey not allowed" }), { status: 401 }));
  await assert.rejects(
    uploadBlobToBlossom({ serverUrl: "https://media.example", bytes: new Uint8Array([1]), nsec: nip19.nsecEncode(generateSecretKey()) }),
    /Pubkey not allowed/,
  );
});
