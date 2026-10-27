import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  formatTaskifyAppLink,
  formatTaskifyWebPath,
  parseTaskifyAppLink,
  parseTaskifyWebPath,
  type TaskifyLink,
} from "../dist/index.js";

type LinkVector = {
  name: string;
  destination: TaskifyLink;
  appURL: string;
  webPath: string;
};

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/taskify-link-vectors.json", import.meta.url), "utf8"),
) as {
  vectors: LinkVector[];
  invalidAppURLs: string[];
  invalidWebPaths: string[];
};

// TaskifyWidgetLinkTests.swift reads this same file, so native widgets and web entry points cannot
// silently drift to different destination names or query fields.
for (const vector of fixture.vectors) {
  test(`Taskify link vector: ${vector.name}`, () => {
    assert.equal(formatTaskifyAppLink(vector.destination), vector.appURL);
    assert.deepEqual(parseTaskifyAppLink(vector.appURL), vector.destination);
    assert.equal(formatTaskifyWebPath(vector.destination), vector.webPath);
    assert.deepEqual(parseTaskifyWebPath(vector.webPath), vector.destination);
  });
}

test("invalid app URLs are rejected", () => {
  for (const raw of fixture.invalidAppURLs) assert.equal(parseTaskifyAppLink(raw), null, raw);
});

test("invalid web paths are rejected", () => {
  for (const raw of fixture.invalidWebPaths) assert.equal(parseTaskifyWebPath(raw), null, raw);
});

test("incoming query values are trimmed like the native parser", () => {
  assert.deepEqual(parseTaskifyAppLink("taskify://task?id=%20t1%20&board=%20b1%20"), {
    kind: "task",
    id: "t1",
    boardId: "b1",
  });
  assert.deepEqual(parseTaskifyWebPath("/quick-add?board=%20b1%20&column=%20%20"), {
    kind: "quick-add",
    boardId: "b1",
  });
});
