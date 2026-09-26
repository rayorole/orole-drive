import type { DriveChatStep } from "@/lib/drive-types";

/** Every stored rich result participates in the same source revocation checks as citations. */
export function chatStepItemIds(step: DriveChatStep): string[] {
  return [...new Set([
    ...(step.itemId ? [step.itemId] : []),
    ...(step.sourceItemIds ?? []),
    ...(step.tree?.nodes.map((node) => node.id) ?? []),
    ...(step.asset ? [step.asset.itemId] : []),
    ...(step.approval?.snapshots.map((snapshot) => snapshot.itemId) ?? []),
    ...(step.approval?.sourceItemIds ?? []),
    ...(step.approval?.result?.itemIds ?? []),
  ])];
}
