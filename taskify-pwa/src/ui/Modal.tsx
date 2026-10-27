import React from "react";
import { useEscapeToClose } from "./useEscapeToClose";

/**
 * Generic modal. `variant="fullscreen"` is a full-height sheet on phones; `desktop` says how it
 * appears on a desktop instead: an editor docks as a side `pane` so the board stays in view, a
 * short form becomes a centered `dialog`. Escape closes the top-most modal.
 */
export function Modal({
  children,
  onClose,
  title,
  actions,
  showClose = true,
  variant = "default",
  desktop,
}: React.PropsWithChildren<{
  onClose: () => void;
  title?: React.ReactNode;
  actions?: React.ReactNode;
  showClose?: boolean;
  variant?: "default" | "fullscreen";
  desktop?: "pane" | "dialog";
}>) {
  useEscapeToClose(onClose);
  const desktopClass = desktop ? ` modal-backdrop--${desktop}` : "";
  const backdropClass =
    (variant === "fullscreen" ? "modal-backdrop modal-backdrop--fullscreen" : "modal-backdrop") + desktopClass;
  const panelClass =
    (variant === "fullscreen" ? "modal-panel modal-panel--fullscreen" : "modal-panel") +
    (desktop ? ` modal-panel--${desktop}` : "");
  const headerClass =
    variant === "fullscreen"
      ? "modal-panel__header modal-panel__header--spaced"
      : "modal-panel__header";
  const bodyClass =
    variant === "fullscreen"
      ? "modal-panel__body modal-panel__body--fullscreen"
      : "modal-panel__body";

  return (
    <div className={backdropClass}>
      <div className={panelClass}>
        {(title || actions || showClose) && (
          <div className={headerClass}>
            {title && <div className="text-lg font-semibold text-primary">{title}</div>}
            {(actions || showClose) && (
              <div className="ml-auto flex items-center gap-2">
                {actions}
                {showClose && (
                  <button className="ghost-button button-sm pressable" onClick={onClose}>
                    Close
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <div className={bodyClass}>{children}</div>
      </div>
    </div>
  );
}
