CREATE TABLE "drive_item_members" (
	"item_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "drive_item_members_item_id_user_id_pk" PRIMARY KEY("item_id","user_id"),
	CONSTRAINT "drive_item_members_role_valid" CHECK ("drive_item_members"."role" in ('viewer', 'editor'))
);
--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "access_mode" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "member_role" text DEFAULT 'viewer' NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_item_members" ADD CONSTRAINT "drive_item_members_item_id_drive_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."drive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_item_members" ADD CONSTRAINT "drive_item_members_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_item_members_user_idx" ON "drive_item_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_owner_id_auth_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_items_owner_idx" ON "drive_items" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_access_mode_valid" CHECK ("drive_items"."access_mode" in ('private', 'inherit', 'members', 'selected'));--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_member_role_valid" CHECK ("drive_items"."member_role" in ('viewer', 'editor'));
--> statement-breakpoint
-- Keep explicit public links intact. Unknown historical ownership stays unknown.
UPDATE "drive_items"
SET "owner_id" = "created_by",
    "access_mode" = CASE WHEN "parent_id" IS NULL THEN 'private' ELSE 'inherit' END;
--> statement-breakpoint
-- Ownership is not quota attribution and cannot change when file contents are replaced.
-- The sole exception is ON DELETE SET NULL after the owning auth_user has gone.
CREATE FUNCTION drive_items_keep_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
     AND NOT (NEW.owner_id IS NULL AND OLD.owner_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM auth_user WHERE id = OLD.owner_id)) THEN
    RAISE EXCEPTION 'Drive item ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER drive_items_owner_immutable
BEFORE UPDATE OF owner_id ON drive_items
FOR EACH ROW EXECUTE FUNCTION drive_items_keep_owner();