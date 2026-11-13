import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "client",
  plugins: [react()],
  build: { outDir: "../dist/client", emptyOutDir: true },
  server: {
    // The API, and the public pages the server writes itself (server/publicPages.ts).
    proxy: Object.fromEntries(["/api", "/home", "/privacy", "/terms"].map((path) => [path, `http://localhost:${process.env.PORT ?? 3000}`])),
  },
});
