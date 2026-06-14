// Bearer token auth middleware. Spec 08.
//
// Applied to all routes in `src/transport/http.ts` when
// `TRANSPORT_MODE=remote`. Not used at all in `local` mode.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Constant-time string comparison to prevent timing attacks. */
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Return a middleware function that verifies `Authorization: Bearer <token>`
 * against `expectedToken`. If missing or incorrect, respond 401 and end.
 *
 * EC-RT-03: 401 returned before reaching `/mcp` routing.
 * Uses constant-time comparison (VULN-06 fix) to mitigate timing attacks.
 */
export function createBearerAuthMiddleware(expectedToken: string) {
  return (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void
  ): void => {
    const auth = req.headers.authorization ?? "";
    const parts = auth.split(" ");
    if (
      parts.length !== 2 ||
      parts[0].toLowerCase() !== "bearer" ||
      !constantTimeCompare(parts[1], expectedToken)
    ) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain");
      res.end("Unauthorized");
      return;
    }
    next();
  };
}
