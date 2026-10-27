/**
 * Calendar event vectors shared with iOS (C8-5): canonical calendar events, attachments
 * included, and what each must decode to. `calendar-event-vectors-pwa.json` is made by the PWA
 * (scripts/generate-calendar-event-vectors.test.ts) and decoded by Swift
 * (CalendarEventVectorTests); `calendar-event-vectors-ios.json` is made by Swift and decoded here.
 */
import { describe, expect, test } from "vitest";
import pwaVectors from "../../../taskify-core/fixtures/calendar-event-vectors-pwa.json";
import iosVectors from "../../../taskify-core/fixtures/calendar-event-vectors-ios.json";
import { decodeCalendarWithPwa, VECTOR_BOARDS, type CalendarVector } from "./calendarEventVectorSupport";

describe("calendar event vectors", () => {
  for (const [file, data] of [["pwa", pwaVectors], ["ios", iosVectors]] as const) {
    const vectors = (data as unknown as { vectors: CalendarVector[] }).vectors;
    test(`the PWA decodes the ${file} vectors as both clients must`, async () => {
      expect(vectors.length).toBeGreaterThan(0);
      for (const vector of vectors) {
        expect(await decodeCalendarWithPwa(vector.event, VECTOR_BOARDS[vector.board]), vector.name).toEqual(vector.expected);
      }
    });
  }
});
