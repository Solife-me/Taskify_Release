import { afterEach, expect, test, vi } from "vitest";
import { urlBase64ToUint8Array } from "./vapidKey";
afterEach(() => vi.unstubAllGlobals());

test("decodes URL-safe unpadded VAPID keys without changing bytes", () => {
  const bytes = Uint8Array.from({ length: 65 }, (_, i) => (i * 7 + 240) % 256);
  const encoded = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  expect(urlBase64ToUint8Array(encoded)).toEqual(bytes);
});
test("reports missing, malformed, and short keys", () => {
  expect(() => urlBase64ToUint8Array("")).toThrow("VAPID public key is missing");
  expect(() => urlBase64ToUint8Array("%%%!")).toThrow("Invalid VAPID public key");
  expect(() => urlBase64ToUint8Array(btoa("short"))).toThrow("Decoded key is too short");
});
test("reports unavailable decoding support", () => {
  vi.stubGlobal("atob", undefined);
  expect(() => urlBase64ToUint8Array("AAAA")).toThrow("No base64 decoder available");
});
