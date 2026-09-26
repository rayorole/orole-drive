ALTER TABLE "drive_chat_messages" ADD COLUMN "steps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_chat_messages" ADD COLUMN "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_chat_messages" ADD COLUMN "feedback" text;--> statement-breakpoint
ALTER TABLE "drive_chat_messages" ADD CONSTRAINT "drive_chat_messages_feedback_valid" CHECK ("drive_chat_messages"."feedback" is null or "drive_chat_messages"."feedback" in ('up', 'down'));