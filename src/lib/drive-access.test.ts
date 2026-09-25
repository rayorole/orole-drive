import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { listDrive } from "@/app/actions/drive";
import { EMAIL_DOMAIN_WHITELIST, FamilyAuthError } from "./auth-policy";
import { session, user } from "./auth-schema";
import { assertItemAccess, getItemAccess, getListingAccess, runWithDriveContext, withDriveTransaction } from "./drive-access";
import type { DriveContext } from "./drive-access";
import type { Database } from "./db";
import { DriveError, LockedFolderError } from "./drive-errors";
import { driveFolderUnlocks, driveItems } from "./drive-schema";

// This opt-in suite never falls back to the application's DATABASE_URL.
test("transaction-scoped authorization preserves revocation and expiry boundaries", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 2 });
  const db = drizzle(client);
  const databaseGlobal = globalThis as typeof globalThis & { oroleDatabase?: Database };
  const previousDb = databaseGlobal.oroleDatabase;
  databaseGlobal.oroleDatabase = db;
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const email = `${memberId}@${EMAIL_DOMAIN_WHITELIST[0]}`;
  const ctx: DriveContext = { sessionId: randomUUID(), userId: memberId, email };
  const itemIds: string[] = [];
  try {
    await db.insert(user).values([
      { id: ownerId, name: "Authorization owner", email: `${ownerId}@${EMAIL_DOMAIN_WHITELIST[0]}`, emailVerified: true },
      { id: memberId, name: "Authorization member", email, emailVerified: true },
    ]);
    await db.insert(session).values({ id: ctx.sessionId, token: randomUUID(), userId: memberId, expiresAt: new Date(Date.now() + 60_000) });
    const rootId = randomUUID();
    const childId = randomUUID();
    itemIds.push(childId, rootId);
    const [root] = await db.insert(driveItems).values({ id: rootId, name: "Private ancestor", kind: "folder", state: "complete", ownerId, accessMode: "members", memberRole: "editor" }).returning();
    const [child] = await db.insert(driveItems).values({ id: childId, name: "Directly owned folder", parentId: rootId, kind: "folder", state: "complete", ownerId: memberId, accessMode: "private" }).returning();

    await t.test("folder listings accept case-insensitive UUIDs and return canonical breadcrumbs", async () => {
      const result = await runWithDriveContext({ context: ctx, capabilities: new Set(["read"]) },
        () => listDrive({ folderId: childId.toUpperCase(), foldersOnly: true }));
      assert.equal(result.success, true);
      assert.equal(result.data.currentFolder?.id, childId);
      assert.deepEqual(result.data.breadcrumbs.map(({ id }) => id), [rootId, childId]);
    });

    await t.test("ACL edits are visible to later checks in the same write transaction", async () => {
      await withDriveTransaction("write", async (tx) => {
        assert.equal((await getItemAccess(tx, ctx, root)).permission, "editor");
        await tx.update(driveItems).set({ accessMode: "private" }).where(eq(driveItems.id, rootId));
        await assert.rejects(assertItemAccess(tx, ctx, root), DriveError);
        const listing = await getListingAccess(tx, ctx, [], [root, child], false);
        assert.deepEqual(listing.breadcrumbs, [{ id: childId, name: child.name, permission: "owner" }]);
        assert.equal(listing.access.get(childId)?.parentId, null);
        await tx.update(driveItems).set({ accessMode: "members" }).where(eq(driveItems.id, rootId));
      });
    });

    await t.test("revoking a password grant closes descendants without hiding the locked folder", async () => {
      const version = randomUUID();
      await withDriveTransaction("write", async (tx) => {
        await tx.update(driveItems).set({ passwordHash: "test-password-hash", passwordVersion: version }).where(eq(driveItems.id, rootId));
        await tx.insert(driveFolderUnlocks).values({ sessionId: ctx.sessionId, folderId: rootId, passwordVersion: version, expiresAt: new Date(Date.now() + 60_000) });
        await assertItemAccess(tx, ctx, child);
        await tx.delete(driveFolderUnlocks).where(eq(driveFolderUnlocks.sessionId, ctx.sessionId));
        const listing = await getListingAccess(tx, ctx, [root], [], false);
        assert.equal(listing.access.get(rootId)?.isLocked, true);
        await assert.rejects(getListingAccess(tx, ctx, [], [root, child], false), LockedFolderError);
        await tx.update(driveItems).set({ passwordHash: null, passwordVersion: null }).where(eq(driveItems.id, rootId));
      });
    });

    await t.test("verification revocation cannot overtake an in-flight authorized transaction", async () => {
      await withDriveTransaction("read", async (tx) => {
        await assertItemAccess(tx, ctx, root);
        await assert.rejects(db.transaction(async (revoking) => {
          await revoking.execute(sql`set local lock_timeout = '50ms'`);
          await revoking.update(user).set({ emailVerified: false }).where(eq(user.id, memberId));
        }), (error: unknown) => error instanceof Error && (error.cause as { code?: string } | undefined)?.code === "55P03");
      });
    });

    await t.test("session expiry still takes effect inside an already validated transaction", async () => {
      await db.update(session).set({ expiresAt: sql`clock_timestamp() + interval '1 second'` }).where(eq(session.id, ctx.sessionId));
      await withDriveTransaction("read", async (tx) => {
        await assertItemAccess(tx, ctx, root);
        await tx.execute(sql`select pg_sleep(greatest(0, extract(epoch from (expires_at - clock_timestamp()))) + 0.02)
          from auth_session where id = ${ctx.sessionId}`);
        await assert.rejects(assertItemAccess(tx, ctx, root), FamilyAuthError);
      });
      await db.update(session).set({ expiresAt: new Date(Date.now() + 60_000) }).where(eq(session.id, ctx.sessionId));
    });

    await t.test("verification changes and session revocation are observed by the next transaction", async () => {
      await withDriveTransaction("read", (tx) => assertItemAccess(tx, ctx, root));
      await db.update(user).set({ emailVerified: false }).where(eq(user.id, memberId));
      await assert.rejects(withDriveTransaction("read", (tx) => assertItemAccess(tx, ctx, root)), FamilyAuthError);
      await db.update(user).set({ emailVerified: true }).where(eq(user.id, memberId));
      await withDriveTransaction("read", (tx) => assertItemAccess(tx, ctx, root));
      await db.delete(session).where(eq(session.id, ctx.sessionId));
      await assert.rejects(withDriveTransaction("read", (tx) => assertItemAccess(tx, ctx, root)), FamilyAuthError);
    });
  } finally {
    databaseGlobal.oroleDatabase = previousDb;
    try {
      for (const id of itemIds) await db.delete(driveItems).where(eq(driveItems.id, id));
      await db.delete(user).where(eq(user.id, memberId));
      await db.delete(user).where(eq(user.id, ownerId));
    } finally {
      await client.end();
    }
  }
});
