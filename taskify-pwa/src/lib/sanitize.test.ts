// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { sanitizeHtml } from "./sanitize";

describe("sanitizeHtml", () => {
  test("strips <script> tags", () => {
    const out = sanitizeHtml("<p>hello</p><script>window.__pwn = 1</script>");
    expect(out).toBe("<p>hello</p>");
    expect(out.toLowerCase()).not.toContain("<script");
  });

  test("strips inline event handlers (onerror, onclick, etc.)", () => {
    const out = sanitizeHtml('<img src="x" onerror="window.__pwn=1" /><a onclick="alert(1)">x</a>');
    expect(out.toLowerCase()).not.toContain("onerror");
    expect(out.toLowerCase()).not.toContain("onclick");
  });

  test("strips javascript: URIs in href and src", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a><img src="javascript:alert(1)">');
    expect(out.toLowerCase()).not.toContain("javascript:");
  });

  test("preserves table structure used by xlsx/docx renderers", () => {
    const html = "<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>";
    expect(sanitizeHtml(html)).toBe(html);
  });

  test("preserves headings, lists, and basic inline formatting", () => {
    const html = "<h1>Title</h1><p><strong>bold</strong> <em>italic</em></p><ul><li>a</li><li>b</li></ul>";
    expect(sanitizeHtml(html)).toBe(html);
  });

  test("strips <iframe> and <object> tags", () => {
    const out = sanitizeHtml('<iframe src="https://evil.example"></iframe><object data="x"></object>');
    expect(out.toLowerCase()).not.toContain("<iframe");
    expect(out.toLowerCase()).not.toContain("<object");
  });
});
