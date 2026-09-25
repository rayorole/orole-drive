CREATE TABLE "drive_search_chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"location" text,
	"text" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
	CONSTRAINT "drive_search_chunks_item_ordinal" UNIQUE("item_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "drive_search_docs" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"content_hash" text,
	"status" text NOT NULL,
	"skip_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"indexed_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	CONSTRAINT "drive_search_docs_status_valid" CHECK ("drive_search_docs"."status" in ('queued', 'indexing', 'indexed', 'skipped', 'failed')),
	CONSTRAINT "drive_search_docs_skip_reason_valid" CHECK ("drive_search_docs"."skip_reason" is null or "drive_search_docs"."skip_reason" in ('too_large', 'unsupported', 'excluded', 'protected', 'empty', 'trashed'))
);
--> statement-breakpoint
CREATE TABLE "drive_search_orphans" (
	"vector_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "search_excluded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_search_chunks" ADD CONSTRAINT "drive_search_chunks_item_id_drive_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."drive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_search_docs" ADD CONSTRAINT "drive_search_docs_item_id_drive_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."drive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_search_chunks_tsv_idx" ON "drive_search_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "drive_search_docs_status_idx" ON "drive_search_docs" USING btree ("status","queued_at");--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_search_excluded_folder_only" CHECK ("drive_items"."search_excluded" = false or "drive_items"."kind" = 'folder');