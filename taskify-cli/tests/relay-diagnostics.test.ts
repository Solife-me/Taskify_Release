import test from "node:test";
import assert from "node:assert/strict";
import { checkRelay } from "../src/relayDiagnostics.ts";

for (const mode of ["open", "error", "timeout", "throw"] as const) {
  test(`relay diagnostic handles ${mode} without a real connection`, async (t) => {
    const original = globalThis.WebSocket;
    let closes = 0;
    class FakeSocket {
      onopen?: () => void;
      onerror?: () => void;
      constructor(url: string) {
        assert.equal(url, "wss://example.test");
        if (mode === "throw") throw new Error("Invalid socket");
        queueMicrotask(() => {
          if (mode === "open") this.onopen?.();
          if (mode === "error") this.onerror?.();
        });
      }
      close() { closes++; }
    }
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    t.after(() => { globalThis.WebSocket = original; });
    assert.equal(await checkRelay("wss://example.test", 5), mode === "open");
    assert.equal(closes, mode === "open" || mode === "timeout" ? 1 : 0);
  });
}
