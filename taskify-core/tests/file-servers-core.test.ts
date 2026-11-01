import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fixedFileUploadRoute,
  fixedFileUploadURL,
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
