/**
 * Writes taskify-core/fixtures/task-event-vectors-pwa.json. Run on request:
 *   WRITE_TASK_VECTORS=1 npx vitest run scripts/generate-task-event-vectors.test.ts
 * Regenerating changes every ciphertext and signature; the expectations stay the same.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { CASES, pwaEvent, VECTOR_BOARDS, type Vector } from "../src/nostr/taskEventVectorSupport";

test.runIf(process.env.WRITE_TASK_VECTORS === "1")("write the PWA's task event vectors", async () => {
  const vectors: Vector[] = [];
  let createdAt = 1_792_400_000;
  for (const entry of CASES) {
    const event = await pwaEvent(entry.task, VECTOR_BOARDS[entry.board], entry.status, createdAt++);
    vectors.push({ name: entry.name, board: entry.board, event, expected: { id: entry.task.id, status: entry.status, ...entry.expected } });
  }
  const path = fileURLToPath(new URL("../../taskify-core/fixtures/task-event-vectors-pwa.json", import.meta.url));
  writeFileSync(
    path,
    `${JSON.stringify({ description: "Task events made by the PWA, and what every client must decode them to. Checked by PWA vitest and Swift TaskEventVectorTests.", boards: VECTOR_BOARDS, vectors }, null, 2)}\n`,
  );
});
