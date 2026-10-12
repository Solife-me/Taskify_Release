import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Subtask, Task } from "../../domains/tasks/taskTypes";
import {
  applyNoteFormat,
  checklistItemCount,
  continueNoteList,
  extractChecklist,
  toggleChecklistItem,
  type NoteEdit,
  type NoteFormat,
} from "../../domains/tasks/noteMarkdown";
import { Modal } from "../Modal";
import { NoteMarkdownView } from "./NoteMarkdown";

// Both modals portal to <body>: they open from inside other modals, whose panels use
// backdrop-filter and would otherwise trap a fixed-position overlay inside them.
function portal(node: React.ReactNode) {
  return typeof document !== "undefined" ? createPortal(node, document.body) : null;
}

function SheetHeader({
  title,
  onClose,
  closeLabel,
  action,
}: {
  title: string;
  onClose: () => void;
  closeLabel: string;
  action: React.ReactNode;
}) {
  return (
    <div className="edit-sheet__header">
      <button type="button" className="edit-sheet__action" onClick={onClose} aria-label={closeLabel}>
        <span aria-hidden="true">×</span>
      </button>
      <div className="edit-sheet__title note-sheet__title">{title}</div>
      {action}
    </div>
  );
}

function ConvertChecklistButton({ note, onConvert }: { note: string; onConvert: () => void }) {
  const count = checklistItemCount(note);
  if (!count) return null;
  return (
    <button type="button" className="ghost-button button-sm pressable note-sheet__convert" onClick={onConvert}>
      {count === 1 ? "Convert checklist item to subtask" : `Convert ${count} checklist items to subtasks`}
    </button>
  );
}

/**
 * The full note of a task, with tickable checklist items, an Edit button for the note editor
 * and a way to turn the checklist into real subtasks.
 */
export function NoteViewerModal({
  task,
  onClose,
  onSaveNote,
}: {
  task: Task;
  onClose: () => void;
  /** Persists the note, appending any subtasks converted from its checklist. */
  onSaveNote: (note: string, subtasks: Subtask[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const note = task.note || "";

  return (
    <>
      {portal(
        <Modal onClose={onClose} showClose={false} variant="fullscreen">
          <div className="edit-modal note-sheet">
            <SheetHeader
              title={task.title || "Notes"}
              onClose={onClose}
              closeLabel="Close notes"
              action={
                <button
                  type="button"
                  className="edit-sheet__action edit-sheet__action--accent"
                  onClick={() => setEditing(true)}
                  aria-label="Edit notes"
                  title="Edit notes"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M4 20h4L19 9l-4-4L4 16v4Z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              }
            />
            <div className="note-sheet__body">
              {note.trim() ? (
                <NoteMarkdownView
                  note={note}
                  onToggleChecklistItem={(line) => {
                    const updated = toggleChecklistItem(note, line);
                    if (updated !== null) onSaveNote(updated, []);
                  }}
                />
              ) : (
                <p className="note-sheet__empty">No notes yet. Tap edit to add some.</p>
              )}
            </div>
            <ConvertChecklistButton
              note={note}
              onConvert={() => {
                const result = extractChecklist(note);
                onSaveNote(result.note, result.subtasks);
              }}
            />
          </div>
        </Modal>,
      )}
      {editing && (
        <NoteEditorModal
          initialNote={note}
          onCancel={() => setEditing(false)}
          onSave={(updated, subtasks) => {
            onSaveNote(updated, subtasks);
            setEditing(false);
          }}
        />
      )}
    </>
  );
}

const FORMAT_BUTTONS: { format: NoteFormat; label: string; icon: React.ReactNode }[] = [
  // Toolbar order: what a narrow screen shows without scrolling comes first.
  { format: "bold", label: "Bold (⌘B)", icon: <span className="note-toolbar__glyph font-bold">B</span> },
  { format: "italic", label: "Italic (⌘I)", icon: <span className="note-toolbar__glyph italic">I</span> },
  {
    format: "bulletList",
    label: "Bulleted list",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        <path d="M9 6h11M9 12h11M9 18h11" />
        <circle cx="4.5" cy="6" r="1" fill="currentColor" />
        <circle cx="4.5" cy="12" r="1" fill="currentColor" />
        <circle cx="4.5" cy="18" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    format: "numberedList",
    label: "Numbered list",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        <path d="M10 6h10M10 12h10M10 18h10" />
        <text x="2.5" y="8.5" fontSize="7" fill="currentColor" stroke="none">1</text>
        <text x="2.5" y="14.5" fontSize="7" fill="currentColor" stroke="none">2</text>
        <text x="2.5" y="20.5" fontSize="7" fill="currentColor" stroke="none">3</text>
      </svg>
    ),
  },
  {
    format: "checklist",
    label: "Checklist",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="6" height="6" rx="1.5" />
        <path d="M4.5 16.5l1.5 1.5 3-3M13 7h8M13 17h8" />
      </svg>
    ),
  },
  { format: "heading", label: "Heading", icon: <span className="note-toolbar__glyph">H</span> },
  {
    format: "link",
    label: "Link",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
      </svg>
    ),
  },
  { format: "strikethrough", label: "Strikethrough", icon: <span className="note-toolbar__glyph line-through">S</span> },
  {
    format: "code",
    label: "Code",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />
      </svg>
    ),
  },
  {
    format: "quote",
    label: "Quote",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M7 7h4v4c0 3-1.5 5-4 6l-.8-1.4C7.6 14.8 8.4 13.6 8.5 12H7V7Zm8 0h4v4c0 3-1.5 5-4 6l-.8-1.4c1.4-.8 2.2-2 2.3-3.6H15V7Z" />
      </svg>
    ),
  },
];

/**
 * A Markdown editor for a task note: a formatting bar, Write and Preview modes, list
 * continuation on Enter, and checklist-to-subtask conversion. `onSave` receives the note and
 * any subtasks converted from its checklist; cancelling discards both.
 */
export function NoteEditorModal({
  initialNote,
  onCancel,
  onSave,
  onPaste,
}: {
  initialNote: string;
  onCancel: () => void;
  onSave: (note: string, subtasks: Subtask[]) => void;
  onPaste?: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const [text, setText] = useState(initialNote);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [converted, setConverted] = useState<Subtask[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<[number, number] | null>(null);

  useEffect(() => {
    if (mode !== "write") return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }, [mode]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const selection = pendingSelection.current;
    if (!textarea || !selection) return;
    pendingSelection.current = null;
    textarea.setSelectionRange(selection[0], selection[1]);
  }, [text]);

  /**
   * Applies an edit as one replacement of the changed span through the browser's own editing
   * command, so it lands on the textarea's undo stack. Falls back to setting the value.
   */
  const applyEdit = useCallback((edit: NoteEdit) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setText(edit.text);
      return;
    }
    const old = textarea.value;
    let prefix = 0;
    const limit = Math.min(old.length, edit.text.length);
    while (prefix < limit && old[prefix] === edit.text[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < old.length - prefix &&
      suffix < edit.text.length - prefix &&
      old[old.length - 1 - suffix] === edit.text[edit.text.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const replacement = edit.text.slice(prefix, edit.text.length - suffix);
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(prefix, old.length - suffix);
    let applied = false;
    try {
      applied = replacement
        ? document.execCommand("insertText", false, replacement)
        : old.length - suffix > prefix
          ? document.execCommand("delete", false)
          : true;
    } catch {
      applied = false;
    }
    if (applied && textarea.value === edit.text) {
      textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
      setText(edit.text);
    } else {
      pendingSelection.current = [edit.selectionStart, edit.selectionEnd];
      setText(edit.text);
    }
  }, []);

  const applyFormat = useCallback(
    (format: NoteFormat) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      applyEdit(applyNoteFormat(format, textarea.value, textarea.selectionStart, textarea.selectionEnd));
    },
    [applyEdit],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const textarea = event.currentTarget;
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const edit = continueNoteList(textarea.value, textarea.selectionStart, textarea.selectionEnd);
      if (edit) {
        event.preventDefault();
        applyEdit(edit);
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
      const key = event.key.toLowerCase();
      if (key === "b" || key === "i") {
        event.preventDefault();
        applyFormat(key === "b" ? "bold" : "italic");
      }
    }
  };

  const convert = () => {
    const result = extractChecklist(text);
    setConverted((previous) => [...previous, ...result.subtasks]);
    pendingSelection.current = [result.note.length, result.note.length];
    setText(result.note);
  };

  return portal(
    <Modal onClose={onCancel} showClose={false} variant="fullscreen">
      <div className="edit-modal note-sheet note-editor">
        <SheetHeader
          title="Notes"
          onClose={onCancel}
          closeLabel="Discard note changes"
          action={
            <button
              type="button"
              className="edit-sheet__action edit-sheet__action--accent"
              onClick={() => onSave(text, converted)}
              aria-label="Save notes"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M5 12l4 4 10-10" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          }
        />

        <div className="note-editor__modes" role="tablist" aria-label="Editor mode">
          {(["write", "preview"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              className={`note-editor__mode pressable${mode === value ? " is-active" : ""}`}
              onClick={() => setMode(value)}
            >
              {value === "write" ? "Write" : "Preview"}
            </button>
          ))}
        </div>

        {mode === "write" ? (
          <>
            <div className="note-toolbar" role="toolbar" aria-label="Formatting">
              {FORMAT_BUTTONS.map(({ format, label, icon }) => (
                <button
                  key={format}
                  type="button"
                  className="note-toolbar__button pressable"
                  aria-label={label}
                  title={label}
                  // Keeps focus, and so the selection and the on-screen keyboard, in the text.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyFormat(format)}
                >
                  {icon}
                </button>
              ))}
            </div>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={onPaste}
              className="note-editor__textarea"
              placeholder="Write notes in Markdown: **bold**, - lists, - [ ] checklists…"
              aria-label="Notes"
              spellCheck
            />
          </>
        ) : (
          <div className="note-sheet__body">
            {text.trim() ? (
              <NoteMarkdownView
                note={text}
                onToggleChecklistItem={(line) => {
                  const updated = toggleChecklistItem(text, line);
                  if (updated !== null) setText(updated);
                }}
              />
            ) : (
              <p className="note-sheet__empty">Nothing to preview yet.</p>
            )}
          </div>
        )}

        <ConvertChecklistButton note={text} onConvert={convert} />
        {converted.length > 0 && (
          <p className="note-sheet__hint">
            {converted.length === 1
              ? "1 item will be added to subtasks when you save."
              : `${converted.length} items will be added to subtasks when you save.`}
          </p>
        )}
      </div>
    </Modal>,
  );
}
