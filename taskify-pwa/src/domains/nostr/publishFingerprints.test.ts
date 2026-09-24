import { describe, expect, it } from "vitest";
import { PublishFingerprints } from "./publishFingerprints";

describe("PublishFingerprints", () => {
  it("skips republishing unchanged content and allows changed content", () => {
    const fingerprints = new PublishFingerprints();
    const meta = { tags: [["name", "Week"]], payload: { columns: [] }, relays: ["wss://a"] };
    expect(fingerprints.isUnchanged("board-1", meta)).toBe(false);
    fingerprints.record("board-1", meta);
    expect(fingerprints.isUnchanged("board-1", { ...meta })).toBe(true);
    expect(fingerprints.isUnchanged("board-1", { ...meta, tags: [["name", "Renamed"]] })).toBe(false);
    expect(fingerprints.isUnchanged("board-2", meta)).toBe(false);
  });

  it("is insensitive to object key order", () => {
    const fingerprints = new PublishFingerprints();
    fingerprints.record("b", { a: 1, b: { c: 2, d: 3 } });
    expect(fingerprints.isUnchanged("b", { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
  });

  it("forgets a key so the next publish goes out", () => {
    const fingerprints = new PublishFingerprints();
    fingerprints.record("b", { a: 1 });
    fingerprints.forget("b");
    expect(fingerprints.isUnchanged("b", { a: 1 })).toBe(false);
  });
});
