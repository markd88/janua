import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/admin/",
  root: "src",
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "admin.js",
        chunkFileNames: "admin-[hash].js",
        assetFileNames: "admin-[hash][extname]",
      },
    },
  },
});
