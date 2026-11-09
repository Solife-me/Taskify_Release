import { expect, test } from "vitest";
import headers from "../../public/_headers?raw";
import manifest from "../../public/manifest.webmanifest?raw";
import serviceWorker from "../../public/sw.js?raw";
import indexHtml from "../../index.html?raw";

test("keeps iOS standalone metadata while opting Android into keyboard-safe resizing", () => {
  expect(indexHtml).toContain('name="apple-mobile-web-app-capable" content="yes"');
  expect(indexHtml).toContain('name="apple-mobile-web-app-status-bar-style" content="black-translucent"');
  expect(indexHtml).toContain('rel="apple-touch-icon"');
  expect(indexHtml).toContain("viewport-fit=cover");
  expect(indexHtml).toContain("interactive-widget=resizes-content");
});

test("publishes stable identity, Android shortcuts, and richer install metadata", () => {
  const parsed = JSON.parse(manifest);
  expect(parsed.id).toBe("/");
  expect(parsed.scope).toBe("/");
  expect(parsed.description).toMatch(/task/i);
  expect(parsed.categories).toContain("productivity");
  expect(parsed.shortcuts.map((shortcut: { url: string }) => shortcut.url)).toEqual([
    "/quick-add",
    "/upcoming",
    "/chat",
  ]);
  expect(parsed.theme_color).toBe("#050508");
  expect(indexHtml).toContain('name="theme-color" content="#050508"');
});

test("caches hashed assets immutably while keeping the worker revalidated", () => {
  expect(headers).toMatch(/\/assets\/\*[\s\S]*max-age=31536000, immutable/);
  expect(headers).toMatch(/\/sw\.js[\s\S]*Cache-Control: no-cache/);
});

test("brands Android notifications with the Taskify icon", () => {
  expect(serviceWorker.match(/icon: '\/icon-192\.png'/g)).toHaveLength(3);
});
