import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Subtask, Task } from "../../domains/tasks/taskTypes";
import {
  checklistItemCount,
  extractChecklist,
  markdownFromNoteLines,
  noteLinesFromMarkdown,
  toggleChecklistItem,
  type NoteFormat,
} from "../../domains/tasks/noteMarkdown";
import { Modal } from "../Modal";
import { NoteMarkdownView } from "./NoteMarkdown";
import { NoteRichEditor, type NoteRichEditorHandle } from "./NoteRichEditor";

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
                  copyableCode
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
 * The note editor: formatted text with the Markdown syntax hidden, as in Apple Notes. Notes are
 * stored as Markdown; the formatting bar applies formats and checklist items can be converted to
 * subtasks. `onSave` receives the note and any subtasks converted from its checklist;
 * cancelling discards both.
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
  onPaste?: (event: React.ClipboardEvent<HTMLElement>) => void;
}) {
  const [text, setText] = useState(() => markdownFromNoteLines(noteLinesFromMarkdown(initialNote)));
  const [converted, setConverted] = useState<Subtask[]>([]);
  const editorRef = useRef<NoteRichEditorHandle>(null);

  const applyFormat = (format: NoteFormat) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (format !== "link") {
      editor.apply(format);
      return;
    }
    const restore = editor.saveSelection();
    const url = window.prompt("Add Link", "https://");
    restore();
    if (url) editor.applyLink(url);
  };

  const convert = () => {
    const result = extractChecklist(text);
    setConverted((previous) => [...previous, ...result.subtasks]);
    editorRef.current?.replaceAll(result.note);
  };

  /** An unchanged note keeps its exact original text rather than its canonical form. */
  const savedNote = () => (text === markdownFromNoteLines(noteLinesFromMarkdown(initialNote)) ? initialNote : text);

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
              onClick={() => onSave(savedNote(), converted)}
              aria-label="Save notes"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M5 12l4 4 10-10" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          }
        />

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
        <div className="note-editor__surface">
          <NoteRichEditor ref={editorRef} initialMarkdown={initialNote} onChange={setText} onPasteImage={onPaste} />
          {!text && (
            <div className="note-editor__placeholder" aria-hidden="true">
              Write your note
            </div>
          )}
        </div>

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
