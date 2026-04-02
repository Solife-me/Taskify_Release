import esbuild from "esbuild";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";

const OUT = "dist/index.js";

if (existsSync(OUT)) unlinkSync(OUT);

const NODE_BUILTINS = [
  "crypto", "fs", "path", "os", "url", "util", "stream", "events",
  "http", "https", "net", "tls", "zlib", "buffer", "process",
  "readline", "child_process", "worker_threads", "perf_hooks",
  "assert", "dns", "dgram", "querystring", "string_decoder",
  "timers", "v8", "vm", "module", "inspector",
];

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  outfile: OUT,
  format: "esm",
  external: [
    ...NODE_BUILTINS,
    ...NODE_BUILTINS.map((b) => `node:${b}`),
    "@nostr-dev-kit/ndk",
    "nostr-tools",
    "@noble/hashes/sha256",
    "@noble/hashes/utils",
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
let content = readFileSync(OUT, "utf8");
while (content.startsWith("#!")) {
  content = content.slice(content.indexOf("\n") + 1);
}
writeFileSync(OUT, "#!/usr/bin/env node\n" + content);

console.log("✓ dist/index.js bundled");
