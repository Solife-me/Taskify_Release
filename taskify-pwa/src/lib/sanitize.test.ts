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

  test("loads nothing from the network: remote media, srcset, background, styles", () => {
    const out = sanitizeHtml(
      '<img src="https://tracker.example/p.gif" alt="a"><img srcset="https://tracker.example/a 1x">' +
        '<table background="https://tracker.example/t"><tr><td>x</td></tr></table>' +
        '<div style="background:url(https://tracker.example/bg)">s</div>' +
        '<video src="https://tracker.example/v" poster="https://tracker.example/p"></video>',
    );
    expect(out).not.toContain("tracker.example");
  });

  test("keeps embedded images from documents", () => {
    const out = sanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=" alt="chart">');
    expect(out).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });

  test("drops forms, inputs, and <style>", () => {
    const out = sanitizeHtml(
      '<style>body{display:none}</style><form action="https://evil.example"><input name="seed"><textarea></textarea><button>Restore</button></form><p>ok</p>',
    );
    expect(out).toBe("Restore<p>ok</p>");
  });

  test("keeps only document classes and prefixes ids", () => {
    const out = sanitizeHtml('<div class="doc-rich fixed inset-0 z-50" id="eruda"><h1 class="doc-title">T</h1></div>');
    expect(out).toBe('<div class="doc-rich" id="user-content-eruda"><h1 class="doc-title">T</h1></div>');
  });

  test("links open in a new tab", () => {
    const out = sanitizeHtml('<a href="https://example.com/x">x</a>');
    expect(out).toBe('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">x</a>');
  });
});
