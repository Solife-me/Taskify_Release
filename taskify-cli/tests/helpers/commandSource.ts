import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** Source contract checks follow registration modules after entry-point extraction. */
export function commandSource(): string {
  const src = path.resolve(import.meta.dirname, "../../src");
  return [readFileSync(path.join(src, "index.ts"), "utf8"), ...readdirSync(path.join(src, "commands"))
    .filter(name => name.endsWith(".ts"))
    .sort()
    .map(name => readFileSync(path.join(src, "commands", name), "utf8"))].join("\n");
}
