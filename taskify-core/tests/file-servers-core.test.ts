import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fetchWithIPFSGatewayFallback,
  fixedFileUploadRoute,
  fixedFileUploadURL,
  ipfsRetrievalCandidates,
  opaqueUploadFilename,
  resolveOriginlessUploadURL,
  type FixedFileUploadServerType,
} from "../dist/index.js";

type RouteVector = {
  name: string;
  type: FixedFileUploadServerType;
  serverURL: string;
  method: "POST" | "PUT";
  uploadURL: string;
};

type ResponseVector = {
  name: string;
  serverURL: string;
  payload: Record<string, unknown>;
  remoteURL: string;
};

type OpaqueUploadVector = {
  name: string;
  sha256: string;
  filename: string;
};

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/file-server-upload-vectors.json", import.meta.url), "utf8"),
) as { opaqueUploads: OpaqueUploadVector[]; routes: RouteVector[]; responses: ResponseVector[] };

for (const vector of fixture.opaqueUploads) {
  test(`opaque upload filename: ${vector.name}`, () => {
    assert.equal(opaqueUploadFilename(vector.sha256), vector.filename);
  });
}

test("opaque upload filenames reject anything except a SHA-256 digest", () => {
  assert.throws(() => opaqueUploadFilename("contract-final.pdf"), /SHA-256/);
  assert.throws(() => opaqueUploadFilename("a".repeat(63)), /SHA-256/);
  assert.throws(() => opaqueUploadFilename(`${"a".repeat(63)}z`), /SHA-256/);
});

for (const vector of fixture.routes) {
  test(`file upload route: ${vector.name}`, () => {
    assert.equal(fixedFileUploadRoute(vector.type).method, vector.method);
    assert.equal(fixedFileUploadURL(vector.serverURL, vector.type), vector.uploadURL);
  });
}

for (const vector of fixture.responses) {
  test(`Originless upload response: ${vector.name}`, () => {
    assert.equal(resolveOriginlessUploadURL(vector.serverURL, vector.payload), vector.remoteURL);
  });
}

const CID = "QmS5cF4AsRFFvHZW8pRRVk7XxN516jqcTeXMYwFJwRgWc1";
const LIVE_GATEWAYS = [`https://ipfs.filebase.io/ipfs/${CID}`, `https://gateway.pinata.cloud/ipfs/${CID}`];

test("retired IPFS gateway URLs resolve to live gateways only", () => {
  for (const url of [
    `https://dweb.link/ipfs/${CID}`,
    `https://ipfs.io/ipfs/${CID}`,
    `https://gateway.ipfs.io/ipfs/${CID}`,
    `https://w3s.link/ipfs/${CID}`,
  ]) {
    assert.deepEqual(ipfsRetrievalCandidates(url), LIVE_GATEWAYS);
  }
  const v1 = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
  assert.deepEqual(ipfsRetrievalCandidates(`https://${v1}.ipfs.dweb.link/`), [
    `https://ipfs.filebase.io/ipfs/${v1}`,
    `https://gateway.pinata.cloud/ipfs/${v1}`,
  ]);
});

test("a live IPFS gateway is tried first, without duplicates", () => {
  assert.deepEqual(ipfsRetrievalCandidates(LIVE_GATEWAYS[1]), [LIVE_GATEWAYS[1], LIVE_GATEWAYS[0]]);
  const custom = `https://my.gateway.example/ipfs/${CID}`;
  assert.deepEqual(ipfsRetrievalCandidates(custom), [custom, ...LIVE_GATEWAYS]);
});

test("non-IPFS URLs are left alone", () => {
  for (const url of ["https://nostr.build/i/photo.jpg", "https://files.example/ipfs/short", "not a url"]) {
    assert.deepEqual(ipfsRetrievalCandidates(url), [url]);
  }
});

test("gateway fallback moves past HTTP and network failures", async () => {
  const tried: string[] = [];
  const response = await fetchWithIPFSGatewayFallback(`https://dweb.link/ipfs/${CID}`, {}, (async (input: RequestInfo | URL) => {
    tried.push(String(input));
    if (tried.length === 1) throw new TypeError("network");
    return new Response("bytes", { status: 200 });
  }) as typeof fetch);
  assert.deepEqual(tried, LIVE_GATEWAYS);
  assert.equal(await response.text(), "bytes");
});

test("gateway fallback reports the last failed response", async () => {
  const response = await fetchWithIPFSGatewayFallback(`https://dweb.link/ipfs/${CID}`, {}, (async () =>
    new Response("nope", { status: 502 })) as typeof fetch);
  assert.equal(response.status, 502);
});

test("gateway fallback stops when the caller aborts", async () => {
  const controller = new AbortController();
  let attempts = 0;
  await assert.rejects(() =>
    fetchWithIPFSGatewayFallback(`https://dweb.link/ipfs/${CID}`, { signal: controller.signal }, (async () => {
      attempts += 1;
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    }) as typeof fetch));
  assert.equal(attempts, 1);
});
