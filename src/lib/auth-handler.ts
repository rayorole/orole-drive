import "server-only";

import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";

export interface NextJsAuthHandlers {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
  PATCH: (request: Request) => Promise<Response>;
  PUT: (request: Request) => Promise<Response>;
  DELETE: (request: Request) => Promise<Response>;
}

// Shared by every route that must forward raw HTTP requests into auth.handler: the
// /api/auth catch-all, and every /.well-known/* discovery document better-auth expects
// to serve at the bare site root regardless of where the catch-all itself is mounted.
let handlers: NextJsAuthHandlers | undefined;
export function getAuthHandlers(): NextJsAuthHandlers {
  return handlers ??= toNextJsHandler(getAuth());
}
