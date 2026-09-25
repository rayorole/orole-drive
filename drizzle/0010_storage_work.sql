CREATE TABLE "drive_upload_work" (
  "id" uuid PRIMARY KEY NOT NULL,
  "item_id" uuid NOT NULL,
  "object_key" varchar(128) NOT NULL CONSTRAINT "drive_upload_work_object_key_unique" UNIQUE,
  "publication_key" varchar(128) CONSTRAINT "drive_upload_work_publication_key_unique" UNIQUE,
  "multipart_upload_id" text,
  "multipart" boolean DEFAULT false NOT NULL,
  "size" bigint NOT NULL,
  "mime_type" varchar(127) NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "retain_until" timestamp with time zone NOT NULL,
  CONSTRAINT "drive_upload_work_status_valid" CHECK ("status" in ('pending', 'cancelled', 'published')),
  CONSTRAINT "drive_upload_work_publication_distinct" CHECK ("publication_key" is null or "publication_key" <> "object_key")
);
--> statement-breakpoint
CREATE INDEX "drive_upload_work_status_idx" ON "drive_upload_work" ("status", "retain_until");
--> statement-breakpoint
INSERT INTO "drive_upload_work" ("id", "item_id", "object_key", "multipart_upload_id", "multipart", "size", "mime_type", "created_at", "retain_until")
SELECT "id", coalesce("replaces_id", "id"), "object_key", "multipart_upload_id", "multipart_upload_id" is not null, "size", "mime_type", "created_at", greatest("created_at" + interval '49 hours', now() + interval '25 hours')
FROM "drive_items" WHERE "state" = 'pending' AND "kind" = 'file';
