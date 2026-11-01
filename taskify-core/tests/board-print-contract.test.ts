import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BOARD_PRINT_CONTRACT_VERSION,
  BOARD_PRINT_MAX_PAGES,
  BOARD_PRINT_LAYOUT_MM,
  BOARD_PRINT_PAPER_MM,
  boardPrintHash32,
  boardPrintJobCode,
  boardPrintJobCodePattern,
  boardPrintPagePattern,
  isSupportedBoardPrintVersion,
} from "../dist/index.js";

type VectorFile = {
  version: string;
  papers: Record<string, { widthMm: number; heightMm: number }>;
  layout: Record<string, number>;
  jobs: Array<{ id: string; hash32: number; code: number; pattern: number[] }>;
  maxPages: number;
  pagePatterns: number[][];
};

const vectors = JSON.parse(readFileSync(
  new URL("../fixtures/board-print-contract-vectors.json", import.meta.url),
  "utf8",
)) as VectorFile;

test("board print contract matches the shared TS/Swift vectors", () => {
  assert.equal(BOARD_PRINT_CONTRACT_VERSION, vectors.version);
  assert.deepEqual(BOARD_PRINT_PAPER_MM, vectors.papers);
  assert.equal(BOARD_PRINT_MAX_PAGES, vectors.maxPages);
  assert.deepEqual(BOARD_PRINT_LAYOUT_MM, vectors.layout);
  for (const job of vectors.jobs) {
    assert.equal(boardPrintHash32(job.id), job.hash32, job.id);
    assert.equal(boardPrintJobCode(job.id), job.code, job.id);
    assert.deepEqual(boardPrintJobCodePattern(job.id), job.pattern, job.id);
  }
  assert.deepEqual(boardPrintPagePattern(0), vectors.pagePatterns[0]);
  assert.deepEqual(boardPrintPagePattern(4), vectors.pagePatterns[4]);
  assert.deepEqual(boardPrintPagePattern(62), vectors.pagePatterns[62]);
});

test("only versioned print layouts with safe legacy fallback are accepted", () => {
  assert.equal(isSupportedBoardPrintVersion("v3"), true);
  assert.equal(isSupportedBoardPrintVersion("v2"), true);
  assert.equal(isSupportedBoardPrintVersion("v1"), true);
  assert.equal(isSupportedBoardPrintVersion("v4"), false);
  assert.equal(isSupportedBoardPrintVersion(null), false);
});
