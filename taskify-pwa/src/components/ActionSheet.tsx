import React from "react";

export function ActionSheet({
  open,
  onClose,
  title,
  actions,
  children,
  stackLevel,
  panelClassName,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  stackLevel?: number;
  panelClassName?: string;
}) {
  if (!open) return null;
  return (
    <div
      className="sheet-backdrop"
      style={stackLevel != null ? { zIndex: stackLevel } : undefined}
      onClick={onClose}
    >
      <div
        className={panelClassName ? `sheet-panel ${panelClassName}` : "sheet-panel"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-panel__header">
          {title && <div className="font-semibold text-sm uppercase tracking-wide text-secondary">{title}</div>}
          <div className="flex items-center gap-2 ml-auto">
            {actions}
            <button className="ghost-button button-sm pressable" onClick={onClose}>Close</button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
