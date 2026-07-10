import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    // Output to public/ so wrangler serves it as static assets
    outDir: path.resolve(__dirname, "../public"),
    emptyOutDir: true,
  },
  server: {
    // Proxy API calls to the wrangler dev server during development
    proxy: {
      "/api": "http://localhost:8787",
      "/terminal": "http://localhost:8787",
      "/preview": "http://localhost:8787",
      "/v1": "http://localhost:8787",
    },
  },
});
