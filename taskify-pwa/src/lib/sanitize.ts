import DOMPurify from "dompurify";

// Single sanitization point for HTML rendered via dangerouslySetInnerHTML.
// Inputs come from mammoth (docx), xlsx, and markdown-it output — all of
// which can in principle smuggle scripted content if a library bug or
// crafted file slips raw HTML through. Sanitizing on render is the
// defensive layer regardless of upstream guarantees.
//
// Defaults strip <script>, event handlers (onerror/onclick/...), and
// javascript: URIs while preserving tables, headings, lists, inline
// styles, and image data: URIs needed by docx/xlsx/markdown previews.
export function sanitizeHtml(input: string): string {
  return DOMPurify.sanitize(input, { USE_PROFILES: { html: true } });
}
