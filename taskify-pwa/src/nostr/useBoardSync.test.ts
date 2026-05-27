import { expect, test } from "vitest";
import { buildBoardSyncFilters } from "./useBoardSync";

test("full-history board sync omits since filters", () => {
  const filters = buildBoardSyncFilters({
    bTag: "board-tag",
    cursor: 1_700_000_000,
    fullHistory: true,
    nowSecs: 1_800_000_000,
  });

  expect(filters[0]).toMatchObject({ kinds: [30300, 30301], "#b": ["board-tag"] });
  expect(filters[0]).not.toHaveProperty("since");
  expect(filters[2]).toMatchObject({ kinds: [30310], "#b": ["board-tag"] });
  expect(filters[2]).not.toHaveProperty("since");
});

test("cursor board sync uses a short lookback window", () => {
  const filters = buildBoardSyncFilters({
    bTag: "board-tag",
    cursor: 1_700_000_000,
    nowSecs: 1_800_000_000,
  });

  expect(filters[0]).toHaveProperty("since", 1_699_999_700);
  expect(filters[2]).toHaveProperty("since", 1_699_999_700);
});

test("first board sync without a cursor uses the default recent window", () => {
  const filters = buildBoardSyncFilters({
    bTag: "board-tag",
    nowSecs: 1_800_000_000,
  });

  expect(filters[0]).toHaveProperty("since", 1_797_408_000);
  expect(filters[2]).toHaveProperty("since", 1_797_408_000);
});
