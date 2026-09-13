// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { useAppAppearance } from "./useAppAppearance";
import type { AccentPalette } from "./palette";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
function Harness(props: Parameters<typeof useAppAppearance>[0]) { useAppAppearance(props); return null; }
const base: ComponentProps<typeof Harness> = { baseFontSize: 16, accent: "green", backgroundAccent: null, backgroundImage: null, backgroundBlur: "blurred" };
async function render(props: ComponentProps<typeof Harness>) {
  root ??= createRoot(document.createElement("div"));
  await act(async () => root!.render(<Harness {...props} />));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("data-accent");
  document.documentElement.removeAttribute("data-background-image");
  document.head.innerHTML = "";
});

test("applies dark theme, clamps font size, and removes a previous accent", async () => {
  document.documentElement.className = "light";
  await render({ ...base, baseFontSize: 30 });
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.documentElement.classList.contains("light")).toBe(false);
  expect(document.documentElement.style.fontSize).toBe("22px");
  expect(document.documentElement.dataset.accent).toBe("green");
  await render({ ...base, baseFontSize: 10, accent: "blue" });
  expect(document.documentElement.style.fontSize).toBe("");
  expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
});

test("applies custom palette and status bar color, then clears custom styles", async () => {
  document.head.innerHTML = '<meta name="theme-color" content="old">';
  const palette = { fill: "#123456", hover: "#234567", active: "#345678", soft: "#456789", border: "#567890", on: "#ffffff", glow: "#678901" } as AccentPalette;
  await render({ ...base, accent: "background", backgroundAccent: palette });
  const style = document.documentElement.style;
  expect(style.getPropertyValue("--accent")).toBe(palette.fill);
  expect(style.getPropertyValue("--background-gradient")).toContain("rgba(18, 52, 86, 0.24)");
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(palette.fill);
  await render(base);
  expect(style.getPropertyValue("--accent")).toBe("");
  expect(style.getPropertyValue("--background-gradient")).toBe("");
  expect(style.getPropertyValue("--status-bar-color")).toBe("#050508");
});

test("releases background object URLs when replaced, removed, and unmounted", async () => {
  const create = vi.fn().mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second").mockReturnValueOnce("blob:third");
  const revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  const image = "data:image/png;base64,YQ==";
  await render({ ...base, backgroundImage: image });
  expect(document.documentElement.style.getPropertyValue("--background-image")).toContain("blob:first");
  await render({ ...base, backgroundImage: image, backgroundBlur: "sharp" });
  expect(revoke).toHaveBeenCalledWith("blob:first");
  expect(document.documentElement.style.getPropertyValue("--background-image-filter")).toBe("none");
  await render(base);
  expect(revoke).toHaveBeenCalledWith("blob:second");
  expect(document.documentElement.style.getPropertyValue("--background-image")).toBe("");
  expect(document.documentElement.hasAttribute("data-background-image")).toBe(false);
  await render({ ...base, backgroundImage: image });
  await act(async () => root!.unmount());
  root = undefined;
  expect(revoke).toHaveBeenCalledWith("blob:third");
});

test("falls back to the saved image when object URL creation fails", async () => {
  vi.stubGlobal("URL", { createObjectURL: () => { throw new Error("Unavailable"); }, revokeObjectURL: vi.fn() });
  await render({ ...base, backgroundImage: "data:image/png;base64,YQ==" });
  expect(document.documentElement.style.getPropertyValue("--background-image")).toContain("data:image/png;base64,YQ==");
});
