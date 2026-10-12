import { describe, expect, it } from "vitest";
import {
  applyNoteFormat,
  continueNoteList,
  extractChecklist,
  noteBlocks,
  notePreviewText,
  parseInline,
  toggleChecklistItem,
  type NoteFormat,
} from "../src/domains/tasks/noteMarkdown";

// The same cases run against the native port in
// taskify-ios-native/Tests/TaskifyCoreTests/TaskNoteMarkdownTests.swift.

const edit = (format: NoteFormat, text: string, location: number, length = 0) =>
  applyNoteFormat(format, text, location, location + length);
const result = (text: string, location: number, length = 0) => ({
  text,
  selectionStart: location,
  selectionEnd: location + length,
});

describe("noteBlocks", () => {
  it("parses lists, checklists and headings", () => {
    const note = "# Plan\nBuy milk\nthen bread\n\n- one\n  - nested\n1. first\n- [ ] open\n- [x] done\n> quoted\n---";
    expect(noteBlocks(note)).toEqual([
      { type: "heading", level: 1, content: "Plan" },
      { type: "paragraph", content: "Buy milk\nthen bread" },
      { type: "spacer", lines: 1 },
      { type: "bullet", depth: 0, content: "one" },
      { type: "bullet", depth: 1, content: "nested" },
      { type: "numbered", depth: 0, number: 1, content: "first" },
      { type: "checklist", depth: 0, checked: false, content: "open", line: 7 },
      { type: "checklist", depth: 0, checked: true, content: "done", line: 8 },
      { type: "quote", content: "quoted" },
      { type: "rule" },
    ]);
  });

  it("keeps skipped rows between blocks only", () => {
    expect(noteBlocks("\n\nFirst\n\n\n\nSecond\n- item\n \n\n")).toEqual([
      { type: "paragraph", content: "First" },
      { type: "spacer", lines: 3 },
      { type: "paragraph", content: "Second" },
      { type: "bullet", depth: 0, content: "item" },
    ]);
    expect(noteBlocks("```\na\n\nb\n```")).toEqual([{ type: "code", content: "a\n\nb" }]);
    expect(notePreviewText("One\n\n\nTwo")).toBe("One\nTwo");
  });

  it("ignores checklists inside code and hashtags", () => {
    expect(noteBlocks("#nostr tag\n```\n- [ ] not an item\n```\n- [ ] real")).toEqual([
      { type: "paragraph", content: "#nostr tag" },
      { type: "code", content: "- [ ] not an item" },
      { type: "checklist", depth: 0, checked: false, content: "real", line: 4 },
    ]);
  });
});

describe("checklists", () => {
  it("toggles only the requested box", () => {
    const note = "- [ ] a\r\n- [X] b\n```\n- [ ] code\n```";
    expect(toggleChecklistItem(note, 0)).toBe("- [x] a\r\n- [X] b\n```\n- [ ] code\n```");
    expect(toggleChecklistItem(note, 1)).toBe("- [ ] a\r\n- [ ] b\n```\n- [ ] code\n```");
    expect(toggleChecklistItem(note, 3)).toBeNull();
    expect(toggleChecklistItem(note, 99)).toBeNull();
  });

  it("moves items to subtasks", () => {
    let id = 0;
    const extracted = extractChecklist("Intro\n\n- [ ] **Milk**\n- [x] Eggs\n- [ ]\n\nOutro", () => `s${++id}`);
    expect(extracted.note).toBe("Intro\n\nOutro");
    expect(extracted.subtasks).toEqual([
      { id: "s1", title: "Milk", completed: false },
      { id: "s2", title: "Eggs", completed: true },
    ]);
    expect(extractChecklist("- [ ] only").note).toBe("");
  });
});

describe("notePreviewText", () => {
  it("strips syntax and marks items", () => {
    const note = "## Shopping\n- [ ] **milk**\n- [x] [eggs](https://example.com)\n* bread\n\n\n> calm _down_";
    expect(notePreviewText(note)).toBe("Shopping\n☐ milk\n☑ eggs\n• bread\ncalm down");
  });
});

describe("parseInline", () => {
  it("keeps snake_case and unmatched markers literal", () => {
    expect(parseInline("snake_case_name and 2 * 3")).toEqual([{ type: "text", text: "snake_case_name and 2 * 3" }]);
  });

  it("nests emphasis inside links and bold-italic runs", () => {
    expect(parseInline("[**go**](https://a.b) ***both***")).toEqual([
      { type: "link", href: "https://a.b", children: [{ type: "strong", children: [{ type: "text", text: "go" }] }] },
      { type: "text", text: " " },
      { type: "strong", children: [{ type: "em", children: [{ type: "text", text: "both" }] }] },
    ]);
  });
});

describe("applyNoteFormat", () => {
  it("wraps, toggles and expands inline formats to the word", () => {
    expect(edit("bold", "make bold", 5, 4)).toEqual(result("make **bold**", 7, 4));
    expect(edit("bold", "make **bold**", 7, 4)).toEqual(result("make bold", 5, 4));
    expect(edit("bold", "make **bold**", 5, 8)).toEqual(result("make bold", 5, 4));
    expect(edit("italic", "**bold**", 2, 4)).toEqual(result("***bold***", 3, 4));
    expect(edit("italic", "***bold***", 3, 4)).toEqual(result("**bold**", 2, 4));
    expect(edit("strikethrough", "wo", 1)).toEqual(result("~~wo~~", 2, 2));
    expect(edit("bold", "a ", 2)).toEqual(result("a ****", 4));
    expect(edit("code", " x ", 0, 3)).toEqual(result(" `x` ", 2, 1));
  });

  it("selects the URL placeholder of a new link", () => {
    expect(edit("link", "see docs", 4, 4)).toEqual(result("see [docs](https://)", 11, 8));
    expect(edit("link", "", 0)).toEqual(result("[](https://)", 1));
  });

  it("toggles block formats and replaces other markers", () => {
    expect(edit("bulletList", "milk", 4)).toEqual(result("- milk", 6));
    expect(edit("bulletList", "- milk", 6)).toEqual(result("milk", 4));
    expect(edit("checklist", "- milk", 6)).toEqual(result("- [ ] milk", 10));
    expect(edit("numberedList", "a\n\nb", 0, 4)).toEqual(result("1. a\n\n2. b", 0, 10));
    expect(edit("numberedList", "1. a\nb", 6)).toEqual(result("1. a\n2. b", 9));
    expect(edit("heading", "Title", 0).text).toBe("# Title");
    expect(edit("heading", "# Title", 0).text).toBe("## Title");
    expect(edit("heading", "### Title", 0).text).toBe("Title");
    expect(edit("quote", "x\ny", 0, 3).text).toBe("> x\n> y");
    expect(edit("bulletList", "  - [x] keep indent", 0).text).toBe("  - keep indent");
    expect(edit("bulletList", "\nmilk", 0).text).toBe("- \nmilk");
  });
});

describe("continueNoteList", () => {
  const enter = (text: string) => continueNoteList(text, text.length, text.length);

  it("continues or ends lists", () => {
    expect(enter("- [x] milk")).toEqual(result("- [x] milk\n- [ ] ", 17));
    expect(enter("  * a")).toEqual(result("  * a\n  * ", 10));
    expect(enter("9) a")).toEqual(result("9) a\n10) ", 9));
    expect(enter("x\n- ")).toEqual(result("x\n", 2));
    expect(enter("plain")).toBeNull();
  });
});
