/**
 * Requests for the Worker's public lookups. The link or name looked up goes in a POST body,
 * never in the URL, which the Worker's request logs record (C13-8).
 */
type LookupRequest = [url: string, init: RequestInit];

function lookup(base: string, path: string, body: Record<string, string>): LookupRequest {
  return [
    `${base.trim().replace(/\/$/, "")}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
  ];
}

export function previewLookupRequest(base: string, url: string): LookupRequest {
  return lookup(base, "/api/preview", { url });
}

export function nip05LookupRequest(base: string, address: string): LookupRequest {
  return lookup(base, "/api/nip05", { address });
}
