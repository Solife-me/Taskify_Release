/**
 * Task event vectors shared with iOS (C7-3): real signed, board-encrypted task events, and what
 * each must decode to. `task-event-vectors-pwa.json` is made by the PWA
 * (scripts/generate-task-event-vectors.test.ts) and decoded by Swift (TaskEventVectorTests);
 * `task-event-vectors-ios.json` is made by Swift and decoded here. Fields only the other client
 * uses must survive a republish.
 */
import { describe, expect, test } from "vitest";
import pwaVectors from "../../../taskify-core/fixtures/task-event-vectors-pwa.json";
import iosVectors from "../../../taskify-core/fixtures/task-event-vectors-ios.json";
import { decodeWithPwa, VECTOR_BOARDS, type Vector } from "./taskEventVectorSupport";

describe("task event vectors", () => {
  for (const [file, data] of [["pwa", pwaVectors], ["ios", iosVectors]] as const) {
    const vectors = (data as unknown as { vectors: Vector[] }).vectors;
    test(`the PWA decodes the ${file} vectors as both clients must`, async () => {
      expect(vectors.length).toBeGreaterThan(0);
      for (const vector of vectors) {
        expect(await decodeWithPwa(vector.event, VECTOR_BOARDS[vector.board]), vector.name).toEqual(vector.expected);
      }
    });
  }
});
