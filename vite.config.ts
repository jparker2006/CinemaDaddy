import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "frontend",
  // Load .env from project root (one level up from `root: "frontend"`) so
  // VITE_SUPABASE_* vars sit alongside the server-only secrets in the same file.
  envDir: "../",
  build: {
    // outDir is relative to `root` ("frontend"), so "../dist" lands at the
    // project root — the standard location Vercel's Vite preset expects.
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy /api/* to the deployed Vercel function. Local `vercel dev`
      // refuses to bind to a non-3000 port in our setup, so we just hit
      // prod for the API during local dev. Costs prod Anthropic credits
      // per request but unblocks the full stack with `npm run dev`.
      "/api": {
        target: "https://cinema-daddy.vercel.app",
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
