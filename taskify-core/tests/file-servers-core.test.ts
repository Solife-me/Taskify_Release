import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fixedFileUploadRoute,
  fixedFileUploadURL,
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

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/file-server-upload-vectors.json", import.meta.url), "utf8"),
) as { routes: RouteVector[]; responses: ResponseVector[] };

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
