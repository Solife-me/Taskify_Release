import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * The extension is built as three separate entry points, because Chrome MV3 gives each of them a
 * different origin and lifecycle:
 *   - `panel`  : the side panel document (an extension page, so it has a real DOM and storage)
 *   - `content`: the script injected into the page being read, for capture
 *   - `worker` : the background service worker, for the action button and tab bookkeeping
 *
 * `taskify-core` and `taskify-runtime-nostr` are compiled from source, exactly as the PWA does it,
 * so a change in either is visible here without a separate build step.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    preserveSymlinks: true,
    dedupe: ["@nostr-dev-kit/ndk", "nostr-tools"],
    alias: [
      { find: /^taskify-core$/, replacement: fileURLToPath(new URL("../taskify-core/src/index.ts", import.meta.url)) },
      { find: /^taskify-runtime-nostr$/, replacement: fileURLToPath(new URL("../taskify-runtime-nostr/src/index.ts", import.meta.url)) },
      // NDK's emitter, tseep, compiles its dispatch functions with `eval`, which an extension's
      // CSP blocks. The PWA swaps in the same shim; see taskify-pwa/src/lib/eventEmitterShim.ts.
      { find: /^tseep$/, replacement: fileURLToPath(new URL("./src/lib/eventEmitterShim.ts", import.meta.url)) },
    ],
  },
  define: { global: "globalThis" },
  build: {
    manifest: true,
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        panel: fileURLToPath(new URL("./src/panel.html", import.meta.url)),
        content: fileURLToPath(new URL("./src/content.ts", import.meta.url)),
        background: fileURLToPath(new URL("./src/background.ts", import.meta.url)),
      },
      output: {
        // The manifest points at `panel.html`, `background.js` and `content.js` at the root of the
        // bundle, so the panel's html is emitted there too.
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
