import { describe, expect, it } from "vitest";
import {
  inlineMarkdownFromRuns,
  markdownFromNoteLines,
  noteLineText,
  noteLinesFromMarkdown,
  type NoteLine,
} from "../src/domains/tasks/noteMarkdown";

// The same cases run against the native port in
// taskify-ios-native/Tests/TaskifyCoreTests/TaskNoteDocumentTests.swift.

describe("note document", () => {
  it("round-trips canonical notes unchanged", () => {
    const note = [
      "# Plan",
      "Buy **milk** and *eggs*, then ~~skip~~ `code` [site](https://example.com)",
      "",
      "- one",
      "  - nested",
      "1. first",
      "2. second",
      "- [ ] open",
      "- [x] done",
      "> quoted",
      "---",
      "```",
      "code *stays* raw",
      "```",
      "snake_case stays",
    ].join("\n");
    expect(markdownFromNoteLines(noteLinesFromMarkdown(note))).toBe(note);
  });

  it("carries kinds, depths and marks", () => {
    const lines = noteLinesFromMarkdown("## Title\n  - [x] **Done** item\n\n3. third");
    expect(lines.map((line) => line.kind)).toEqual(["heading", "checklist", "paragraph", "numbered"]);
    expect(lines[0].level).toBe(2);
    expect(lines[1]).toMatchObject({ depth: 1, checked: true });
    expect(lines[1].runs).toEqual([{ text: "Done", bold: true }, { text: " item" }]);
    expect(lines[3].number).toBe(3);
  });

  it("escapes typed text that looks like syntax", () => {
    const paragraph = (text: string) => markdownFromNoteLines([{ kind: "paragraph", depth: 0, runs: [{ text }] }]);
    expect(paragraph("- not a list")).toBe("\\- not a list");
    expect(paragraph("1. not numbered")).toBe("1\\. not numbered");
    expect(paragraph("# not a heading")).toBe("\\# not a heading");
    expect(paragraph("a*b [c] `d` \\e")).toBe("a\\*b \\[c\\] \\`d\\` \\\\e");
    expect(paragraph("snake_case and _edge_")).toBe("snake_case and \\_edge\\_");
    for (const text of ["- not a list", "1. not numbered", "a*b [c] `d` \\e", "snake_case and _edge_"]) {
      expect(noteLineText(noteLinesFromMarkdown(paragraph(text))[0])).toBe(text);
    }
  });

  it("nests overlapping marks and keeps spaces outside", () => {
    expect(
      inlineMarkdownFromRuns([
        { text: "bold ", bold: true },
        { text: "both", bold: true, italic: true },
        { text: " plain" },
      ]),
    ).toBe("**bold *both*** plain");
    expect(inlineMarkdownFromRuns([{ text: "go", bold: true, link: "https://a.b/c d" }])).toBe(
      "[**go**](https://a.b/c%20d)",
    );
    expect(inlineMarkdownFromRuns([{ text: "a`b", code: true }])).toBe("``a`b``");
  });

  it("renumbers numbered runs from their first item", () => {
    const lines: NoteLine[] = [
      { kind: "numbered", depth: 0, number: 3, runs: [{ text: "c" }] },
      { kind: "numbered", depth: 0, number: 1, runs: [{ text: "d" }] },
      { kind: "paragraph", depth: 0, runs: [] },
      { kind: "numbered", depth: 0, number: 1, runs: [{ text: "a" }] },
    ];
    expect(markdownFromNoteLines(lines)).toBe("3. c\n4. d\n\n1. a");
  });
});
