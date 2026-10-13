import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import {
  markdownFromNoteLines,
  mergeRuns,
  noteLinesFromMarkdown,
  type NoteFormat,
  type NoteLine,
  type NoteLineKind,
  type NoteRun,
} from "../../domains/tasks/noteMarkdown";

// The note editor's formatted text, as in Apple Notes: formatting lives in the DOM (a <div> per
// line with its kind in data attributes, inline <strong>/<em>/<s>/<code>/<a>), never as Markdown
// syntax, so typing and deleting can't break it. Bullets, numbers, checkboxes and the quote bar
// are drawn with CSS. Markdown is produced from the DOM on every change.
// Mirrors the native editor (TaskNoteRichText.swift).

export type NoteRichEditorHandle = {
  apply: (format: NoteFormat) => void;
  applyLink: (url: string) => void;
  replaceAll: (markdown: string) => void;
  focus: () => void;
  /** Remembers the selection; the returned function puts it back, e.g. after a prompt. */
  saveSelection: () => () => void;
};

type Props = {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  /** Image paste, for attaching pasted pictures. */
  onPasteImage?: (event: React.ClipboardEvent<HTMLDivElement>) => void;
};

const LINE_CLASS = "nr-line";
const LIST_KINDS: NoteLineKind[] = ["bullet", "numbered", "checklist"];

// MARK: Lines ↔ DOM

function appendRuns(parent: HTMLElement, runs: NoteRun[]) {
  for (const run of runs) {
    let node: Node = document.createTextNode(run.text);
    if (run.code) {
      const code = document.createElement("code");
      code.appendChild(node);
      node = code;
    }
    if (run.strike) {
      const strike = document.createElement("s");
      strike.appendChild(node);
      node = strike;
    }
    if (run.italic) {
      const em = document.createElement("em");
      em.appendChild(node);
      node = em;
    }
    if (run.bold) {
      const strong = document.createElement("strong");
      strong.appendChild(node);
      node = strong;
    }
    if (run.link) {
      const anchor = document.createElement("a");
      anchor.href = run.link;
      anchor.appendChild(node);
      node = anchor;
    }
    parent.appendChild(node);
  }
}

function setLineAttributes(element: HTMLElement, line: Pick<NoteLine, "kind" | "depth" | "level" | "checked" | "number">) {
  element.className = LINE_CLASS;
  element.dataset.kind = line.kind;
  element.dataset.depth = String(line.kind === "bullet" || line.kind === "numbered" || line.kind === "checklist" ? line.depth : 0);
  if (line.kind === "heading") element.dataset.level = String(Math.min(Math.max(line.level ?? 1, 1), 3));
  else delete element.dataset.level;
  if (line.kind === "checklist") element.dataset.checked = line.checked ? "true" : "false";
  else delete element.dataset.checked;
  if (line.kind === "numbered") element.dataset.number = String(line.number ?? 1);
  else delete element.dataset.number;
  if (line.kind === "rule") element.contentEditable = "false";
  else element.removeAttribute("contenteditable");
}

function lineElement(line: NoteLine): HTMLDivElement {
  const element = document.createElement("div");
  setLineAttributes(element, line);
  if (line.kind === "rule") return element;
  if (line.kind === "code") element.textContent = line.runs.map((run) => run.text).join("");
  else appendRuns(element, line.runs);
  if (!element.textContent) element.appendChild(document.createElement("br"));
  return element;
}

function renderLines(root: HTMLElement, lines: NoteLine[]) {
  root.replaceChildren(...(lines.length ? lines : [{ kind: "paragraph" as const, depth: 0, runs: [] }]).map(lineElement));
  renumber(root);
}

type Marks = Omit<NoteRun, "text">;

function marksFor(element: HTMLElement, marks: Marks): Marks {
  const tag = element.tagName;
  const next = { ...marks };
  if (tag === "STRONG" || tag === "B") next.bold = true;
  if (tag === "EM" || tag === "I") next.italic = true;
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") next.strike = true;
  if (tag === "CODE") next.code = true;
  if (tag === "A") {
    const href = element.getAttribute("href");
    if (href) next.link = href;
  }
  // Browsers sometimes express formatting as inline styles when lines merge.
  const style = element.style;
  if (style) {
    const weight = style.fontWeight;
    if (weight === "bold" || Number(weight) >= 600) next.bold = true;
    if (style.fontStyle === "italic") next.italic = true;
    if (style.textDecoration.includes("line-through") || style.textDecorationLine?.includes("line-through")) next.strike = true;
    if (style.fontFamily.includes("monospace")) next.code = true;
  }
  return next;
}

/** A line element's content as runs, split at any <br> into separate visual lines. */
function runsOf(element: Node, marks: Marks, segments: NoteRun[][]) {
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.textContent ?? "").replace(/\u200b/g, "").replace(/\n/g, " ");
      if (text) segments[segments.length - 1].push({ ...marks, text });
    } else if (child instanceof HTMLElement) {
      if (child.tagName === "BR") {
        segments.push([]);
      } else {
        runsOf(child, marksFor(child, marks), segments);
      }
    }
  }
}

const BLOCK_TAGS = new Set(["DIV", "P", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "UL", "OL"]);

function lineStyleOf(element: HTMLElement): Omit<NoteLine, "runs"> {
  const kind = (element.dataset.kind as NoteLineKind | undefined) ?? "paragraph";
  return {
    kind,
    depth: Number(element.dataset.depth ?? 0) || 0,
    level: element.dataset.level ? Number(element.dataset.level) : undefined,
    checked: element.dataset.checked === "true",
    number: element.dataset.number ? Number(element.dataset.number) : undefined,
  };
}

/** The editor's lines. Tolerant of whatever structure editing left behind. */
export function linesFromDom(root: ParentNode): NoteLine[] {
  const lines: NoteLine[] = [];
  let loose: NoteRun[][] | null = null;
  const flushLoose = () => {
    if (!loose) return;
    for (const runs of loose) lines.push({ kind: "paragraph", depth: 0, runs: mergeRuns(runs) });
    loose = null;
  };
  const visit = (node: Node) => {
    if (node instanceof HTMLElement && BLOCK_TAGS.has(node.tagName)) {
      flushLoose();
      const hasNestedBlocks = Array.from(node.children).some((child) => BLOCK_TAGS.has(child.tagName));
      if (hasNestedBlocks) {
        node.childNodes.forEach(visit);
        flushLoose();
        return;
      }
      const style = lineStyleOf(node);
      if (style.kind === "rule") {
        lines.push({ ...style, runs: [] });
        return;
      }
      const segments: NoteRun[][] = [[]];
      runsOf(node, {}, segments);
      // A trailing <br> only holds an empty line open.
      if (segments.length > 1 && segments[segments.length - 1].length === 0) segments.pop();
      for (const runs of segments) {
        const merged = mergeRuns(runs);
        const line: NoteLine = { ...style, runs: style.kind === "code" ? merged.map((run) => ({ text: run.text })) : merged };
        if (line.kind === "heading" && !merged.length) line.kind = "paragraph";
        lines.push(line);
      }
      return;
    }
    loose ??= [[]];
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/\u200b/g, "");
      if (text) loose[loose.length - 1].push({ text });
    } else if (node instanceof HTMLElement) {
      if (node.tagName === "BR") loose.push([]);
      else runsOf(node, marksFor(node, {}), loose);
    }
  };
  root.childNodes.forEach(visit);
  flushLoose();
  return lines;
}

/** Numbered items show their sequence; the first of a run starts at its own number. */
function renumber(root: HTMLElement) {
  let previous: { depth: number; number: number } | null = null;
  for (const child of Array.from(root.children) as HTMLElement[]) {
    if (child.dataset.kind === "numbered") {
      const depth = Number(child.dataset.depth ?? 0) || 0;
      const number: number = previous && previous.depth === depth ? previous.number + 1 : Number(child.dataset.number ?? 1) || 1;
      child.dataset.display = `${number}.`;
      previous = { depth, number };
    } else {
      delete child.dataset.display;
      previous = null;
    }
  }
}

// MARK: Selection helpers

function lineOf(node: Node | null, root: HTMLElement): HTMLElement | null {
  let current: Node | null = node;
  while (current && current !== root) {
    if (current instanceof HTMLElement && current.parentElement === root) return current;
    current = current.parentNode;
  }
  return null;
}

function selectedLines(root: HTMLElement): HTMLElement[] {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return [];
  const range = selection.getRangeAt(0);
  const start = lineOf(range.startContainer, root);
  const end = lineOf(range.endContainer, root);
  if (!start) return [];
  const lines: HTMLElement[] = [];
  let current: Element | null = start;
  while (current) {
    lines.push(current as HTMLElement);
    if (current === end || !end) break;
    current = current.nextElementSibling;
  }
  return lines;
}

function caretAtLineStart(line: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  const before = document.createRange();
  before.selectNodeContents(line);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().replace(/\u200b/g, "").length === 0;
}

function placeCaret(node: Node, offset = 0) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Replaces the selection with nodes and puts the caret after them. Inserting markup with
 * execCommand("insertHTML") would let Chrome turn <code> into styled spans whose style then
 * leaks into whatever is typed next.
 */
function insertNodes(nodes: Node[]) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const fragment = document.createDocumentFragment();
  fragment.append(...nodes);
  // A zero-width space after the last node keeps typing outside it; it is never saved.
  const caret = document.createTextNode("\u200b");
  fragment.append(caret);
  range.insertNode(fragment);
  placeCaret(caret, 1);
}

function closest(node: Node | null, tag: string, root: HTMLElement | null): HTMLElement | null {
  for (let current = node; current && current !== root; current = current.parentNode) {
    if (current instanceof HTMLElement && current.tagName === tag) return current;
  }
  return null;
}

// MARK: Component

export const NoteRichEditor = forwardRef<NoteRichEditorHandle, Props>(function NoteRichEditor(
  { initialMarkdown, onChange, onPasteImage },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const publish = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    renumber(root);
    onChangeRef.current(markdownFromNoteLines(linesFromDom(root)));
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    renderLines(root, noteLinesFromMarkdown(initialMarkdown));
    try {
      document.execCommand("styleWithCSS", false, "false");
    } catch {
      // Older engines lack the switch; tags are their default.
    }
    root.focus({ preventScroll: true });
    const last = root.lastElementChild;
    if (last) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(last);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    // The initial markdown is loaded once; later prop changes are the editor's own output.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Sets a line's kind, keeping its content. */
  const setKind = (line: HTMLElement, style: Omit<NoteLine, "runs">) => {
    const wasRule = line.dataset.kind === "rule";
    setLineAttributes(line, style);
    if (wasRule && style.kind !== "rule" && !line.firstChild) line.appendChild(document.createElement("br"));
  };

  const applyBlock = (format: NoteFormat) => {
    const root = rootRef.current;
    if (!root) return;
    const lines = selectedLines(root);
    if (!lines.length) return;
    const styles = lines.map(lineStyleOf);
    let target: Omit<NoteLine, "runs">;
    switch (format) {
      case "heading": {
        const level = styles[0].kind === "heading" ? (styles[0].level ?? 1) : 0;
        target = level >= 3 ? { kind: "paragraph", depth: 0 } : { kind: "heading", depth: 0, level: level + 1 };
        break;
      }
      case "bulletList":
        target = { kind: "bullet", depth: 0 };
        break;
      case "numberedList":
        target = { kind: "numbered", depth: 0, number: 1 };
        break;
      case "checklist":
        target = { kind: "checklist", depth: 0, checked: false };
        break;
      case "quote":
        target = { kind: "quote", depth: 0 };
        break;
      default:
        return;
    }
    const removing = format !== "heading" && styles.every((style) => style.kind === target.kind);
    lines.forEach((line, index) => {
      const next = removing ? { kind: "paragraph" as const, depth: 0 } : { ...target };
      if (LIST_KINDS.includes(next.kind)) next.depth = styles[index].depth;
      setKind(line, next);
    });
    publish();
  };

  const toggleCode = () => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || !selection.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const code = closest(range.commonAncestorContainer, "CODE", root);
    if (code) {
      // Inside code: unwrap it.
      const text = document.createTextNode(code.textContent ?? "");
      code.replaceWith(text);
      const unwrapped = document.createRange();
      unwrapped.selectNodeContents(text);
      selection.removeAllRanges();
      selection.addRange(unwrapped);
    } else {
      const element = document.createElement("code");
      element.textContent = range.toString().replace(/\n/g, " ");
      insertNodes([element]);
    }
    publish();
  };

  useImperativeHandle(ref, () => ({
    apply(format) {
      rootRef.current?.focus({ preventScroll: true });
      switch (format) {
        case "bold":
          document.execCommand("bold");
          break;
        case "italic":
          document.execCommand("italic");
          break;
        case "strikethrough":
          document.execCommand("strikeThrough");
          break;
        case "code":
          toggleCode();
          return;
        case "link":
          return;
        default:
          applyBlock(format);
          return;
      }
      publish();
    },
    applyLink(url) {
      const trimmed = url.trim();
      if (!trimmed || trimmed === "https://") return;
      rootRef.current?.focus({ preventScroll: true });
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        document.execCommand("createLink", false, trimmed);
      } else {
        const anchor = document.createElement("a");
        anchor.href = trimmed;
        anchor.textContent = trimmed;
        insertNodes([anchor]);
      }
      publish();
    },
    replaceAll(markdown) {
      const root = rootRef.current;
      if (!root) return;
      renderLines(root, noteLinesFromMarkdown(markdown));
      publish();
    },
    focus() {
      rootRef.current?.focus();
    },
    saveSelection() {
      const selection = window.getSelection();
      const root = rootRef.current;
      const range =
        selection && selection.rangeCount && root?.contains(selection.getRangeAt(0).commonAncestorContainer)
          ? selection.getRangeAt(0).cloneRange()
          : null;
      return () => {
        root?.focus({ preventScroll: true });
        if (!range) return;
        const current = window.getSelection();
        current?.removeAllRanges();
        current?.addRange(range);
      };
    },
  }));

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root || event.nativeEvent.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey && !event.shiftKey && (event.key === "b" || event.key === "i")) {
      event.preventDefault();
      document.execCommand(event.key === "b" ? "bold" : "italic");
      publish();
      return;
    }
    const line = lineOf(window.getSelection()?.anchorNode ?? null, root);
    if (!line) return;
    const style = lineStyleOf(line);

    if (event.key === "Enter" && !event.shiftKey) {
      const empty = !(line.textContent ?? "").replace(/\u200b/g, "");
      // Return on an empty list item, quote or code line ends it, as in Apple Notes.
      if (empty && style.kind !== "paragraph" && style.kind !== "heading") {
        event.preventDefault();
        setKind(line, { kind: "paragraph", depth: 0 });
        publish();
      }
      // Otherwise the browser splits the line (undoably); handleInput fixes the new line's kind.
      return;
    }
    if (event.key === "Backspace" && style.kind !== "paragraph" && caretAtLineStart(line)) {
      // Backspace at the start of a formatted line removes the formatting first.
      event.preventDefault();
      setKind(line, { kind: "paragraph", depth: 0 });
      publish();
      return;
    }
    if (event.key === "Tab" && LIST_KINDS.includes(style.kind)) {
      event.preventDefault();
      setKind(line, { ...style, depth: Math.max(0, Math.min(4, style.depth + (event.shiftKey ? -1 : 1))) });
      publish();
    }
  };

  const handleInput = (event: React.FormEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return;
    // Typing into an empty editor can land text straight in the root; give it a line.
    if (!root.firstElementChild || Array.from(root.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent)) {
      const lines = linesFromDom(root);
      const selection = window.getSelection();
      const offset = selection?.anchorOffset ?? 0;
      renderLines(root, lines);
      const last = root.lastElementChild;
      if (last?.firstChild) placeCaret(last.firstChild, Math.min(offset, last.firstChild.textContent?.length ?? 0));
    }
    const native = event.nativeEvent as InputEvent;
    if (native.inputType === "insertParagraph") {
      const line = lineOf(window.getSelection()?.anchorNode ?? null, root);
      if (line) {
        const style = lineStyleOf(line);
        if (style.kind === "heading") setKind(line, { kind: "paragraph", depth: 0 });
        else if (style.kind === "checklist") setKind(line, { ...style, checked: false });
        else if (!line.dataset.kind) setKind(line, { kind: "paragraph", depth: 0 });
      }
    }
    publish();
  };

  /** A click on a checklist line's box ticks it. */
  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const line = lineOf(event.target as Node, root!);
    if (!root || !line || line.dataset.kind !== "checklist") return;
    const box = line.getBoundingClientRect();
    const paddingLeft = parseFloat(getComputedStyle(line).paddingLeft) || 0;
    if (event.clientX >= box.left + paddingLeft) return;
    event.preventDefault();
    line.dataset.checked = line.dataset.checked === "true" ? "false" : "true";
    publish();
  };

  const handleCopy = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || selection.isCollapsed) return;
    const fragment = selection.getRangeAt(0).cloneContents();
    const container = document.createElement("div");
    container.appendChild(fragment);
    event.preventDefault();
    event.clipboardData.setData("text/plain", markdownFromNoteLines(linesFromDom(container)));
    event.clipboardData.setData("text/html", container.innerHTML);
  };

  const handleCut = (event: React.ClipboardEvent<HTMLDivElement>) => {
    handleCopy(event);
    if (event.defaultPrevented) {
      document.execCommand("delete");
      publish();
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const hasImage = Array.from(event.clipboardData.items).some((item) => item.type.startsWith("image/"));
    if (hasImage && onPasteImage) {
      onPasteImage(event);
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    const lines = noteLinesFromMarkdown(text);
    if (lines.length <= 1 && (lines[0]?.kind ?? "paragraph") === "paragraph") {
      // One plain line: plain text goes in undoably; formatted text as its elements.
      const runs = lines[0]?.runs ?? [];
      if (runs.every((run) => !run.bold && !run.italic && !run.strike && !run.code && !run.link)) {
        document.execCommand("insertText", false, runs.map((run) => run.text).join("") || text);
      } else {
        const container = document.createElement("div");
        appendRuns(container, runs);
        insertNodes(Array.from(container.childNodes));
      }
    } else {
      // Several lines: split the current line at the caret and put the pasted lines between.
      const root = rootRef.current;
      const selection = window.getSelection();
      if (!root || !selection || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const line = lineOf(range.startContainer, root);
      const pasted = lines.map(lineElement);
      if (line) {
        const after = document.createRange();
        after.setStart(range.startContainer, range.startOffset);
        after.setEndAfter(line.lastChild ?? line);
        const tail = after.extractContents();
        const tailLine = line.cloneNode(false) as HTMLElement;
        tailLine.appendChild(tail);
        if (!tailLine.textContent) tailLine.replaceChildren(document.createElement("br"));
        if (!line.textContent) line.replaceChildren(document.createElement("br"));
        line.after(...pasted, tailLine);
        if (!(line.textContent ?? "").trim()) line.remove();
        placeCaret(tailLine, 0);
      } else {
        root.append(...pasted);
      }
    }
    publish();
  };

  return (
    <div
      ref={rootRef}
      className="note-rich"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="Notes"
      spellCheck
      onKeyDown={handleKeyDown}
      onInput={handleInput}
      onMouseDown={handleMouseDown}
      onCopy={handleCopy}
      onCut={handleCut}
      onPaste={handlePaste}
    />
  );
});
