import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const walletVendors = [
  "@cashu/cashu-ts",
  "@nostr-dev-kit/ndk",
  "nostr-tools",
  "qr-scanner",
  "qrcode.react",
  "@noble/curves",
  "@noble/hashes",
];

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (walletVendors.some((pkg) => id.includes(pkg))) {
            return "wallet-sdk";
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
});
