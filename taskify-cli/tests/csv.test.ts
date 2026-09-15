import test from "node:test";
import assert from "node:assert/strict";
import { csvEscape, parseCSV } from "../src/csv.ts";

test("CSV exporter quotes delimiters, quotes, and newlines", () => {
  assert.equal(csvEscape("simple"), "simple");
  assert.equal(csvEscape(""), "");
  assert.equal(csvEscape('a,"b"'), '"a,""b"""');
  assert.equal(csvEscape("a\nb"), '"a\nb"');
});
test("CSV importer preserves quoted commas and escaped quotes", () => {
  const title = 'Buy apples, "green"';
  assert.deepEqual(parseCSV(`id,title,note\r\n1,${csvEscape(title)},\r\n`), [{ id: "1", title, note: "" }]);
});
test("CSV importer handles blank lines, trimmed headers and missing columns", () => {
  assert.deepEqual(parseCSV(" id , title ,note\n\n1, Task\n2,Other, note \n"), [
    { id: "1", title: "Task", note: "" }, { id: "2", title: "Other", note: "note" },
  ]);
  assert.deepEqual(parseCSV("id,title\n"), []);
  assert.deepEqual(parseCSV(""), []);
});
