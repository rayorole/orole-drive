"use server";

import { approveChatActionInput, executeChatApproval } from "@/lib/chat-mutations";
import { driveAction } from "@/lib/drive-access";
import type { ActionResult, DriveChatApproval } from "@/lib/drive-types";

/** Only a persisted assistant proposal may be approved; browser-supplied mutations are rejected. */
export async function approveChatAction(input: {
  messageId: string;
  stepId: string;
  decision: "approve" | "cancel";
  attachmentData?: string;
}): Promise<ActionResult<DriveChatApproval>> {
  return driveAction((ctx) => executeChatApproval(ctx, approveChatActionInput.parse(input)));
}
