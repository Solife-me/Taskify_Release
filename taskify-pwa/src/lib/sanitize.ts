import DOMPurify, { type DOMPurify as DOMPurifyInstance } from "dompurify";

// Single sanitization point for HTML rendered via dangerouslySetInnerHTML.
// Inputs come from mammoth (docx), the spreadsheet renderer, and markdown-it,
// but the stored preview HTML is written by whichever board member attached
// the file, so it is treated as hostile.
//
// Beyond DOMPurify's defaults (no script, event handlers, or javascript: URIs):
// - nothing loads from the network: media sources must be data: or blob:, and
//   srcset, background, poster, and inline styles are dropped, so a document
//   cannot act as a tracking pixel for every member who sees the card;
// - no forms or inputs, so a document cannot pose as the app and collect text;
// - no <style>, inline styles, or app class names, so it cannot restyle or
//   cover the app;
// - ids and names are prefixed so they cannot clash with the app's own;
// - links open in a new tab instead of replacing the app.

const FORBID_TAGS = ["style", "form", "input", "button", "select", "textarea", "option", "label", "fieldset", "dialog"];
const FORBID_ATTR = ["style", "srcset", "background", "poster", "action", "formaction", "ping"];
const LOCAL_MEDIA_SOURCE = /^(?:data:|blob:)/i;
// Classes the document converters emit (`doc-rich`, `doc-sheet__tab`, `docx-table`, ...).
const DOCUMENT_CLASS = /^docx?-/;

let purifier: DOMPurifyInstance | null = null;

function getPurifier(): DOMPurifyInstance {
  if (purifier) return purifier;
  const instance = DOMPurify(window);
  instance.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    if (typeof el.getAttribute !== "function") return;
    const src = el.getAttribute("src");
    if (src !== null && !LOCAL_MEDIA_SOURCE.test(src.trim())) el.removeAttribute("src");
    const className = el.getAttribute("class");
    if (className !== null) {
      const kept = className.split(/\s+/).filter((name) => DOCUMENT_CLASS.test(name));
      if (kept.length) el.setAttribute("class", kept.join(" "));
      else el.removeAttribute("class");
    }
    if (el.tagName === "A" && el.hasAttribute("href")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  });
  purifier = instance;
  return instance;
}

export function sanitizeHtml(input: string): string {
  return getPurifier().sanitize(input, {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR,
    SANITIZE_NAMED_PROPS: true,
  });
}
