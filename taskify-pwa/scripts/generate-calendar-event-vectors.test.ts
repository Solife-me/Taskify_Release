/**
 * Writes taskify-core/fixtures/calendar-event-vectors-pwa.json. Run on request:
 *   WRITE_CALENDAR_VECTORS=1 npx vitest run scripts/generate-calendar-event-vectors.test.ts
 * Regenerating changes every ciphertext and signature; the expectations stay the same.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { CALENDAR_CASES, pwaCalendarEvent, VECTOR_BOARDS, type CalendarVector } from "../src/nostr/calendarEventVectorSupport";

test.runIf(process.env.WRITE_CALENDAR_VECTORS === "1")("write the PWA's calendar event vectors", async () => {
  const vectors: CalendarVector[] = [];
  let createdAt = 1_792_450_000;
  for (const entry of CALENDAR_CASES) {
    const event = await pwaCalendarEvent(entry.event, VECTOR_BOARDS[entry.board], createdAt++);
    vectors.push({ name: entry.name, board: entry.board, event, expected: entry.expected });
  }
  const path = fileURLToPath(new URL("../../taskify-core/fixtures/calendar-event-vectors-pwa.json", import.meta.url));
  writeFileSync(
    path,
    `${JSON.stringify({ description: "Calendar events (canonical copies) made by the PWA, and what every client must decode them to. Checked by PWA vitest and Swift CalendarEventVectorTests.", boards: VECTOR_BOARDS, vectors }, null, 2)}\n`,
  );
});
