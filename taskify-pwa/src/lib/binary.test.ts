import { describe, expect, test } from "vitest";
import { readResponseBytesWithProgress } from "./binary";

function streamedResponse(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  }), { headers });
}

describe("readResponseBytesWithProgress", () => {
  test("reports byte progress when Content-Length is available", async () => {
    const updates: Array<{ loaded: number; total: number | null; fraction: number | null }> = [];
    const response = streamedResponse(
      [new TextEncoder().encode("abc"), new TextEncoder().encode("def")],
      { "content-length": "6" },
    );
    const bytes = await readResponseBytesWithProgress(response, (progress) => updates.push(progress));
    expect(new TextDecoder().decode(bytes)).toBe("abcdef");
    expect(updates[0]).toEqual({ loaded: 0, total: 6, fraction: 0 });
    expect(updates.some((update) => update.loaded === 3 && update.fraction === 0.5)).toBe(true);
    expect(updates.at(-1)).toEqual({ loaded: 6, total: 6, fraction: 1 });
  });

  test("keeps an indeterminate fraction when the server omits Content-Length", async () => {
    const updates: Array<{ loaded: number; total: number | null; fraction: number | null }> = [];
    const response = streamedResponse([new TextEncoder().encode("opaque")]);
    const bytes = await readResponseBytesWithProgress(response, (progress) => updates.push(progress));
    expect(new TextDecoder().decode(bytes)).toBe("opaque");
    expect(updates[0]).toEqual({ loaded: 0, total: null, fraction: null });
    expect(updates.at(-1)).toEqual({ loaded: 6, total: 6, fraction: 1 });
  });
});
