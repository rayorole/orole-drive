import "server-only";

import postgres from "postgres";
import { DriveError } from "@/lib/drive-errors";

// A separate, bounded pool: workers must never exhaust the hierarchy pool while
// holding object claims and waiting to revalidate. Transaction-scoped claims are
// released on disconnect/crash, unlike expiring leases whose stale worker could
// still overwrite or delete an object that another worker has published.
const globalStorage = globalThis as typeof globalThis & { oroleStorageClaims?: postgres.Sql };
function claims() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new DriveError("Database is not configured.");
  return globalStorage.oroleStorageClaims ??= postgres(url, { max: 3, prepare: false, connect_timeout: 10, idle_timeout: 20 });
}

/** Only this object's work is serialized; never acquire this claim inside a hierarchy transaction. */
export async function withStorageObjectLock<T>(objectKey: string, work: (confirmClaim: () => Promise<void>) => Promise<T>): Promise<T> {
  let result!: T;
  await claims().begin(async (sql) => {
    const [claim] = await sql<{ acquired: boolean }[]>`select pg_try_advisory_xact_lock(hashtextextended(${objectKey}, 817293)) as acquired`;
    if (!claim.acquired) throw new DriveError("This file is being processed. Please try again shortly.");
    const confirmClaim = async () => { await sql`select 1`; };
    result = await work(confirmClaim);
  });
  return result;
}
