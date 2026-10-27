import { useEffect, useRef } from "react";

/**
 * Escape closes the top-most open layer (dialog, sheet, pane, popover), one layer per press.
 * Each layer registers while open; layers opened later sit above earlier ones. In a text field,
 * the first Escape only leaves the field, so a half-typed title is not thrown away.
 */
const layers: { close: () => void }[] = [];
let listening = false;

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented || layers.length === 0) return;
  event.preventDefault();
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches('input, textarea, select, [contenteditable="true"]')) {
    active.blur();
    return;
  }
  layers[layers.length - 1].close();
}

export function useEscapeToClose(onClose: () => void, enabled = true): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!enabled) return;
    const layer = { close: () => closeRef.current() };
    layers.push(layer);
    if (!listening) {
      document.addEventListener("keydown", onKeyDown);
      listening = true;
    }
    return () => {
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
    };
  }, [enabled]);
}

/** Whether a dialog, sheet, pane or popover is open, so page shortcuts should stand aside. */
export function hasOpenLayer(): boolean {
  return layers.length > 0;
}
