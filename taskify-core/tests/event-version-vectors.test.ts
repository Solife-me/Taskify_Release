/**
 * The equal-timestamp rule shared with iOS (C7-3): relays keep the latest `created_at` and, on a
 * tie, the lowest event id (NIP-01). The fixture is written from `compareEventVersions`
 * (WRITE_EVENT_VERSION_VECTORS=1) and checked here and by Swift `EventVersionVectorTests`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { compareEventVersions, latestEventVersion, nextEventCreatedAt } from "../dist/index.js";

const FIXTURE = new URL("../fixtures/event-version-vectors.json", import.meta.url);
const LOW = "0a".padEnd(64, "1");
const HIGH = "f0".padEnd(64, "2");

const cases = [
  { name: "a later created_at wins", a: { createdAt: 101, id: HIGH }, b: { createdAt: 100, id: LOW } },
  { name: "an earlier created_at loses", a: { createdAt: 99, id: LOW }, b: { createdAt: 100, id: HIGH } },
  { name: "at the same created_at the lower id wins", a: { createdAt: 100, id: LOW }, b: { createdAt: 100, id: HIGH } },
  { name: "at the same created_at the higher id loses", a: { createdAt: 100, id: HIGH }, b: { createdAt: 100, id: LOW } },
  { name: "ids compare case-insensitively", a: { createdAt: 100, id: LOW.toUpperCase() }, b: { createdAt: 100, id: LOW } },
  { name: "the same event is the same version", a: { createdAt: 100, id: LOW }, b: { createdAt: 100, id: LOW } },
  { name: "a known id wins a tie with an unknown one", a: { createdAt: 100, id: HIGH }, b: { createdAt: 100, id: null } },
  { name: "an unknown id loses a tie with a known one", a: { createdAt: 100, id: null }, b: { createdAt: 100, id: HIGH } },
  { name: "two unknown ids are the same version", a: { createdAt: 100, id: null }, b: { createdAt: 100, id: null } },
  { name: "created_at decides before an unknown id", a: { createdAt: 101, id: null }, b: { createdAt: 100, id: LOW } },
];

const nextCases = [
  { name: "nothing known yet: now", now: 1000, previous: null },
  { name: "the last version is older: now", now: 1000, previous: 990 },
  { name: "the last version is this second: one later", now: 1000, previous: 1000 },
  { name: "the last version is ahead of this clock: one after it", now: 1000, previous: 1005 },
];

function buildVectors() {
  return {
    description:
      "Which version of a replaceable item wins: later created_at, then the lowest id (NIP-01); a known id wins a tie with an unknown one. expected is the sign of compare(a, b). nextCreatedAt: a new version's created_at, now but always after the newest version known. Written by taskify-core tests/event-version-vectors.test.ts (WRITE_EVENT_VERSION_VECTORS=1); checked there, by Swift EventVersionVectorTests and by the CLI's wire-vectors test.",
    vectors: cases.map((c) => ({ ...c, expected: Math.sign(compareEventVersions(c.a, c.b)) })),
    nextCreatedAt: nextCases.map((c) => ({ ...c, expected: nextEventCreatedAt(c.now, c.previous) })),
  };
}

test("event version vectors match compareEventVersions", () => {
  const built = JSON.parse(JSON.stringify(buildVectors()));
  if (process.env.WRITE_EVENT_VERSION_VECTORS === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(built, null, 2)}\n`);
  }
  assert.deepEqual(JSON.parse(readFileSync(FIXTURE, "utf8")), built);
});

test("the order is antisymmetric and picks the winner", () => {
  for (const c of cases) {
    assert.equal(Math.sign(compareEventVersions(c.b, c.a)), -Math.sign(compareEventVersions(c.a, c.b)) || 0, c.name);
    const winner = latestEventVersion(c.a, c.b);
    assert.equal(winner, compareEventVersions(c.a, c.b) >= 0 ? c.a : c.b, c.name);
  }
});
