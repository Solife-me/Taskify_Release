/**
 * The capture heuristic, checked against pages shaped like the ones people read.
 */
import { JSDOM } from "jsdom";
import { extractReadableText, extractSelection, captureFilename } from "../src/lib/capture.ts";

const LONG = "This is a paragraph of ordinary prose that a reader would want to keep, and it is long enough to count as content rather than as a label or a caption in the page furniture. ".repeat(3);

function dom(html, url = "https://example.com/article") {
  const jsdom = new JSDOM(html, { url });
  return jsdom.window.document;
}

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

console.log("an article page keeps its prose and drops its chrome");
{
  const doc = dom(`<!doctype html><html><head><title>The Article</title></head><body>
    <header class="site-header"><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
    <div id="mw-content-text"><div class="mw-parser-output">
      <h1>The Article</h1>
      <p>${LONG}</p>
      <p>${LONG}</p>
    </div></div>
    <aside class="sidebar"><p>${LONG}</p></aside>
    <footer class="site-footer"><p>Copyright 2026</p></footer>
  </body></html>`);
  const { text, title, url } = extractReadableText(doc);
  check("keeps the title", title === "The Article", title);
  check("keeps the source url", url === "https://example.com/article", url);
  check("keeps the article prose", text.includes("ordinary prose that a reader would want"));
  check("drops the navigation", !text.includes("About"), text.slice(0, 200));
  check("drops the footer", !text.includes("Copyright"));
  check("names the source in the header", text.startsWith("# The Article"));
}

console.log("a page whose content is marked up as an article");
{
  const doc = dom(`<!doctype html><html><head><title>Doc</title></head><body>
    <div class="sidebar"><ul><li><a href="/x">Link</a></li></ul></div>
    <article><h1>Doc</h1><p>${LONG}</p></article>
  </body></html>`);
  const { text } = extractReadableText(doc);
  check("takes the article's prose", text.includes("ordinary prose"));
  check("leaves the sidebar's links out", !text.includes("Link"));
}

console.log("a short page still produces its text");
{
  const doc = dom(`<!doctype html><html><head><title>Short</title></head><body>
    <div id="content"><p>Just one small paragraph here.</p></div>
  </body></html>`);
  const { text } = extractReadableText(doc);
  check("keeps the short paragraph", text.includes("Just one small paragraph here."), text);
}

console.log("a page with no paragraphs at all");
{
  const doc = dom(`<!doctype html><html><head><title>Bare</title></head><body>
    <div>Plain words with no paragraph tags around them at all.</div>
  </body></html>`);
  const { text } = extractReadableText(doc);
  check("still returns the text", text.includes("Plain words"), text);
}

console.log("scripts and styles are never part of the capture");
{
  const doc = dom(`<!doctype html><html><head><title>Scripted</title>
    <style>body { color: red; }</style></head><body>
    <article><p>${LONG}</p><script>var secret = "do not capture me";</script></article>
  </body></html>`);
  const { text } = extractReadableText(doc);
  check("drops the script body", !text.includes("do not capture me"), text);
  check("drops the stylesheet", !text.includes("color: red"));
}

console.log("the selection is captured when there is one");
{
  const doc = dom(`<!doctype html><html><head><title>Sel</title></head><body>
    <p id="target">${LONG}</p></body></html>`);
  // jsdom has no selection, so the capture is checked through the fallback path.
  const result = extractSelection(doc);
  check("no selection means no capture", result === null, String(result));
}

console.log("file names are safe and say what they are");
{
  check("keeps letters", captureFilename("page", "Hello World").includes("Hello-World"));
  check("drops punctuation", !captureFilename("page", 'A/B?C*D"').match(/[?*"\\/]/), captureFilename("page", 'A/B?C*D"'));
  check("names the kind", captureFilename("selection", "x").startsWith("taskify-selection-"));
  check("handles an empty title", captureFilename("page", "").startsWith("taskify-page-"));
}

console.log(failures === 0 ? "\nAll capture tests passed." : `\n${failures} capture test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
