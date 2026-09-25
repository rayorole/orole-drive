import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, gt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";
import { FamilyAuthError, requireFamily } from "@/lib/auth";
import { EMAIL_DOMAIN_WHITELIST, isVerifiedFamilyUser } from "@/lib/auth-policy";
import { session, user } from "@/lib/auth-schema";
import { getDb } from "@/lib/db";
import type { Database, DriveTransaction } from "@/lib/db";
import { evaluateItemAccess, evaluatePublicItemAccess } from "@/lib/drive-access-policy";
import type { DriveAccessFlags, DriveAccessNode, DriveAccessOptions } from "@/lib/drive-access-policy";
import { DriveError, LockedFolderError, NameConflictError } from "@/lib/drive-errors";
import { driveItems } from "@/lib/drive-schema";
import type { DriveRow } from "@/lib/drive-schema";
import type { ActionResult } from "@/lib/drive-types";

export type { DriveTransaction } from "@/lib/db";
export type { DriveAccessOptions } from "@/lib/drive-access-policy";

export function defaultItemAccess(ctx: DriveContext, parentId: string | null) {
  return { ownerId: ctx.userId, accessMode: parentId ? "inherit" as const : "private" as const, memberRole: "viewer" as const };
}

export interface DriveContext {
  sessionId: string;
  userId: string;
  email: string;
}

export type DriveCapability = "read" | "write" | "share" | "trash";

export interface DriveActor {
  context: DriveContext;
  capabilities: ReadonlySet<DriveCapability>;
}

const driveActors = new AsyncLocalStorage<DriveActor>();

interface SessionValidation {
  userId: string;
  email: string;
  deadline: Promise<number>;
}

// Only withDriveTransaction installs a scope; a pooled connection or action is
// never a cache key. No item ACLs or password grants are retained here.
const transactionSessions = new WeakMap<Database | DriveTransaction, Map<string, SessionValidation>>();

// Only trusted server code may call this after validating OAuth credentials.
// Client headers never select an actor, and absent capabilities never fall back
// to the browser's cookie identity.
export function runWithDriveContext<T>(actor: DriveActor, work: () => Promise<T>): Promise<T> {
  return driveActors.run(actor, work);
}

/** Background system work (search indexing after a response) never runs as the requesting actor. */
export function runAsSystem<T>(work: () => Promise<T>): Promise<T> {
  return driveActors.exit(work);
}

/** For a second capability an action needs only in some cases, e.g. a move that replaces (trashes) an existing item. */
export function assertCapability(capability: DriveCapability): void {
  const actor = driveActors.getStore();
  if (actor && !actor.capabilities.has(capability)) throw new DriveError("This connection does not have permission to perform that operation.");
}

export async function driveAction<T>(
  work: (ctx: DriveContext) => Promise<T>,
  capability: DriveCapability = "write",
): Promise<ActionResult<T>> {
  try {
    const actor = driveActors.getStore();
    if (actor) {
      if (!actor.capabilities.has(capability)) {
        throw new DriveError("This connection does not have permission to perform that operation.");
      }
      await assertSession(getDb(), actor.context);
      return { success: true, data: await work(actor.context) };
    }
    const identity = await requireFamily();
    return {
      success: true,
      data: await work({
        sessionId: identity.session.id,
        userId: identity.user.id,
        email: identity.user.email,
      }),
    };
  } catch (error) {
    if (error instanceof NameConflictError) {
      return { success: false, error: error.message, conflicts: error.conflicts };
    }
    if (error instanceof LockedFolderError) {
      return { success: false, error: error.message, lockedFolder: error.lockedFolder };
    }
    if (error instanceof DriveError || error instanceof FamilyAuthError) {
      return { success: false, error: error.message };
    }
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? "Check the information and try again." };
    }
    return { success: false, error: "The drive could not complete that request. Please try again." };
  }
}

export async function withDriveTransaction<T>(
  mode: "read" | "write",
  work: (tx: DriveTransaction) => Promise<T>,
): Promise<T> {
  return getDb().transaction(async (tx) => {
    // First lock in every transaction. Read committed takes a fresh snapshot after
    // waiting, unlike repeatable read which can retain the pre-lock hierarchy.
    await tx.execute(mode === "read"
      ? sql`select pg_advisory_xact_lock_shared(1329876812, 1146242646)`
      : sql`select pg_advisory_xact_lock(1329876812, 1146242646)`);
    transactionSessions.set(tx, new Map());
    try {
      const actor = driveActors.getStore();
      if (actor) await assertSession(tx, actor.context);
      return await work(tx);
    } finally {
      transactionSessions.delete(tx);
    }
  }, { isolationLevel: "read committed" });
}

async function validateSession(db: Database | DriveTransaction, ctx: DriveContext): Promise<number> {
  const startedAt = performance.now();
  const [active] = await db.select({
    email: user.email,
    emailVerified: user.emailVerified,
    remainingMs: sql<number>`extract(epoch from (${session.expiresAt} - clock_timestamp())) * 1000`.mapWith(Number),
  }).from(session).innerJoin(user, eq(user.id, session.userId)).where(and(
    eq(session.id, ctx.sessionId),
    eq(session.userId, ctx.userId),
    eq(user.email, ctx.email),
    gt(session.expiresAt, sql`clock_timestamp()`),
  )).limit(1).for("share");
  // SHARE also prevents expiry/verification changes, not just deletion, while a
  // transaction reuses this validation. Keep expiry checks live without relying
  // on the application clock matching Postgres (query time is conservative).
  if (!active || !isVerifiedFamilyUser(active)) throw new FamilyAuthError();
  return startedAt + active.remainingMs;
}

async function assertSession(db: Database | DriveTransaction, ctx: DriveContext): Promise<void> {
  const scope = transactionSessions.get(db);
  let validation = scope?.get(ctx.sessionId);
  if (!validation || validation.userId !== ctx.userId || validation.email !== ctx.email) {
    validation = { userId: ctx.userId, email: ctx.email, deadline: validateSession(db, ctx) };
    scope?.set(ctx.sessionId, validation);
  }
  const deadline = await validation.deadline;
  if (performance.now() >= deadline) throw new FamilyAuthError();
}

async function loadAccessNodes(
  tx: DriveTransaction,
  ctx: DriveContext | null,
  ids: string[],
): Promise<Map<string, DriveAccessNode>> {
  if (ctx) await assertSession(tx, ctx);
  if (!ids.length) return new Map();
  const currentGrant = ctx ? sql`exists (
    select 1 from drive_folder_unlocks unlock
    join auth_session active_session on active_session.id = unlock.session_id
    where unlock.session_id = ${ctx.sessionId}
      and active_session.user_id = ${ctx.userId}
      and active_session.expires_at > clock_timestamp()
      and unlock.folder_id = ancestor.id
      and unlock.password_version = ancestor.password_version
      and unlock.expires_at > clock_timestamp()
  )` : sql`false`;
  // UNION (not UNION ALL) bounds corrupt cycles and deduplicates shared ancestry
  // across a bulk selection. Password hashes never leave this server-side query.
  const nodes = await tx.execute<DriveAccessNode & Record<string, unknown>>(sql`
    with recursive ancestors as (
      select item.* from drive_items item
      where item.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      union
      select parent.* from drive_items parent
      join ancestors child on child.parent_id = parent.id
    )
    select ancestor.id, ancestor.name, ancestor.parent_id as "parentId",
      ancestor.kind, ancestor.state,
      ancestor.trashed_at is not null as trashed,
      ancestor.deletion_started_at is not null as deleting,
      ancestor.password_hash is not null as "hasPassword",
      ${currentGrant} as unlocked,
      ancestor.owner_id as "ownerId", ancestor.access_mode as "accessMode", ancestor.member_role as "memberRole",
      (ancestor.public_token is not null and (ancestor.public_expires_at is null or ancestor.public_expires_at > clock_timestamp())) as "hasActivePublicLink",
      exists (select 1 from drive_item_members audience where audience.item_id = ancestor.id and audience.user_id <> ancestor.owner_id) as "hasSharedMembers",
      case when owner.id is null then null else json_build_object('id', owner.id, 'name', owner.name, 'email', owner.email) end as owner,
      (select membership.role from drive_item_members membership
        where membership.item_id = ancestor.id and membership.user_id = ${ctx?.userId ?? null}) as "selectedRole"
    from ancestors ancestor
    left join auth_user owner on owner.id = ancestor.owner_id
  `);
  return new Map(nodes.map((node) => [node.id, node]));
}

export async function assertItemAccess(
  tx: DriveTransaction,
  ctx: DriveContext,
  row: DriveRow,
  options: DriveAccessOptions = {},
): Promise<void> {
  const nodes = await loadAccessNodes(tx, ctx, [row.id]);
  evaluateItemAccess(nodes, row.id, ctx.userId, options);
}

export async function assertItemsAccess(
  tx: DriveTransaction,
  ctx: DriveContext,
  rows: DriveRow[],
  options: DriveAccessOptions = {},
): Promise<void> {
  const nodes = await loadAccessNodes(tx, ctx, rows.map((row) => row.id));
  for (const row of rows) evaluateItemAccess(nodes, row.id, ctx.userId, options);
}

export async function assertItemWriteAccess(tx: DriveTransaction, ctx: DriveContext, row: DriveRow, options: DriveAccessOptions = {}): Promise<void> {
  await assertItemAccess(tx, ctx, row, { ...options, permission: "write" });
}

export async function assertItemsWriteAccess(tx: DriveTransaction, ctx: DriveContext, rows: DriveRow[], options: DriveAccessOptions = {}): Promise<void> {
  await assertItemsAccess(tx, ctx, rows, { ...options, permission: "write" });
}

export async function getItemAccess(
  tx: DriveTransaction,
  ctx: DriveContext,
  row: DriveRow,
): Promise<DriveAccessFlags> {
  const nodes = await loadAccessNodes(tx, ctx, [row.id]);
  return evaluateItemAccess(nodes, row.id, ctx.userId, {
    allowTrashed: row.trashedAt !== null,
    includeSelf: false,
  });
}

export async function getItemsAccess(
  tx: DriveTransaction,
  ctx: DriveContext,
  rows: DriveRow[],
): Promise<Map<string, DriveAccessFlags>> {
  const nodes = await loadAccessNodes(tx, ctx, rows.map((row) => row.id));
  const flags = new Map<string, DriveAccessFlags>();
  for (const row of rows) {
    flags.set(row.id, evaluateItemAccess(nodes, row.id, ctx.userId, {
      allowTrashed: row.trashedAt !== null,
      includeSelf: false,
    }));
  }
  return flags;
}

/** One fresh ACL snapshot for a listing; never retained across another DB call or write. */
export async function getListingAccess(
  tx: DriveTransaction,
  ctx: DriveContext,
  rows: DriveRow[],
  path: DriveRow[],
  trash: boolean,
): Promise<{
  access: Map<string, DriveAccessFlags>;
  breadcrumbs: { id: string; name: string; permission: DriveAccessFlags["permission"] }[];
}> {
  const nodes = await loadAccessNodes(tx, ctx, [...new Set([...rows, ...path].map((row) => row.id))]);
  const current = path.at(-1);
  if (current) {
    evaluateItemAccess(nodes, current.id, ctx.userId, { allowTrashed: trash });
    if (trash && (!current.trashedAt || current.deletionStartedAt)) throw new DriveError("This folder is not in Trash.");
  }
  const breadcrumbs: { id: string; name: string; permission: DriveAccessFlags["permission"] }[] = [];
  for (const row of path) {
    try {
      const { permission } = evaluateItemAccess(nodes, row.id, ctx.userId, { allowTrashed: trash });
      breadcrumbs.push({ id: row.id, name: row.name, permission });
    } catch (error) {
      if (!(error instanceof DriveError)) throw error;
      // A directly shared descendant must not reveal inaccessible ancestors.
      breadcrumbs.length = 0;
    }
  }
  const access = new Map<string, DriveAccessFlags>();
  for (const row of current ? [...rows, current] : rows) {
    access.set(row.id, evaluateItemAccess(nodes, row.id, ctx.userId, {
      allowTrashed: row.trashedAt !== null,
      includeSelf: false,
    }));
  }
  return { access, breadcrumbs };
}

/** Like `assertItemsAccess`, but per id and without throwing: null when the item is missing or out of reach for this session. */
export async function tryItemsAccess(
  tx: DriveTransaction,
  ctx: DriveContext,
  ids: string[],
  options: DriveAccessOptions = {},
): Promise<Map<string, DriveAccessFlags | null>> {
  const nodes = await loadAccessNodes(tx, ctx, ids);
  const flags = new Map<string, DriveAccessFlags | null>();
  for (const id of ids) {
    try {
      flags.set(id, evaluateItemAccess(nodes, id, ctx.userId, options));
    } catch (error) {
      if (!(error instanceof DriveError)) throw error;
      flags.set(id, null);
    }
  }
  return flags;
}

/** A public link needs a complete, active item with no password on it or any ancestor. */
export async function canAccessPublic(tx: DriveTransaction, row: DriveRow): Promise<boolean> {
  if (row.state !== "complete") return false;
  const nodes = await loadAccessNodes(tx, null, [row.id]);
  try {
    // No grants are loaded: any protected ancestor makes public access impossible,
    // even when the requesting browser happens to have an unlocked private session.
    evaluatePublicItemAccess(nodes, row.id);
    return true;
  } catch (error) {
    if (error instanceof DriveError) return false;
    throw error;
  }
}

type VisibleItemsOptions = { trash?: boolean; permission?: DriveAccessOptions["permission"]; includePending?: boolean };

function visibleItemIds(ctx: DriveContext, options: VisibleItemsOptions): SQL {
  const activeRoots = options.trash ? sql`true` : sql`visible_root.trashed_at is null and visible_root.deletion_started_at is null`;
  const activeChildren = options.trash ? sql`true` : sql`visible_child.trashed_at is null and visible_child.deletion_started_at is null`;
  const role = (alias: "visible_root" | "visible_child", inherited: SQL): SQL => {
    const item = sql.identifier(alias);
    return sql`case
      when ${item}.owner_id is null then null
      when ${item}.owner_id = ${ctx.userId} then 'owner'
      when ${item}.access_mode = 'members' then ${item}.member_role
      when ${item}.access_mode = 'selected' then (select membership.role from drive_item_members membership
        where membership.item_id = ${item}.id and membership.user_id = ${ctx.userId})
      when ${item}.access_mode = 'inherit' then ${inherited}
      else null end`;
  };
  const requiredRole = options.permission === "manage" ? sql`permission = 'owner'`
    : options.permission === "write" ? sql`permission in ('owner', 'editor')` : sql`permission is not null`;
  return sql`
    with recursive active_grants as (
      select folder_id, password_version from drive_folder_unlocks
      where session_id = ${ctx.sessionId} and expires_at > clock_timestamp()
    ), visible (id, kind, may_descend, depth, permission) as (
      select visible_root.id, visible_root.kind,
        (visible_root.password_hash is null or exists (
          select 1 from active_grants where folder_id = visible_root.id and password_version = visible_root.password_version
        )), 0, ${role("visible_root", sql`null::text`)}
      from drive_items visible_root
      where visible_root.parent_id is null and ${options.includePending ? sql`true` : sql`visible_root.state = 'complete'`} and ${activeRoots}
      union all
      select visible_child.id, visible_child.kind,
        (visible_child.password_hash is null or exists (
          select 1 from active_grants where folder_id = visible_child.id and password_version = visible_child.password_version
        )), visible.depth + 1, ${role("visible_child", sql`case when visible.permission = 'owner' then 'editor' else visible.permission end`)}
      from drive_items visible_child join visible on visible_child.parent_id = visible.id
      where visible.kind = 'folder' and visible.may_descend
        and visible.depth < 64 and (visible_child.kind = 'file' or visible.depth < 63)
        and ${options.includePending ? sql`true` : sql`visible_child.state = 'complete'`} and ${activeChildren}
    ) select id from visible where ${requiredRole} and exists (
      select 1 from auth_session active_session join auth_user member on member.id = active_session.user_id
      where active_session.id = ${ctx.sessionId} and active_session.user_id = ${ctx.userId}
        and active_session.expires_at > clock_timestamp() and member.email = ${ctx.email}
        and member.email_verified and split_part(lower(trim(member.email)), '@', 2) in (${sql.join(EMAIL_DOMAIN_WHITELIST.map((domain) => sql`${domain}`), sql`, `)})
    )
  `;
}

export function visibleItemsCondition(ctx: DriveContext, options: VisibleItemsOptions = {}): SQL {
  return sql`${driveItems.id} in (${visibleItemIds(ctx, options)})`;
}

/** Directly shared/owned nested items appear at the root when their real parent is inaccessible. */
export function discoverableRootsCondition(ctx: DriveContext, options: VisibleItemsOptions = {}): SQL {
  return sql`(${driveItems.parentId} is null or ${driveItems.parentId} not in (${visibleItemIds(ctx, options)}))`;
}
