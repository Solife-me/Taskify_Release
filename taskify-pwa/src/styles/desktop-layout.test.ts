import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/desktop-layout.css"), "utf8");

test("the same wide shell is available to mouse and touch devices", () => {
  expect(css).toContain("@media (min-width: 900px) {");
  expect(css).not.toContain("@media (min-width: 1024px) and (hover: hover) and (pointer: fine)");
  expect(css).toContain("@media (min-width: 900px) and (hover: none), (min-width: 900px) and (pointer: coarse)");
});

test("wide touch controls use touch-sized targets and native scrolling", () => {
  const touchRules = css.slice(css.lastIndexOf("@media (min-width: 900px) and (hover: none)"));
  expect(touchRules).toContain("min-height: 48px");
  expect(touchRules).toContain(".board-scroll-edge {");
  expect(touchRules).toContain("display: none");
  expect(touchRules).toContain("--desktop-rail-width: 11.5rem");
});
