import "server-only";

import type { CitedItem } from "@/lib/chat";
import { chatStepItemIds } from "@/lib/chat-step-references";
import type { DriveChatStep } from "@/lib/drive-types";
import { toDriveItem } from "@/lib/storage";

/** Stored rich output is a snapshot, never a permission grant or a reusable signed URL. */
export function hydrateChatStep(step: DriveChatStep, readable: Map<string, CitedItem>): DriveChatStep {
  const item = step.itemId ? readable.get(step.itemId) : undefined;
  const targetUnavailable = Boolean(step.itemId && !item);
  const sourcesUnavailable = (step.sourceItemIds ?? []).some((id) => !readable.has(id));
  const available = (id: string) => {
    const row = readable.get(id);
    return row ? { ...toDriveItem(row), ...row.flags } : null;
  };
  const tree = targetUnavailable ? undefined : step.tree && {
    ...step.tree,
    nodes: step.tree.nodes.flatMap((node) => {
      const current = available(node.id);
      return current ? [{ ...node, name: current.name, kind: current.kind, size: current.size, parentId: current.parentId, item: current }] : [];
    }),
  };
  const assetItem = step.asset ? available(step.asset.itemId) : null;
  const boundApproval = step.approval && (step.approval.request.operation !== "create_file" || step.approval.sourceItemIds !== undefined);
  return {
    ...step,
    ...(targetUnavailable ? { label: "Unavailable item", summary: undefined, error: undefined } : {}),
    diff: targetUnavailable || sourcesUnavailable ? undefined : step.diff,
    table: targetUnavailable || sourcesUnavailable ? undefined : step.table,
    tree,
    asset: step.asset ? assetItem ? { ...step.asset, alt: assetItem.name, item: assetItem } : { itemId: step.asset.itemId, alt: "Image no longer available", item: null } : undefined,
    approval: boundApproval && chatStepItemIds(step).every((id) => readable.has(id)) ? step.approval : undefined,
  };
}
