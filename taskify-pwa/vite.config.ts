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
      // Compile the shared core from source, like our own code: dev and tests see core edits at
      // once, and no stale build of the linked package can be served or bundled.
      { find: /^taskify-core$/, replacement: fileURLToPath(new URL("../taskify-core/src/index.ts", import.meta.url)) },
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
    // Read by scripts/startup-budget.mjs; public/.assetsignore keeps it off the server.
    manifest: true,
    rolldownOptions: {
      output: {
        // Named vendor chunks, claimed highest priority first. A group also takes its modules'
        // dependencies, so shared foundations (React, the Nostr SDK) must be claimed before the
        // optional libraries that depend on them; otherwise React landed in the QR chunk and
        // every first visit downloaded the QR scanner. pdfjs-dist is left to default splitting.
        codeSplitting: {
          groups: [
            // Vite's lazy-chunk loader: claimed first, or the first group with a lazy import
            // (qr-scanner, pdfjs) takes it and becomes part of startup.
            { name: "vite-preload", test: /vite[\\/]preload-helper/, priority: 100 },
            // Node polyfills main.tsx installs at boot; inside the Cashu group they made every first
            // visit download the whole Cashu SDK for Buffer.
            {
              name: "node-polyfills",
              test: /[\\/]node_modules[\\/](buffer|base64-js|ieee754|process|events|util|inherits|stream-browserify|readable-stream|safe-buffer|string_decoder)[\\/]/,
              priority: 90,
            },
            { name: "react-vendor", test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 50 },
            // BIP39 (the wallet seed's word list) is left out: its group comes after this one, so it
            // holds only BIP39 itself and loads with the wallet seed, not at startup.
            { name: "crypto-primitives", test: /[\\/]node_modules[\\/]@(noble|scure[\\/](?!bip39[\\/]))/, priority: 40 },
            { name: "wallet-seed-words", test: /[\\/]node_modules[\\/]@scure[\\/]bip39[\\/]/, priority: 39 },
            {
              name: "nostr-sdk",
              test: /[\\/]node_modules[\\/](@nostr-dev-kit[\\/]ndk|nostr-tools|tseep|light-bolt11-decoder|typescript-lru-cache)[\\/]/,
              priority: 30,
            },
            {
              name: "cashu-sdk",
              test: /[\\/]node_modules[\\/](@cashu[\\/](cashu-ts|crypto)|@gandlaf21[\\/]bc-ur|bech32|cborg)[\\/]/,
              priority: 20,
            },
            { name: "qr-tools", test: /[\\/]node_modules[\\/](qr-scanner|qrcode\.react)[\\/]/, priority: 10 },
            { name: "spreadsheet-tools", test: /[\\/]node_modules[\\/][^\\/]*xlsx[^\\/]*[\\/]/, priority: 10 },
          ],
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
