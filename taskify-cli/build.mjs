import esbuild from "esbuild";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";

const INDEX_OUT = "dist/index.js";
const CLI_OUT = "dist/cli.js";
// The runtime facade on its own, for tests that drive it against a loopback relay.
const RUNTIME_OUT = "dist/runtime.js";

for (const output of [INDEX_OUT, CLI_OUT, RUNTIME_OUT]) {
  if (existsSync(output)) unlinkSync(output);
}

const NODE_BUILTINS = [
  "crypto", "fs", "path", "os", "url", "util", "stream", "events",
  "http", "https", "net", "tls", "zlib", "buffer", "process",
  "readline", "child_process", "worker_threads", "perf_hooks",
  "assert", "dns", "dgram", "querystring", "string_decoder",
  "timers", "v8", "vm", "module", "inspector",
];

await esbuild.build({
  entryPoints: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    runtime: "src/nostrRuntime.ts",
  },
  bundle: true,
  platform: "node",
  target: "node22",
  outdir: "dist",
  format: "esm",
  external: [
    ...NODE_BUILTINS,
    ...NODE_BUILTINS.map((b) => `node:${b}`),
    "@nostr-dev-kit/ndk",
    "nostr-tools",
    "@noble/hashes/utils.js",
  ],
  // Provide a require() shim so bundled CJS deps (commander etc.) work in ESM context
  banner: {
    js: `import { createRequire as _cr } from "module"; const require = _cr(import.meta.url);`,
  },
  logLevel: "warning",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

// Strip any shebang lines, prepend exactly one
let content = readFileSync(INDEX_OUT, "utf8");
while (content.startsWith("#!")) {
  content = content.slice(content.indexOf("\n") + 1);
}
writeFileSync(INDEX_OUT, "#!/usr/bin/env node\n" + content);

console.log("✓ dist/index.js, dist/cli.js and dist/runtime.js bundled");
