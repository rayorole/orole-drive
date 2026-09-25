CREATE TABLE "drive_file_risks" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"score" real,
	"disguised_probability" real,
	"signals" text[] DEFAULT '{}' NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drive_file_risks" ADD CONSTRAINT "drive_file_risks_item_id_drive_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."drive_items"("id") ON DELETE cascade ON UPDATE no action;