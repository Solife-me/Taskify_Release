/**
 * Vite writes the panel's HTML to `dist/src/panel.html`, because the entry lives under `src/`.
 * The manifest names `panel.html` at the root of the bundle, so the file is moved there and the
 * now-empty `src` directory removed.
 */
import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dist = new URL("../dist/", import.meta.url).pathname;
const from = join(dist, "src", "panel.html");
const to = join(dist, "panel.html");

if (!existsSync(from)) {
  console.error(`Expected ${from} to exist.`);
  process.exit(1);
}
mkdirSync(dist, { recursive: true });
copyFileSync(from, to);
rmSync(join(dist, "src"), { recursive: true, force: true });
console.log("panel.html moved to the bundle root.");
