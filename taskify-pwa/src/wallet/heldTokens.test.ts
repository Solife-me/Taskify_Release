import { beforeEach, expect, test, vi } from "vitest";

// In-memory wallet store; the real one writes through to IndexedDB.
const values = new Map<string, string>();
vi.mock("../storage/idbKeyValue", () => ({
  idbKeyValue: {
    getItem: (_store: string, key: string) => values.get(key) ?? null,
    setItem: (_store: string, key: string, value: string) => { values.set(key, value); },
    removeItem: (_store: string, key: string) => { values.delete(key); },
    flushStore: async () => {},
  },
}));

import { addMintToList, addPendingToken, listPendingTokens } from "./storage";
import { isKnownMint } from "../hooks/wallet/usePaymentRequestFlow";

beforeEach(() => values.clear());

test("a held token keeps its flag through storage; an ordinary one has none", () => {
  addPendingToken("https://unfamiliar.example", "cashuAheld", 21, undefined, { held: true });
  addPendingToken("https://mint.example", "cashuAplain", 5);
  const [held, plain] = listPendingTokens();
  expect(held.held).toBe(true);
  expect(plain.held).toBeUndefined();
});

test("payments are claimed automatically only at the active mint or a tracked one", () => {
  addMintToList("https://tracked.example/");
  expect(isKnownMint("https://active.example/", "https://active.example")).toBe(true);
  expect(isKnownMint("https://tracked.example", "https://active.example")).toBe(true);
  expect(isKnownMint(null, "https://active.example")).toBe(true);
  expect(isKnownMint("https://attacker.example", "https://active.example")).toBe(false);
});
