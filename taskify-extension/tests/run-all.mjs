/**
 * The extension's tests, run in one go.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".test.mjs")).sort();
let failed = 0;
for (const file of files) {
  console.log(`\n──── ${file} ────`);
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", new URL(file, import.meta.url).pathname], {
    stdio: "inherit",
  });
  if (result.status !== 0) failed += 1;
}
console.log(failed === 0 ? "\n=== All test files passed. ===" : `\n=== ${failed} test file(s) failed. ===`);
process.exit(failed === 0 ? 0 : 1);
