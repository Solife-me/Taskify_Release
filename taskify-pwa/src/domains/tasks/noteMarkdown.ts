// Task notes are Markdown: headings, bullet and numbered lists, GitHub-style checklist items
// (`- [ ] item`), quotes, fenced code and horizontal rules, with inline bold, italic,
// strikethrough, code and links. Raw HTML is not interpreted. A single newline is a line break,
// as notes were plain text before they were Markdown.
//
// Mirrors taskify-ios-native/Sources/TaskifyCore/Models/TaskNoteMarkdown.swift; keep the two in
// step so a note reads and edits the same on every client. Offsets are UTF-16, as in the
// browser's textarea selection.

import type { Subtask } from "./taskTypes";

export type NoteBlock =
  | { type: "paragraph"; content: string }
  | { type: "heading"; level: number; content: string }
  | { type: "bullet"; depth: number; content: string }
  | { type: "numbered"; depth: number; number: number; content: string }
  /** `line` is the item's zero-based line in the note: the handle `toggleChecklistItem` takes. */
  | { type: "checklist"; depth: number; checked: boolean; content: string; line: number }
  | { type: "quote"; content: string }
  | { type: "code"; content: string }
  | { type: "rule" };

export type NoteFormat =
  | "bold"
  | "italic"
  | "strikethrough"
  | "code"
  | "link"
  | "heading"
  | "bulletList"
  | "numberedList"
  | "checklist"
  | "quote";

export type NoteEdit = { text: string; selectionStart: number; selectionEnd: number };

type LineKind =
  | { kind: "plain" }
  | { kind: "heading"; level: number }
  | { kind: "bullet"; marker: string }
  | { kind: "numbered"; number: number; delimiter: string }
  /** `marker` is the list marker before the box: `-`, `*`, `+` or a number like `3.`. */
  | { kind: "checklist"; checked: boolean; marker: string }
  | { kind: "quote" };

type LineInfo = {
  indent: string;
  depth: number;
  kind: LineKind;
  content: string;
  /** Where the content starts: the length of indentation plus marker. */
  prefixLength: number;
  /** The offset of the character inside `[ ]` on a checklist line. */
  checkbox: number | null;
};

type Fence = { marker: string; count: number };

const isBlank = (line: string) => /^\s*$/.test(line);
const stripCarriageReturn = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line);
const linesOf = (note: string) => note.split("\n");
/** The start of the line holding `index`. */
const lineStartBefore = (text: string, index: number) => (index <= 0 ? 0 : text.lastIndexOf("\n", index - 1) + 1);

function lineInfo(line: string): LineInfo {
  let columns = 0;
  let index = 0;
  while (index < line.length && (line[index] === " " || line[index] === "\t")) {
    columns += line[index] === "\t" ? 4 : 1;
    index += 1;
  }
  const indent = line.slice(0, index);
  const rest = line.slice(index);
  const base: LineInfo = {
    indent,
    depth: Math.floor(columns / 2),
    kind: { kind: "plain" },
    content: rest,
    prefixLength: index,
    checkbox: null,
  };

  const hashes = /^#{1,6}(?= |$)/.exec(rest);
  if (hashes) {
    const level = hashes[0].length;
    const after = rest.slice(level);
    const trimmed = after.replace(/^ +/, "");
    return {
      ...base,
      kind: { kind: "heading", level },
      content: trimmed.replace(/^[ \t]+|[ \t]+$/g, ""),
      prefixLength: index + level + (after.length - trimmed.length),
    };
  }
  if (rest.startsWith(">")) {
    const after = rest.slice(1).replace(/^ /, "");
    return { ...base, kind: { kind: "quote" }, content: after, prefixLength: index + (rest.length - after.length) };
  }

  const marker = /^(?:([-*+])|(\d{1,9})([.)]))(?: |$)/.exec(rest);
  if (!marker) return base;
  const markerText = marker[1] ?? `${marker[2]}${marker[3]}`;
  const afterMarkerStart = marker[0].length;
  const afterMarker = rest.slice(afterMarkerStart);
  const box = /^\[([ xX])\](?: |$)/.exec(afterMarker);
  if (box) {
    return {
      ...base,
      kind: { kind: "checklist", checked: box[1] !== " ", marker: markerText },
      content: afterMarker.slice(box[0].length),
      prefixLength: index + afterMarkerStart + box[0].length,
      checkbox: index + afterMarkerStart + 1,
    };
  }
  return {
    ...base,
    kind: marker[1]
      ? { kind: "bullet", marker: marker[1] }
      : { kind: "numbered", number: Number(marker[2]), delimiter: marker[3] },
    content: afterMarker,
    prefixLength: index + afterMarkerStart,
  };
}

function openingFence(line: string): Fence | null {
  const trimmed = line.replace(/^ +/, "");
  const marker = trimmed[0];
  if (marker !== "`" && marker !== "~") return null;
  let count = 0;
  while (trimmed[count] === marker) count += 1;
  if (count < 3) return null;
  // A backtick fence's info string may not contain backticks (CommonMark).
  if (marker === "`" && trimmed.slice(count).includes("`")) return null;
  return { marker, count };
}

function closesFence(line: string, fence: Fence): boolean {
  const trimmed = line.replace(/^[ \t]+|[ \t]+$/g, "");
  let count = 0;
  while (trimmed[count] === fence.marker) count += 1;
  return count >= fence.count && count === trimmed.length;
}

function isThematicBreak(line: string): boolean {
  const compact = line.replace(/[ \t]/g, "");
  if (compact.length < 3 || !"-*_".includes(compact[0])) return false;
  return [...compact].every((character) => character === compact[0]);
}

// MARK: Reading

export function noteBlocks(note: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  let code: string[] = [];
  let fence: Fence | null = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", content: paragraph.join("\n") });
    paragraph = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    blocks.push({ type: "quote", content: quote.join("\n") });
    quote = [];
  };

  linesOf(note).forEach((rawLine, index) => {
    const line = stripCarriageReturn(rawLine);
    if (fence) {
      if (closesFence(line, fence)) {
        blocks.push({ type: "code", content: code.join("\n") });
        code = [];
        fence = null;
      } else {
        code.push(line);
      }
      return;
    }
    const open = openingFence(line);
    if (open) {
      flushParagraph();
      flushQuote();
      fence = open;
      return;
    }
    if (isBlank(line)) {
      flushParagraph();
      flushQuote();
      return;
    }
    if (isThematicBreak(line)) {
      flushParagraph();
      flushQuote();
      blocks.push({ type: "rule" });
      return;
    }
    const info = lineInfo(line);
    if (info.kind.kind === "quote") {
      flushParagraph();
      quote.push(info.content);
      return;
    }
    flushQuote();
    switch (info.kind.kind) {
      case "plain":
        paragraph.push(info.content);
        break;
      case "heading":
        flushParagraph();
        if (info.content) blocks.push({ type: "heading", level: info.kind.level, content: info.content });
        break;
      case "bullet":
        flushParagraph();
        blocks.push({ type: "bullet", depth: info.depth, content: info.content });
        break;
      case "numbered":
        flushParagraph();
        blocks.push({ type: "numbered", depth: info.depth, number: info.kind.number, content: info.content });
        break;
      case "checklist":
        flushParagraph();
        blocks.push({
          type: "checklist",
          depth: info.depth,
          checked: info.kind.checked,
          content: info.content,
          line: index,
        });
        break;
    }
  });
  // An unclosed fence runs to the end of the note, as in CommonMark.
  if (fence) blocks.push({ type: "code", content: code.join("\n") });
  flushParagraph();
  flushQuote();
  return blocks;
}

export function checklistItemCount(note: string): number {
  return noteBlocks(note).filter((block) => block.type === "checklist").length;
}

/** The note with checklist item `line` ticked or unticked, or null when that line is not one. */
export function toggleChecklistItem(note: string, line: number): string | null {
  const isItem = noteBlocks(note).some((block) => block.type === "checklist" && block.line === line);
  if (!isItem) return null;
  const lines = linesOf(note);
  const info = lineInfo(stripCarriageReturn(lines[line]));
  if (info.kind.kind !== "checklist" || info.checkbox === null) return null;
  const box = info.checkbox;
  lines[line] = lines[line].slice(0, box) + (info.kind.checked ? " " : "x") + lines[line].slice(box + 1);
  return lines.join("\n");
}

/**
 * Moves every checklist item out of the note into subtasks, keeping each one's ticked state.
 * Blank lines the removal leaves doubled up are collapsed.
 */
export function extractChecklist(
  note: string,
  makeId: () => string = () => crypto.randomUUID(),
): { note: string; subtasks: Subtask[] } {
  const items = new Map<number, { checked: boolean; content: string }>();
  for (const block of noteBlocks(note)) {
    if (block.type === "checklist") items.set(block.line, { checked: block.checked, content: block.content });
  }
  if (!items.size) return { note, subtasks: [] };

  const kept: string[] = [];
  const subtasks: Subtask[] = [];
  let removedSinceText = false;
  linesOf(note).forEach((line, index) => {
    const item = items.get(index);
    if (item) {
      const title = plainInline(item.content).trim();
      if (title) subtasks.push({ id: makeId(), title, completed: item.checked });
      removedSinceText = true;
      return;
    }
    const blank = isBlank(line);
    if (blank && removedSinceText && (kept.length === 0 || isBlank(kept[kept.length - 1]))) return;
    if (!blank) removedSinceText = false;
    kept.push(line);
  });
  while (kept.length && isBlank(kept[kept.length - 1])) kept.pop();
  while (kept.length && isBlank(kept[0])) kept.shift();
  return { note: kept.join("\n"), subtasks };
}

/**
 * Plain text for compact previews such as a task card: Markdown syntax removed, list items
 * marked with •, ☐ or ☑, and blank lines collapsed.
 */
export function notePreviewText(note: string): string {
  const output: string[] = [];
  const indentation = (depth: number) => "  ".repeat(depth);
  for (const block of noteBlocks(note)) {
    switch (block.type) {
      case "paragraph":
      case "quote":
        output.push(...block.content.split("\n").map(plainInline));
        break;
      case "heading":
        output.push(plainInline(block.content));
        break;
      case "bullet":
        output.push(`${indentation(block.depth)}• ${plainInline(block.content)}`);
        break;
      case "numbered":
        output.push(`${indentation(block.depth)}${block.number}. ${plainInline(block.content)}`);
        break;
      case "checklist":
        output.push(`${indentation(block.depth)}${block.checked ? "☑" : "☐"} ${plainInline(block.content)}`);
        break;
      case "code":
        output.push(block.content);
        break;
      case "rule":
        break;
    }
  }
  return output.filter((line) => !isBlank(line)).join("\n");
}

// MARK: Inline

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "strong" | "em" | "del"; children: InlineNode[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: InlineNode[] };

const isWhitespace = (character: string | undefined) => character === undefined || /\s/.test(character);
const isAlphanumeric = (character: string | undefined) =>
  character !== undefined && /[\p{L}\p{M}\p{N}]/u.test(character);

/** Finds the closing delimiter for an emphasis run that opened just before `from`. */
function findClosing(source: string, delimiter: string, from: number): number {
  let index = source.indexOf(delimiter, from);
  while (index !== -1) {
    const valid =
      index > from &&
      !isWhitespace(source[index - 1]) &&
      // `*` must not be half of a `**`, and `_` must end a word, not sit inside one.
      (delimiter !== "*" || (source[index + 1] !== "*" && source[index - 1] !== "*")) &&
      (delimiter[0] !== "_" || !isAlphanumeric(source[index + delimiter.length]));
    if (valid) return index;
    index = source.indexOf(delimiter, index + 1);
  }
  return -1;
}

/** Parses inline Markdown into nodes. Unmatched syntax stays literal text. */
export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let text = "";
  const flush = () => {
    if (text) nodes.push({ type: "text", text });
    text = "";
  };

  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (character === "\\" && next !== undefined && /[!-/:-@[-`{-~]/.test(next)) {
      text += next;
      index += 2;
      continue;
    }

    if (character === "`") {
      let run = 1;
      while (source[index + run] === "`") run += 1;
      const delimiter = "`".repeat(run);
      const close = source.indexOf(delimiter, index + run);
      if (close !== -1) {
        flush();
        nodes.push({ type: "code", text: source.slice(index + run, close) });
        index = close + run;
        continue;
      }
      text += delimiter;
      index += run;
      continue;
    }

    if (character === "[" || (character === "!" && next === "[")) {
      const labelStart = index + (character === "!" ? 2 : 1);
      const labelEnd = source.indexOf("](", labelStart);
      const urlEnd = labelEnd === -1 ? -1 : source.indexOf(")", labelEnd + 2);
      if (labelEnd !== -1 && urlEnd !== -1 && !source.slice(labelStart, labelEnd).includes("\n")) {
        flush();
        const label = source.slice(labelStart, labelEnd);
        const href = source.slice(labelEnd + 2, urlEnd).trim().split(/\s+/)[0] ?? "";
        if (character === "!") {
          nodes.push({ type: "text", text: label });
        } else {
          nodes.push({ type: "link", href, children: parseInline(label) });
        }
        index = urlEnd + 1;
        continue;
      }
    }

    if (character === "<") {
      const autolink = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(source.slice(index));
      if (autolink) {
        flush();
        nodes.push({ type: "link", href: autolink[1], children: [{ type: "text", text: autolink[1] }] });
        index += autolink[0].length;
        continue;
      }
    }

    if (source.startsWith("***", index) && !isWhitespace(source[index + 3])) {
      let close = source.indexOf("***", index + 4);
      while (close !== -1 && isWhitespace(source[close - 1])) close = source.indexOf("***", close + 1);
      if (close !== -1) {
        flush();
        nodes.push({ type: "strong", children: [{ type: "em", children: parseInline(source.slice(index + 3, close)) }] });
        index = close + 3;
        continue;
      }
    }

    const double = source.slice(index, index + 2);
    if ((double === "**" || double === "__" || double === "~~") && !isWhitespace(source[index + 2])) {
      const opensWord = double !== "__" || !isAlphanumeric(source[index - 1]);
      const close = opensWord ? findClosing(source, double, index + 2) : -1;
      if (close !== -1) {
        flush();
        nodes.push({
          type: double === "~~" ? "del" : "strong",
          children: parseInline(source.slice(index + 2, close)),
        });
        index = close + 2;
        continue;
      }
    }

    if ((character === "*" || character === "_") && !isWhitespace(next) && next !== character) {
      const opensWord = character !== "_" || !isAlphanumeric(source[index - 1]);
      const close = opensWord ? findClosing(source, character, index + 1) : -1;
      if (close !== -1) {
        flush();
        nodes.push({ type: "em", children: parseInline(source.slice(index + 1, close)) });
        index = close + 1;
        continue;
      }
    }

    text += character;
    index += 1;
  }
  flush();
  return nodes;
}

function inlineText(nodes: InlineNode[]): string {
  return nodes
    .map((node) => (node.type === "text" || node.type === "code" ? node.text : inlineText(node.children)))
    .join("");
}

/** Inline Markdown as plain text: emphasis markers dropped, `[label](url)` reduced to label. */
export function plainInline(markdown: string): string {
  if (!/[*_~`[<\\!]/.test(markdown)) return markdown;
  return inlineText(parseInline(markdown));
}

export function isSafeNoteLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href.trim());
}

// MARK: Editing

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function selectionOf(text: string, start: number, end: number) {
  const location = clamp(Math.min(start, end), 0, text.length);
  return { location, length: clamp(Math.max(start, end), location, text.length) - location };
}

function edit(text: string, location: number, length = 0): NoteEdit {
  return { text, selectionStart: location, selectionEnd: location + length };
}

export function applyNoteFormat(
  format: NoteFormat,
  text: string,
  selectionStart: number,
  selectionEnd: number,
): NoteEdit {
  const selection = selectionOf(text, selectionStart, selectionEnd);
  switch (format) {
    case "bold":
      return wrap(text, selection, "**");
    case "italic":
      return wrap(text, selection, "*");
    case "strikethrough":
      return wrap(text, selection, "~~");
    case "code":
      return wrap(text, selection, "`");
    case "link":
      return insertLink(text, selection);
    default:
      return prefixLines(text, selection, format);
  }
}

/**
 * What Enter does on a list or quote line: start the next item, or, on an item with nothing in
 * it, end the list. Null when Enter should just insert a newline.
 */
export function continueNoteList(text: string, selectionStart: number, selectionEnd: number): NoteEdit | null {
  const selection = selectionOf(text, selectionStart, selectionEnd);
  if (selection.length !== 0) return null;
  const lineStart = lineStartBefore(text, selection.location);
  const newline = text.indexOf("\n", selection.location);
  const lineEnd = newline === -1 ? text.length : newline;
  const info = lineInfo(text.slice(lineStart, lineEnd));
  let nextPrefix: string;
  switch (info.kind.kind) {
    case "bullet":
      nextPrefix = `${info.kind.marker} `;
      break;
    case "numbered":
      nextPrefix = `${info.kind.number + 1}${info.kind.delimiter} `;
      break;
    case "checklist":
      nextPrefix = `${nextListMarker(info.kind.marker)} [ ] `;
      break;
    case "quote":
      nextPrefix = "> ";
      break;
    default:
      return null;
  }
  if (isBlank(info.content)) {
    return edit(text.slice(0, lineStart) + text.slice(lineEnd), lineStart);
  }
  const insertion = `\n${info.indent}${nextPrefix}`;
  return edit(
    text.slice(0, selection.location) + insertion + text.slice(selection.location),
    selection.location + insertion.length,
  );
}

function nextListMarker(marker: string): string {
  const numbered = /^(\d+)([.)])$/.exec(marker);
  return numbered ? `${Number(numbered[1]) + 1}${numbered[2]}` : marker;
}

const isSpaceUnit = (character: string | undefined) =>
  character === " " || character === "\t" || character === "\n" || character === "\r";

function isWordUnit(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  if (code >= 0xd800 && code <= 0xdfff) return true;
  return /[\p{L}\p{M}\p{N}']/u.test(character);
}

function runLength(text: string, marker: string, from: number, step: number): number {
  let count = 0;
  for (let index = from; index >= 0 && index < text.length && text[index] === marker; index += step) count += 1;
  return count;
}

/**
 * Wraps the selection in `marker`, or unwraps it when it is already wrapped. An empty selection
 * inside a word wraps that word; elsewhere it inserts a pair to type between.
 */
function wrap(text: string, original: { location: number; length: number }, marker: string): NoteEdit {
  let { location, length } = original;
  while (length > 0 && isSpaceUnit(text[location])) {
    location += 1;
    length -= 1;
  }
  while (length > 0 && isSpaceUnit(text[location + length - 1])) length -= 1;
  if (length === 0) {
    let start = location;
    let end = location;
    while (start > 0 && isWordUnit(text[start - 1])) start -= 1;
    while (end < text.length && isWordUnit(text[end])) end += 1;
    if (start < location && end > location) {
      location = start;
      length = end - start;
    }
  }

  const stars = /^\*+$/.test(marker);
  const size = marker.length;
  const end = location + length;
  // `*` and `**` share a character: count the whole run so italic never strips half of a bold
  // marker and bold never strips an italic one.
  const matches = (before: number, after: number) => {
    if (!stars) return before >= size && after >= size;
    if (size === 2) return before >= 2 && after >= 2;
    return (before === 1 || before >= 3) && (after === 1 || after >= 3);
  };

  const outsideBefore = stars
    ? runLength(text, "*", location - 1, -1)
    : location >= size && text.slice(location - size, location) === marker
      ? size
      : 0;
  const outsideAfter = stars
    ? runLength(text, "*", end, 1)
    : text.slice(end, end + size) === marker
      ? size
      : 0;
  if (matches(outsideBefore, outsideAfter)) {
    return edit(
      text.slice(0, location - size) + text.slice(location, end) + text.slice(end + size),
      location - size,
      length,
    );
  }

  if (length >= size * 2) {
    const selected = text.slice(location, end);
    const insideBefore = stars ? runLength(selected, "*", 0, 1) : selected.startsWith(marker) ? size : 0;
    const insideAfter = stars
      ? runLength(selected, "*", selected.length - 1, -1)
      : selected.endsWith(marker)
        ? size
        : 0;
    if (insideBefore < selected.length && matches(insideBefore, insideAfter)) {
      const inner = selected.slice(size, selected.length - size);
      return edit(text.slice(0, location) + inner + text.slice(end), location, inner.length);
    }
  }

  return edit(
    text.slice(0, location) + marker + text.slice(location, end) + marker + text.slice(end),
    location + size,
    length,
  );
}

function insertLink(text: string, selection: { location: number; length: number }): NoteEdit {
  const before = text.slice(0, selection.location);
  const after = text.slice(selection.location + selection.length);
  const selected = text.slice(selection.location, selection.location + selection.length).trim();
  if (!selected) return edit(`${before}[](https://)${after}`, selection.location + 1);
  if (/^https?:\/\//.test(selected)) return edit(`${before}[](${selected})${after}`, selection.location + 1);
  const label = `[${selected}](`;
  return edit(`${before}${label}https://)${after}`, selection.location + label.length, 8);
}

function matchesFormat(kind: LineKind, format: NoteFormat): boolean {
  return (
    (kind.kind === "bullet" && format === "bulletList") ||
    (kind.kind === "numbered" && format === "numberedList") ||
    (kind.kind === "checklist" && format === "checklist") ||
    (kind.kind === "quote" && format === "quote") ||
    (kind.kind === "heading" && format === "heading")
  );
}

/**
 * Applies a block format to every line the selection touches. Lines that all have it already
 * lose it; otherwise each gets it, replacing any other block marker. Headings cycle
 * H1 → H2 → H3 → plain.
 */
function prefixLines(text: string, selection: { location: number; length: number }, format: NoteFormat): NoteEdit {
  const blockStart = lineStartBefore(text, selection.location);
  // A selection ending just after a newline doesn't take in the line that follows it.
  const lastIncluded = selection.length > 0 ? selection.location + selection.length - 1 : selection.location;
  const newline = text.indexOf("\n", lastIncluded);
  const blockEnd = newline === -1 ? text.length : newline;
  const lines = text.slice(blockStart, blockEnd).split("\n");
  const infos = lines.map(lineInfo);
  const filled = infos.filter((_, index) => !isBlank(lines[index]));
  const targets = filled.length ? filled : infos;
  const removing = format !== "heading" && targets.every((info) => matchesFormat(info.kind, format));

  let headingLevel = 1;
  const first = targets[0];
  if (format === "heading" && first?.kind.kind === "heading") {
    headingLevel = first.kind.level >= 3 ? 0 : first.kind.level + 1;
  }

  let number = 1;
  if (format === "numberedList" && blockStart > 0) {
    const previousStart = lineStartBefore(text, blockStart - 1);
    const previous = lineInfo(text.slice(previousStart, blockStart - 1));
    if (previous.kind.kind === "numbered") number = previous.kind.number + 1;
  }

  let firstPrefixDelta = 0;
  const output = lines.map((line, index) => {
    const info = infos[index];
    if (lines.length > 1 && isBlank(line)) return line;
    let prefix = "";
    if (!removing) {
      switch (format) {
        case "heading":
          prefix = headingLevel === 0 ? "" : `${"#".repeat(headingLevel)} `;
          break;
        case "bulletList":
          prefix = "- ";
          break;
        case "numberedList":
          prefix = `${number}. `;
          number += 1;
          break;
        case "checklist":
          prefix = "- [ ] ";
          break;
        case "quote":
          prefix = "> ";
          break;
      }
    }
    if (index === 0) firstPrefixDelta = info.indent.length + prefix.length - info.prefixLength;
    return info.indent + prefix + info.content;
  });
  const replacement = output.join("\n");
  const updated = text.slice(0, blockStart) + replacement + text.slice(blockEnd);

  if (selection.length === 0 && lines.length === 1) {
    const contentStart = blockStart + infos[0].prefixLength + firstPrefixDelta;
    return edit(updated, Math.max(contentStart, selection.location + firstPrefixDelta));
  }
  return edit(updated, blockStart, replacement.length);
}
