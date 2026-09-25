CREATE TABLE "drive_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"actor_email" varchar(254) NOT NULL,
	"action" text NOT NULL,
	"item_id" uuid,
	"item_name" varchar(255) NOT NULL,
	"item_kind" text NOT NULL,
	"parent_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"protected" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_file_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"object_key" varchar(128) NOT NULL,
	"size" bigint NOT NULL,
	"mime_type" varchar(127) NOT NULL,
	"etag" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"replaced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_file_versions_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "drive_file_versions_size_valid" CHECK ("drive_file_versions"."size" between 0 and 5368709120)
);
--> statement-breakpoint
ALTER TABLE "drive_items" DROP CONSTRAINT "drive_items_shape_valid";--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "replaces_id" uuid;--> statement-breakpoint
ALTER TABLE "drive_events" ADD CONSTRAINT "drive_events_actor_id_auth_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_file_versions" ADD CONSTRAINT "drive_file_versions_item_id_drive_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."drive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_file_versions" ADD CONSTRAINT "drive_file_versions_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_events_at_idx" ON "drive_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "drive_events_item_idx" ON "drive_events" USING btree ("item_id","at");--> statement-breakpoint
CREATE INDEX "drive_events_parent_idx" ON "drive_events" USING btree ("parent_id","at");--> statement-breakpoint
CREATE INDEX "drive_events_actor_idx" ON "drive_events" USING btree ("actor_id","at");--> statement-breakpoint
CREATE INDEX "drive_file_versions_item_idx" ON "drive_file_versions" USING btree ("item_id","replaced_at");--> statement-breakpoint
CREATE INDEX "drive_file_versions_created_by_idx" ON "drive_file_versions" USING btree ("created_by");--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_replaces_id_drive_items_id_fk" FOREIGN KEY ("replaces_id") REFERENCES "public"."drive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_items_created_by_idx" ON "drive_items" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "drive_items_replaces_idx" ON "drive_items" USING btree ("replaces_id");--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_replaces_pending_file" CHECK ("drive_items"."replaces_id" is null or ("drive_items"."kind" = 'file' and "drive_items"."state" = 'pending' and "drive_items"."replaces_id" <> "drive_items"."id"));--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_shape_valid" CHECK ((
        "drive_items"."kind" = 'folder' and "drive_items"."state" = 'complete'
        and "drive_items"."size" = 0 and "drive_items"."mime_type" is null
        and "drive_items"."object_key" is null and "drive_items"."etag" is null
      ) or (
        "drive_items"."kind" = 'file' and "drive_items"."size" between 0 and 5368709120
        and "drive_items"."mime_type" is not null and "drive_items"."object_key" is not null
        and (
          ("drive_items"."state" = 'pending' and "drive_items"."etag" is null and "drive_items"."public_token" is null)
          or ("drive_items"."state" = 'complete' and "drive_items"."etag" is not null)
        )
      ));