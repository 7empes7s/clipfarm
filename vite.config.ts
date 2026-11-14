import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const page = (name: string) => fileURLToPath(new URL(`client/${name}.html`, import.meta.url));

/** In dev, /portal (and its hash routes) is the client portal's page, as the server serves it in production. */
const portalPage: Plugin = {
  name: "clipfarm-portal-page",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === "/portal" || req.url?.startsWith("/portal?") || req.url === "/portal/") req.url = `/portal.html${req.url.slice(req.url.indexOf("?") >= 0 ? req.url.indexOf("?") : req.url.length)}`;
      next();
    });
  },
};

export default defineConfig({
  root: "client",
  plugins: [react(), portalPage],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    rollupOptions: { input: { main: page("index"), portal: page("portal") } },
  },
  server: {
    // The API, and the pages the server writes itself (server/publicPages.ts, server/service/).
    proxy: Object.fromEntries(
      ["/api", "/home", "/privacy", "/terms", "/service", "/pricing", "/portal/auth", "/portal/fake-", "/oauth"].map((path) => [path, `http://localhost:${process.env.PORT ?? 3000}`]),
    ),
  },
});
