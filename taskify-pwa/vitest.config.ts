import { defineConfig, mergeConfig } from "vite";
import { fileURLToPath } from "node:url";
import viteConfig from "./vite.config";

// Test-only overrides. The build config carries `preserveSymlinks: true` so
// rolldown sees the symlinked `taskify-runtime-nostr` package via the linker
// path; that lets imports inside its precompiled `dist/*.js` resolve to
// `taskify-pwa/node_modules/@noble/hashes` etc. Vitest's loader, however,
// hits the symlink target's real path and walks up from there — where
// neither `node_modules/@noble/hashes` nor any sibling package exists —
// and the test bails out with `Cannot find package '@noble/hashes'`.
//
// Aliasing the package to its TypeScript source sidesteps the issue: the
// source files use the same import paths, but vitest then transforms them
// through this `taskify-pwa` project, so its `node_modules` is the active
// resolution root and `@noble/hashes` is found normally.
const runtimeNostrSrc = fileURLToPath(new URL("../taskify-runtime-nostr/src/index.ts", import.meta.url));

export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: {
      alias: {
        "taskify-runtime-nostr": runtimeNostrSrc,
      },
    },
  }),
);
