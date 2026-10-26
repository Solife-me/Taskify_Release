import { expect, test } from "vitest";
import { nip05LookupRequest, previewLookupRequest } from "./workerLookups";

// The Worker's request logs show URLs, so the link or name looked up travels in the body (C13-8).
test("a link preview is asked for with the link in the body, not the URL", async () => {
  const link = "https://example.com/private/path?token=secret";
  const [url, init] = previewLookupRequest("https://taskify.test", link);
  expect(url).toBe("https://taskify.test/api/preview");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body as string)).toEqual({ url: link });
  expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  expect(url).not.toContain("example.com");
});

test("a NIP-05 name is looked up with the name in the body, not the URL", () => {
  const [url, init] = nip05LookupRequest("https://taskify.test/", "alice@example.com");
  expect(url).toBe("https://taskify.test/api/nip05");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body as string)).toEqual({ address: "alice@example.com" });
  expect(url).not.toContain("alice");
});
