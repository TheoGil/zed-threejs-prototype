import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  server: { port: 8000 },
  preview: { port: 8000 },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "esnext", // main.js uses top-level await
  },
});
