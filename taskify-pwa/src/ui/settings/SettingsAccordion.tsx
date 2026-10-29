import React, { useId, useState } from "react";

export function SettingsAccordion({
  title,
  summary,
  children,
  nested = false,
}: {
  title: string;
  summary?: string;
  children: React.ReactNode;
  nested?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  return (
    <section
      className={`settings-accordion${nested ? " settings-accordion--nested" : ""}${expanded ? " is-expanded" : ""}`}
      data-settings-group
    >
      <button
        type="button"
        className="settings-accordion__header pressable"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="settings-accordion__title-copy">
          <span className="settings-accordion__title">{title}</span>
          {summary && <span className="settings-accordion__summary">{summary}</span>}
        </span>
        <span className="settings-accordion__chevron" aria-hidden="true">⌄</span>
      </button>
      {expanded && (
        <div id={contentId} className="settings-accordion__body" role="region" aria-label={title}>
          {children}
        </div>
      )}
    </section>
  );
}
