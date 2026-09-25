CREATE TABLE "drive_pinned_folders" (
	"user_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_pinned_folders_user_id_item_id_pk" PRIMARY KEY("user_id","item_id")
);
--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "folder_emoji" varchar(64);--> statement-breakpoint
ALTER TABLE "drive_pinned_folders" ADD CONSTRAINT "drive_pinned_folders_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_pinned_folders" ADD CONSTRAINT "drive_pinned_folders_item_id_drive_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."drive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_folder_emoji_valid" CHECK ("drive_items"."folder_emoji" is null or ("drive_items"."kind" = 'folder' and char_length("drive_items"."folder_emoji") between 1 and 64));