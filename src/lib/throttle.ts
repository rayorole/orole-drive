import "server-only";

import { lt, lte, or, sql } from "drizzle-orm";
import { authThrottle } from "@/lib/auth-schema";
import type { Database, DriveTransaction } from "@/lib/db";

/**
 * Fixed-window counter shared by every server instance. Returns false once `max` uses of `key`
 * happened within `windowSeconds`; the window restarts on the first use after it expires.
 */
export async function consumeThrottle(db: Database | DriveTransaction, key: string, max: number, windowSeconds: number): Promise<boolean> {
  const expired = lte(authThrottle.windowStartedAt, sql`clock_timestamp() - make_interval(secs => ${windowSeconds})`);
  const [claimed] = await db.insert(authThrottle).values({ key, count: 1 })
    .onConflictDoUpdate({
      target: authThrottle.key,
      set: {
        count: sql`case when ${expired} then 1 else ${authThrottle.count} + 1 end`,
        windowStartedAt: sql`case when ${expired} then clock_timestamp() else ${authThrottle.windowStartedAt} end`,
      },
      setWhere: or(expired, lt(authThrottle.count, max)),
    }).returning({ key: authThrottle.key });
  return Boolean(claimed);
}
