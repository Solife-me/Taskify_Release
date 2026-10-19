import { expect, test } from "vitest";
import { mergeExternallyAddedHistory, type HistoryItem } from "./walletHistoryTypes";

const item = (id: string) => ({ id, summary: id }) as HistoryItem;

test("entries another part of the app stored are kept when the open wallet saves its history", () => {
  const current = [item("b"), item("a")];
  expect(mergeExternallyAddedHistory(current, [item("c"), item("b"), item("a")]).map((i) => i.id)).toEqual(["c", "b", "a"]);
  expect(mergeExternallyAddedHistory(current, [item("b")])).toBe(current);
});
