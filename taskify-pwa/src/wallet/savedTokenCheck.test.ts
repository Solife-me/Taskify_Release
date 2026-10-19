import { describe, expect, test, vi } from "vitest";
import { checkSavedTokens, settleSavedTokens, type SavedTokenCheckDeps } from "./savedTokenCheck";
import type { PendingTokenEntry } from "./storage";

const entry = (id: string, mint = "https://mint.example", held = false): PendingTokenEntry =>
  ({ id, mint, token: `cashuB${id}`, addedAt: 1, attempts: 3, amount: 21, ...(held ? { held } : {}) });

function deps(states: Record<string, string[] | Error>, overrides: Partial<SavedTokenCheckDeps> = {}): SavedTokenCheckDeps {
  return {
    decode: (token) => {
      const id = token.replace("cashuB", "");
      if (id === "garbled") return null;
      return { mint: "https://mint.example", proofs: [{ secret: `${id}-1` }, { secret: `${id}-2` }] as any };
    },
    checkStates: async (_mint, proofs) => {
      const id = (proofs[0] as any).secret.split("-")[0];
      const result = states[id];
      if (result instanceof Error) throw result;
      return result.map((state) => ({ state })) as any;
    },
    ...overrides,
  };
}

describe("saved tokens that can never be redeemed", () => {
  test("a token whose notes were all spent elsewhere is found, held or not", async () => {
    const result = await checkSavedTokens(
      [entry("a"), entry("b", undefined, true), entry("c"), entry("d"), entry("garbled")],
      deps({ a: ["SPENT", "SPENT"], b: ["SPENT", "SPENT"], c: ["SPENT", "UNSPENT"], d: new Error("Failed to fetch") }),
    );
    expect(result).toEqual({ a: "spent", b: "spent", c: "redeemable", d: "unknown", garbled: "unknown" });
  });

  test("spent tokens are removed with a copy kept in history; the rest stay", async () => {
    const removed: string[] = [];
    const history: any[] = [];
    const remaining = await settleSavedTokens({
      ...deps({ a: ["SPENT", "SPENT"], c: ["UNSPENT", "UNSPENT"] }),
      list: () => [entry("a"), entry("c")],
      remove: (id) => removed.push(id),
      recordHistory: (item) => history.push(item),
    });
    expect(removed).toEqual(["a"]);
    expect(history).toEqual([
      expect.objectContaining({ summary: "Saved token already claimed elsewhere • 21 sats", detail: "cashuBa", detailKind: "token" }),
    ]);
    expect(remaining.map((r) => [r.entry.id, r.status])).toEqual([["c", "redeemable"]]);
  });

  test("nothing is removed while the mint cannot be reached", async () => {
    const remove = vi.fn();
    const remaining = await settleSavedTokens({
      ...deps({ a: new Error("Failed to fetch") }),
      list: () => [entry("a")],
      remove,
      recordHistory: vi.fn(),
    });
    expect(remove).not.toHaveBeenCalled();
    expect(remaining.map((r) => r.status)).toEqual(["unknown"]);
  });
});
