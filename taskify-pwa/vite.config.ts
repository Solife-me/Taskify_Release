import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    preserveSymlinks: true,
    dedupe: ["@nostr-dev-kit/ndk", "nostr-tools", "tseep"],
    alias: [
      { find: "@gandlaf21/bc-ur", replacement: "@gandlaf21/bc-ur/dist/lib/es6/index.js" },
      // NDK's emitter, tseep, compiles its dispatch functions with eval, which the CSP blocks.
      { find: /^tseep$/, replacement: fileURLToPath(new URL("./src/lib/eventEmitterShim.ts", import.meta.url)) },
      { find: "buffer", replacement: "buffer" },
      { find: "process", replacement: "process/browser" },
      { find: "stream", replacement: "stream-browserify" },
      { find: "util", replacement: "util" },
      { find: "events", replacement: "events" },
    ],
  },
  define: {
    global: "globalThis",
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (
            id.includes("@cashu/cashu-ts") ||
            id.includes("@cashu/crypto") ||
            id.includes("@gandlaf21/bc-ur") ||
            id.includes("bech32") ||
            id.includes("cborg")
          ) {
            return "cashu-sdk";
          }
          if (
            id.includes("@nostr-dev-kit/ndk") ||
            id.includes("nostr-tools") ||
            id.includes("tseep") ||
            id.includes("light-bolt11-decoder") ||
            id.includes("typescript-lru-cache")
          ) {
            return "nostr-sdk";
          }
          if (id.includes("@noble/") || id.includes("@scure/")) {
            return "crypto-primitives";
          }
          if (id.includes("qr-scanner") || id.includes("qrcode.react")) {
            return "qr-tools";
          }
          // pdfjs-dist is left to the default splitting. As a manual chunk it received the
          // bundler's dynamic-import helper, so every lazy import (the entry's included) pulled
          // the whole PDF library into startup.
          if (id.includes("xlsx")) {
            return "spreadsheet-tools";
          }
          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    include: [
      "@gandlaf21/bc-ur",
      "@nostr-dev-kit/ndk",
      "nostr-tools",
      "tseep",
      "buffer",
      "process",
      "stream-browserify",
      "util",
      "events",
    ],
    exclude: ["taskify-runtime-nostr"],
  },
});
