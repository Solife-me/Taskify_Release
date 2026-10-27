// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { hasOpenLayer, useEscapeToClose } from "./useEscapeToClose";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Layer({ onClose, open = true }: { onClose: () => void; open?: boolean }) {
  useEscapeToClose(onClose, open);
  return null;
}

const pressEscape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));

test("Escape closes only the top-most open layer, and a text field is left first", async () => {
  const outer = vi.fn();
  const inner = vi.fn();
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<><Layer onClose={outer} /><Layer onClose={inner} /><Layer onClose={vi.fn()} open={false} /></>));
  expect(hasOpenLayer()).toBe(true);

  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  pressEscape();
  expect(document.activeElement).not.toBe(input);
  expect(inner).not.toHaveBeenCalled();

  pressEscape();
  expect(inner).toHaveBeenCalledOnce();
  expect(outer).not.toHaveBeenCalled();

  await act(async () => root.render(<Layer onClose={outer} />));
  pressEscape();
  expect(outer).toHaveBeenCalledOnce();

  await act(async () => root.unmount());
  expect(hasOpenLayer()).toBe(false);
  input.remove();
});
