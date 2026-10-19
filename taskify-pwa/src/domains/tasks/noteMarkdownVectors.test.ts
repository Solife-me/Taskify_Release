/**
 * Note Markdown must parse and edit the same on the web and iOS. These vectors are shared with
 * TaskifyCoreTests (Swift, `NoteMarkdownVectorTests`); regenerate them from this module only when
 * a change is intended on both sides.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  applyNoteFormat,
  continueNoteList,
  noteBlocks,
  notePreviewText,
  toggleChecklistItem,
  type NoteFormat,
} from "./noteMarkdown";

type Vectors = {
  blocks: Array<{ name: string; note: string; expected: unknown }>;
  toggles: Array<{ name: string; note: string; line: number; expected: string | null }>;
  continueList: Array<{ name: string; text: string; selectionStart: number; selectionEnd: number; expected: unknown }>;
  formats: Array<{ name: string; format: NoteFormat; text: string; selectionStart: number; selectionEnd: number; expected: unknown }>;
  previews: Array<{ name: string; note: string; expected: string }>;
};

const vectors = JSON.parse(
  readFileSync(new URL("../../../../taskify-core/fixtures/note-markdown-vectors.json", import.meta.url), "utf8"),
) as Vectors;

describe("note Markdown matches the shared vectors", () => {
  test.each(vectors.blocks)("blocks: $name", ({ note, expected }) => {
    expect(noteBlocks(note)).toEqual(expected);
  });
  test.each(vectors.toggles)("toggle: $name", ({ note, line, expected }) => {
    expect(toggleChecklistItem(note, line)).toEqual(expected);
  });
  test.each(vectors.continueList)("continue: $name", ({ text, selectionStart, selectionEnd, expected }) => {
    expect(continueNoteList(text, selectionStart, selectionEnd)).toEqual(expected);
  });
  test.each(vectors.formats)("format: $name", ({ format, text, selectionStart, selectionEnd, expected }) => {
    expect(applyNoteFormat(format, text, selectionStart, selectionEnd)).toEqual(expected);
  });
  test.each(vectors.previews)("preview: $name", ({ note, expected }) => {
    expect(notePreviewText(note)).toBe(expected);
  });
});
