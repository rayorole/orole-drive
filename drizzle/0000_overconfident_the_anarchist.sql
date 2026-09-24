CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"kind" text NOT NULL,
	"parent_id" uuid,
	"size" bigint DEFAULT 0 NOT NULL,
	"mime_type" varchar(127),
	"object_key" varchar(128),
	"etag" text,
	"state" text NOT NULL,
	"public_token" varchar(43),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_items_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "drive_items_public_token_unique" UNIQUE("public_token"),
	CONSTRAINT "drive_items_name_valid" CHECK (char_length("drive_items"."name") between 1 and 255),
	CONSTRAINT "drive_items_not_own_parent" CHECK ("drive_items"."parent_id" is null or "drive_items"."parent_id" <> "drive_items"."id"),
	CONSTRAINT "drive_items_shape_valid" CHECK ((
        "drive_items"."kind" = 'folder' and "drive_items"."state" = 'complete'
        and "drive_items"."size" = 0 and "drive_items"."mime_type" is null
        and "drive_items"."object_key" is null and "drive_items"."etag" is null
        and "drive_items"."public_token" is null
      ) or (
        "drive_items"."kind" = 'file' and "drive_items"."size" between 0 and 5368709120
        and "drive_items"."mime_type" is not null and "drive_items"."object_key" is not null
        and (
          ("drive_items"."state" = 'pending' and "drive_items"."etag" is null and "drive_items"."public_token" is null)
          or ("drive_items"."state" = 'complete' and "drive_items"."etag" is not null)
        )
      ))
);
--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_parent_id_drive_items_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."drive_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_account_user_idx" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "drive_items_parent_state_idx" ON "drive_items" USING btree ("parent_id","state");--> statement-breakpoint
CREATE INDEX "drive_items_state_updated_idx" ON "drive_items" USING btree ("state","updated_at");