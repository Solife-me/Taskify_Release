import React, { useMemo } from "react";
import {
  isSafeNoteLink,
  noteBlocks,
  parseInline,
  plainInline,
  type InlineNode,
  type NoteBlock,
} from "../../domains/tasks/noteMarkdown";
import { autolink } from "./TaskTitle";

function renderInline(nodes: InlineNode[], keyPrefix = "i"): React.ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.type) {
      case "text":
        return <React.Fragment key={key}>{autolink(node.text)}</React.Fragment>;
      case "strong":
        return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case "em":
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case "del":
        return <del key={key}>{renderInline(node.children, key)}</del>;
      case "code":
        return (
          <code key={key} className="note-markdown__code">
            {node.text}
          </code>
        );
      case "link":
        return isSafeNoteLink(node.href) ? (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="link-accent break-words"
            onClick={(event) => event.stopPropagation()}
          >
            {renderInline(node.children, key)}
          </a>
        ) : (
          <React.Fragment key={key}>{renderInline(node.children, key)}</React.Fragment>
        );
    }
  });
}

function Inline({ markdown }: { markdown: string }) {
  const nodes = useMemo(() => parseInline(markdown), [markdown]);
  return <>{renderInline(nodes)}</>;
}

/**
 * A task note's Markdown, rendered. With `onToggleChecklistItem`, checklist boxes are buttons
 * that report the item's line in the note (see `toggleChecklistItem`).
 */
export function NoteMarkdownView({
  note,
  blockLimit,
  onToggleChecklistItem,
  className = "",
}: {
  note: string;
  /** Renders only the first blocks and a trailing ellipsis, for compact previews. */
  blockLimit?: number;
  onToggleChecklistItem?: (line: number) => void;
  className?: string;
}) {
  const allBlocks = useMemo(() => noteBlocks(note), [note]);
  const blocks = blockLimit ? allBlocks.slice(0, blockLimit) : allBlocks;

  const renderBlock = (block: NoteBlock, index: number) => {
    const indent = "depth" in block ? { paddingLeft: `${block.depth * 1.25}rem` } : undefined;
    switch (block.type) {
      case "paragraph":
        return (
          <p key={index} className="note-markdown__paragraph">
            <Inline markdown={block.content} />
          </p>
        );
      case "heading":
        return (
          <div
            key={index}
            role="heading"
            aria-level={Math.min(block.level + 1, 6)}
            className={`note-markdown__heading note-markdown__heading--${Math.min(block.level, 4)}`}
          >
            <Inline markdown={block.content} />
          </div>
        );
      case "bullet":
        return (
          <div key={index} className="note-markdown__item" style={indent}>
            <span className="note-markdown__marker" aria-hidden="true">•</span>
            <span className="note-markdown__item-text">
              <Inline markdown={block.content} />
            </span>
          </div>
        );
      case "numbered":
        return (
          <div key={index} className="note-markdown__item" style={indent}>
            <span className="note-markdown__marker note-markdown__marker--number">{block.number}.</span>
            <span className="note-markdown__item-text">
              <Inline markdown={block.content} />
            </span>
          </div>
        );
      case "checklist": {
        const label = plainInline(block.content);
        return (
          <div
            key={index}
            className={`note-markdown__item note-markdown__item--check${block.checked ? " is-checked" : ""}`}
            style={indent}
          >
            {onToggleChecklistItem ? (
              <button
                type="button"
                role="checkbox"
                aria-checked={block.checked}
                aria-label={label || "Checklist item"}
                className="note-markdown__checkbox pressable"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleChecklistItem(block.line);
                }}
              >
                <CheckboxIcon checked={block.checked} />
              </button>
            ) : (
              <span className="note-markdown__checkbox" role="img" aria-label={block.checked ? "Checked" : "Unchecked"}>
                <CheckboxIcon checked={block.checked} />
              </span>
            )}
            <span className="note-markdown__item-text">
              <Inline markdown={block.content} />
            </span>
          </div>
        );
      }
      case "quote":
        return (
          <blockquote key={index} className="note-markdown__quote">
            <Inline markdown={block.content} />
          </blockquote>
        );
      case "code":
        return (
          <pre key={index} className="note-markdown__pre">
            <code>{block.content}</code>
          </pre>
        );
      case "rule":
        return <hr key={index} className="note-markdown__rule" />;
    }
  };

  return (
    <div className={`note-markdown ${className}`.trim()}>
      {blocks.map(renderBlock)}
      {blocks.length < allBlocks.length && <div className="note-markdown__more">…</div>}
    </div>
  );
}

function CheckboxIcon({ checked }: { checked: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <rect
        x="2"
        y="2"
        width="16"
        height="16"
        rx="4"
        fill={checked ? "var(--accent)" : "none"}
        stroke={checked ? "var(--accent)" : "currentColor"}
        strokeWidth="1.6"
      />
      {checked && (
        <path
          d="M6 10.5l2.6 2.6L14 7.6"
          fill="none"
          stroke="var(--accent-on, #061428)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
