import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeNip05,
  compressedToRawHex,
  normalizeNostrPubkeyHex,
  contactInitials,
  contactVerifiedNip05,
} from "../dist/contactContracts.js";

test("normalizeNip05 lowercases and validates", () => {
  assert.equal(normalizeNip05("Alice@Example.com"), "alice@example.com");
  assert.equal(normalizeNip05("bad"), null);
});

test("compressedToRawHex normalizes compressed and prefixed keys", () => {
  assert.equal(compressedToRawHex(`02${"a".repeat(64)}`), "a".repeat(64));
  assert.equal(compressedToRawHex(`0x${"b".repeat(64)}`), "b".repeat(64));
  assert.equal(compressedToRawHex("c".repeat(64)), "c".repeat(64));
});

test("normalizeNostrPubkeyHex accepts compressed and raw hex", () => {
  assert.equal(normalizeNostrPubkeyHex(`03${"d".repeat(64)}`), "d".repeat(64));
  assert.equal(normalizeNostrPubkeyHex("e".repeat(64)), "e".repeat(64));
  assert.equal(normalizeNostrPubkeyHex("npub1nothex"), null);
});

test("contactInitials handles simple names", () => {
  assert.equal(contactInitials("Jane Doe"), "JD");
  assert.equal(contactInitials("x"), "X");
});

test("contactVerifiedNip05 validates against cache", () => {
  const contact = { id: "1", nip05: "a@b.com", npub: `02${"a".repeat(64)}` };
  const cache = { "1": { status: "valid", nip05: "a@b.com", npub: "a".repeat(64), checkedAt: 1 } };
  assert.equal(contactVerifiedNip05(contact, cache as any), "a@b.com");
});

test("contactInitials keeps emoji, flags and non-Latin letters whole", () => {
  assert.equal(contactInitials("Ada Lovelace"), "AL");
  assert.equal(contactInitials("ada"), "AD");
  assert.equal(contactInitials("  "), "?");
  assert.equal(contactInitials("🦊 Fox"), "🦊");
  assert.equal(contactInitials("👨‍👩‍👧 Family"), "👨‍👩‍👧");
  assert.equal(contactInitials("🇺🇸 Team"), "🇺🇸");
  assert.equal(contactInitials("𝓐lice 𝓑ob"), "𝓐𝓑");
  assert.equal(contactInitials("Zoë"), "ZO");
  assert.equal(contactInitials("José Ñúñez"), "JÑ");
});
