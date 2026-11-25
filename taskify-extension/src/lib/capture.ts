/**
 * Page capture: turning the page the user is reading into something an AI agent can use.
 *
 * Three shapes, matching what the ChatGPT-style browser attach menu offers:
 *   - `text`   : the page's readable text, extracted from its main content
 *   - `selection`: whatever the user had selected
 *   - `screenshot`: a picture of the page (captured by the background worker)
 *
 * The extraction here is deliberately dependency-free and conservative. It prefers the page's own
 * idea of its main content (`<main>`, `<article>`, `role="main"`) and falls back to a density
 * scan of the body, so a page's navigation, headers and footers do not end up in the context.
 * Nothing is fetched: the capture reads the DOM the browser already has.
 */

/** The result of one capture, as it travels from the content script to the panel. */
export type PageCapture = {
  kind: "text" | "selection" | "screenshot";
  /** The URL the capture came from, so the agent knows what it is looking at. */
  url: string;
  /** The page title, for the same reason. */
  title: string;
  /** The captured text. Empty for a screenshot. */
  text?: string;
  /** The file name the capture should be saved under. */
  filename: string;
  /** The MIME type of the file the capture becomes. */
  mimeType: string;
  /** Where in the page the selection started, for the caption. */
  selectionInfo?: { text: string; truncated: boolean };
};

/** How much text one capture may carry. A page longer than this is cut, with a marker. */
export const MAX_CAPTURE_CHARS = 200_000;

/** The largest selection kept, in characters. */
export const MAX_SELECTION_CHARS = 20_000;

const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION",
  "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HGROUP", "HR", "LI",
  "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD",
  "TR", "UL",
]);

/** Elements that hold no readable prose, only chrome or code. */
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "EMBED",
  "OBJECT", "AUDIO", "VIDEO", "CANVAS", "MAP", "AREA", "PARAM", "SOURCE", "TRACK", "BUTTON",
]);

/** Classes and ids that mark furniture rather than content. */
const NOISE_PATTERN =
  /(^|[\s_-])(nav|navbar|menu|sidebar|side-bar|footer|header|masthead|banner|breadcrumb|cookie|consent|gdpr|popup|modal|overlay|advert|advertisement|ads?|promo|subscribe|newsletter|social|share|sharing|related|recommend|toolbar|pagination|pagination|skip-link|copyright|legal|search|printfooter|print-footer|catlinks|reflist|navbox|infobox|metadata)([\s_-]|$)/i;

/** Class names that mark the main content of a page. */
const CONTENT_PATTERN = /(^|[\s_-])(content|article|articlebody|post|postbody|entry|main|maincontent|story|text|prose|markdown|blog)([\s_-]|$)/i;

function isVisible(element: Element): boolean {
  const html = element as HTMLElement;
  if (html.hidden) return false;
  if (html.getAttribute("aria-hidden") === "true") return false;
  const view = element.ownerDocument?.defaultView;
  if (!view) return true;
  const style = view.getComputedStyle(html);
  if (!style) return true;
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (Number(style.opacity) === 0) return false;
  return true;
}

function looksLikeNoise(element: Element): boolean {
  const marker = `${element.id ?? ""} ${element.className ?? ""}`;
  if (!marker.trim()) return false;
  return NOISE_PATTERN.test(marker);
}

function looksLikeContent(element: Element): boolean {
  const marker = `${element.id ?? ""} ${element.className ?? ""}`;
  if (!marker.trim()) return false;
  return CONTENT_PATTERN.test(marker);
}

/** The block-level text of one element, with its children's structure kept. */
function blockText(element: Element): string {
  const parts: string[] = [];
  const textNode = 3; // Node.TEXT_NODE, without needing the global.
  const walk = (node: Node) => {
    if (node.nodeType === textNode) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ");
      if (text.trim()) parts.push(text.trim());
      return;
    }
    const element = node as Element;
    if (typeof element.tagName !== "string") return;
    const tag = element.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    // Chrome inside the content area (a sidebar, a tools menu, a language list) is not content.
    if (tag === "NAV" || tag === "ASIDE" || tag === "FOOTER") return;
    if (looksLikeNoise(element)) return;
    if (tag === "BR") {
      parts.push("\n");
      return;
    }
    if (BLOCK_TAGS.has(tag)) {
      const before = parts.length;
      for (const child of Array.from(element.childNodes)) walk(child);
      if (parts.length > before) parts.push("\n");
      return;
    }
    for (const child of Array.from(element.childNodes)) walk(child);
  };
  walk(element);
  return parts
    .join(" ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * How much prose an element holds: the text of its paragraphs, plus that of its list items.
 *
 * Paragraphs are what distinguish an article from a navigation menu, a table of contents or a
 * sidebar of links, so this is a better measure of "the content" than raw text length.
 */
function proseLength(element: Element): number {
  let total = 0;
  for (const node of Array.from(element.querySelectorAll("p, li, dd, blockquote, pre, figcaption"))) {
    if (looksLikeNoise(node)) continue;
    if (node.closest("nav, aside, footer, header")) continue;
    const text = (node.textContent ?? "").trim();
    // Very short paragraphs are usually labels and captions rather than prose, so they count for
    // less. A long one counts fully.
    if (text.length > 40) total += text.length;
    else if (text.length > 12) total += text.length / 4;
  }
  return total;
}

/**
 * The element that holds the page's main content.
 *
 * The page's own markup is trusted when it is clear: an `<article>` is the content by
 * definition. Otherwise the container with the most prose wins, which finds the article body on
 * pages that wrap their content in a `<div>` with an unhelpful name.
 */
function findContentRoot(doc: Document): Element {
  // An explicit article is the best signal there is.
  const article = doc.querySelector("article, [role='article']");
  if (article && isVisible(article) && proseLength(article) > 200) {
    return article;
  }

  // Otherwise, the container holding the most prose. The page as a whole is the yardstick: a
  // candidate has to hold a good share of it to be the content, so a sidebar with a few long
  // paragraphs cannot beat the article, and a media-description page (where the whole page is
  // one short caption) still resolves to the body.
  const body = doc.body ?? doc.documentElement;
  const bodyProse = proseLength(body);
  let best: Element = body;
  let bestProse = bodyProse;
  const candidates = doc.querySelectorAll("div, section, main, td, article");
  for (const candidate of Array.from(candidates)) {
    if (!isVisible(candidate)) continue;
    if (looksLikeNoise(candidate)) continue;
    const prose = proseLength(candidate);
    if (prose <= bestProse) continue;
    if (bodyProse > 0 && prose < bodyProse * 0.5) continue;
    bestProse = prose;
    best = candidate;
  }
  return best;
}

/** The page's readable text, as Markdown-ish plain text with a source header. */
export function extractReadableText(doc: Document = document): { text: string; title: string; url: string } {
  const title = (doc.title || "").trim() || doc.location?.hostname || "Untitled page";
  const url = doc.location?.href ?? "";
  const root = findContentRoot(doc);
  const raw = blockText(root);
  const cleaned = raw
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter((line, index, lines) => {
      // Collapse runs of identical adjacent lines, which many pages produce from icons.
      if (index === 0) return true;
      return !(line === lines[index - 1] && line.length < 3);
    })
    .join("\n")
    .trim();

  const truncated = cleaned.length > MAX_CAPTURE_CHARS;
  const body = truncated ? `${cleaned.slice(0, MAX_CAPTURE_CHARS)}\n\n[Content truncated]` : cleaned;
  const header = `# ${title}\n\nSource: ${url}\n\n`;
  return { text: `${header}${body}\n`, title, url };
}

/** The user's current selection, if any. */
export function extractSelection(doc: Document = document): { text: string; title: string; url: string } | null {
  const selection = doc.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const raw = selection.toString().trim();
  if (!raw) return null;
  const truncated = raw.length > MAX_SELECTION_CHARS;
  const text = truncated ? `${raw.slice(0, MAX_SELECTION_CHARS)}\n\n[Selection truncated]` : raw;
  return {
    text: `# ${(doc.title || "Selection").trim()}\n\nSource: ${doc.location?.href ?? ""}\n\n---\n\n${text}\n`,
    title: doc.title || "Selection",
    url: doc.location?.href ?? "",
  };
}

/** A file name that says what the capture is, without anything a file system would object to. */
export function captureFilename(kind: PageCapture["kind"], title: string): string {
  const safe = (title || "page")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || "page";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `taskify-${kind}-${safe}-${stamp}.md`;
}
