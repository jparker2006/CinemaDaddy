import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "frontend",
  build: {
    // outDir is relative to `root` ("frontend"), so "../dist" lands at the
    // project root — the standard location Vercel's Vite preset expects.
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3100",
    },
  },
});
