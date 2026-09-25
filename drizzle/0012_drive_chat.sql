CREATE TABLE "drive_chat_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chat_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_chat_messages_role_valid" CHECK ("drive_chat_messages"."role" in ('user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "drive_chats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drive_chat_messages" ADD CONSTRAINT "drive_chat_messages_chat_id_drive_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."drive_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_chats" ADD CONSTRAINT "drive_chats_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_chat_messages_chat_idx" ON "drive_chat_messages" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "drive_chats_user_updated_idx" ON "drive_chats" USING btree ("user_id","updated_at" DESC NULLS LAST);