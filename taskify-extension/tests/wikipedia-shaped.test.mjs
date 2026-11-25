/**
 * The capture against a page shaped like a Wikipedia article.
 *
 * The earlier build returned nothing for this page, because the container it picked was the
 * language list rather than the article body. This fixture has the same shape: a body whose
 * class is `mediawiki`, a header with a language list, a tools column, and the article inside
 * `#mw-content-text` under `.mw-parser-output`.
 */
import { JSDOM } from "jsdom";
import { extractReadableText } from "../src/lib/capture.ts";

const PARAGRAPH =
  "Nostr is a protocol for simple, open, and interoperable social media, built on Bitcoin and other blockchains. " +
  "It enables users to post and share data with a high degree of freedom and resilience. " +
  "Nostr uses public key cryptography, so users control their identity and content, and there are no central authorities.";

const html = `<!doctype html>
<html class="client-nojs" lang="en">
<head><title>Nostr - Wikipedia</title></head>
<body class="mediawiki ltr sitedir-ltr mw-hide-empty-elt ns-0 ns-subject page-Nostr">
  <div class="vector-header-container">
    <header class="vector-header mw-header">
      <div class="mw-portlet-lang"><nav><ul>
        <li><a href="/wiki/Deutsch">Deutsch</a></li>
        <li><a href="/wiki/Espa%C3%B1ol">Español</a></li>
        <li><a href="/wiki/%E4%B8%AD%E6%96%87">中文</a></li>
      </ul></nav></div>
    </header>
  </div>
  <div class="mw-page-container">
    <nav id="p-namespaces" class="mw-namespaces"><ul><li>Article</li><li>Talk</li></ul></nav>
    <div class="vector-body">
      <div class="vector-column-start">
        <div id="bodyContent">
          <div id="mw-content-text">
            <div class="mw-parser-output">
              <div class="mw-heading mw-heading2"><h2 id="History">History</h2></div>
              <p>${PARAGRAPH}</p>
              <p>${PARAGRAPH}</p>
              <p>${PARAGRAPH}</p>
              <div class="mw-heading mw-heading2"><h2 id="Protocol">Protocol</h2></div>
              <p>${PARAGRAPH}</p>
            </div>
          </div>
        </div>
        <div class="printfooter">Retrieved from "https://en.wikipedia.org/wiki/Nostr"</div>
      </div>
    </div>
  </div>
  <footer class="mw-footer"><ul><li>Privacy policy</li><li>About Wikipedia</li></ul></footer>
</body></html>`;

const doc = new JSDOM(html, { url: "https://en.wikipedia.org/wiki/Nostr" }).window.document;
const { text, title, url } = extractReadableText(doc);

console.log("title:", title);
console.log("length:", text.length);
console.log("--- first 700 ---");
console.log(text.slice(0, 700));

const checks = [
  ["keeps the article prose", text.includes("Nostr is a protocol for simple")],
  ["drops the language list", !text.includes("Español")],
  ["drops the page tools", !text.includes("Privacy policy")],
  ["drops the print footer", !text.includes("Retrieved from")],
  ["is substantial", text.length > 800],
  ["names the source", text.includes("https://en.wikipedia.org/wiki/Nostr")],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed += 1;
}
process.exit(failed ? 1 : 0);
