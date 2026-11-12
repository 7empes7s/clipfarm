import type { RequestHandler } from "express";

/** Cloudflare Access adds this header (a signed token) to every request it lets through. */
const ACCESS_HEADER = "cf-access-jwt-assertion";

/**
 * Paths that answer without the header: the health check (deploy.sh and clipfarm:check call it on
 * the box) and the files a phone fetches to install the app, which hold nothing private.
 */
function isOpenPath(path: string): boolean {
  return path === "/api/health" || path === "/manifest.webmanifest" || /^\/icons\/[\w-]+\.png$/.test(path);
}

/**
 * clipfarm has no login of its own: on the live box Cloudflare Access is the login. With
 * CLIPFARM_REQUIRE_ACCESS=1 a request that did not come through Access is refused, so a hostname
 * published without its Access application (or a call straight to the port) cannot approve or post.
 */
export function accessGate(): RequestHandler {
  return (req, res, next) => {
    const token = req.headers[ACCESS_HEADER];
    if (isOpenPath(req.path) || (typeof token === "string" && token.trim() !== "")) {
      next();
      return;
    }
    res.status(403).json({ error: "Sign in through Cloudflare Access to use clipfarm." });
  };
}
