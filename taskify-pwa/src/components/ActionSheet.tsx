import React from "react";
import { createPortal } from "react-dom";
import { useEscapeToClose } from "../ui/useEscapeToClose";

export function ActionSheet({
  open,
  onClose,
  title,
  actions,
  header,
  children,
  stackLevel,
  panelClassName,
  inline = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  actions?: React.ReactNode;
  header?: React.ReactNode;
  children: React.ReactNode;
  stackLevel?: number;
  panelClassName?: string;
  inline?: boolean;
}) {
  useEscapeToClose(onClose, open && !inline);
  if (!open) return null;
  if (inline) {
    return (
      <div
        className={panelClassName ? `sheet-panel sheet-panel--inline ${panelClassName}` : "sheet-panel sheet-panel--inline"}
        style={stackLevel != null ? { zIndex: stackLevel } : undefined}
      >
        <div className="sheet-panel__header">
          {header ?? (
            <>
              {title && <div className="font-semibold text-sm uppercase tracking-wide text-secondary">{title}</div>}
              <div className="flex items-center gap-2 ml-auto">
                {actions}
                <button className="ghost-button button-sm pressable" onClick={onClose}>Close</button>
              </div>
            </>
          )}
        </div>
        {children}
      </div>
    );
  }
  const sheet = (
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
          {header ?? (
            <>
              {title && <div className="font-semibold text-sm uppercase tracking-wide text-secondary">{title}</div>}
              <div className="flex items-center gap-2 ml-auto">
                {actions}
                <button className="ghost-button button-sm pressable" onClick={onClose}>Close</button>
              </div>
            </>
          )}
        </div>
        {children}
      </div>
    </div>
  );
  const canPortal = typeof document !== "undefined";
  return canPortal ? createPortal(sheet, document.body) : sheet;
}
