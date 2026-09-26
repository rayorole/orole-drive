import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import type { DriveContext, DriveTransaction } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";

export type GuardedMutation =
  | { operation: "create_folder"; name: string; parentId: string | null }
  | { operation: "rename_item"; itemId: string; name: string }
  | { operation: "move_items"; itemIds: string[]; parentId: string | null }
  | { operation: "upload"; name: string; parentId: string | null; size: number; mimeType: string; pendingId?: string };

export type MutationOutcome = { itemIds: string[]; names: string[] };
type MutationGuard = {
  id: string;
  before: (tx: DriveTransaction, ctx: DriveContext, mutation: GuardedMutation) => Promise<void>;
  after: (tx: DriveTransaction, ctx: DriveContext, outcome: MutationOutcome) => Promise<void>;
};
const guards = new AsyncLocalStorage<MutationGuard>();

/** Server-only constraints accompany a normal action into its hierarchy-locked write transaction.
 * A preflight outside that transaction would race renames, ACL changes and upload publication. */
export function runWithMutationGuard<T>(guard: MutationGuard, work: () => Promise<T>): Promise<T> {
  return guards.run(guard, work);
}

/** Persist the trusted scope at reservation; browser input never selects a guard. */
export function currentMutationGuardId(): string | null {
  return guards.getStore()?.id ?? null;
}

/** Every finalizer, including already-published fast paths, must carry the originating scope. */
export function assertMutationGuardIdentity(requiredId: string | null): void {
  if (requiredId && guards.getStore()?.id !== requiredId) throw new DriveError("This upload can only be completed by its approved action.");
}

/** Inert for ordinary Drive actions. Runs while the hierarchy write lock is held. */
export async function assertMutationGuard(tx: DriveTransaction, ctx: DriveContext, mutation: GuardedMutation): Promise<void> {
  await guards.getStore()?.before(tx, ctx, mutation);
}

/** A successful mutation and its approval receipt commit or roll back together. */
export async function completeMutationGuard(tx: DriveTransaction, ctx: DriveContext, outcome: MutationOutcome): Promise<void> {
  await guards.getStore()?.after(tx, ctx, outcome);
}
