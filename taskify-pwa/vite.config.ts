import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    preserveSymlinks: true,
    dedupe: ["@nostr-dev-kit/ndk", "nostr-tools", "tseep"],
    alias: {
      "@gandlaf21/bc-ur": "@gandlaf21/bc-ur/dist/lib/es6/index.js",
      buffer: "buffer",
      process: "process/browser",
      stream: "stream-browserify",
      util: "util",
      events: "events",
    },
  },
  define: {
    global: "globalThis",
  },
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === "EVAL" && warning.id?.includes("node_modules/tseep/")) {
          return;
        }
        warn(warning);
      },
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
          if (id.includes("pdfjs-dist")) {
            return "pdf-worker";
          }
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
