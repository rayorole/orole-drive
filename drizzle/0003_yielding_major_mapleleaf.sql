CREATE TABLE "drive_activity" (
	"user_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_activity_user_id_item_id_pk" PRIMARY KEY("user_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "drive_favorites" (
	"user_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_favorites_user_id_item_id_pk" PRIMARY KEY("user_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "drive_folder_unlocks" (
	"session_id" text NOT NULL,
	"folder_id" uuid NOT NULL,
	"password_version" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "drive_folder_unlocks_session_id_folder_id_pk" PRIMARY KEY("session_id","folder_id")
);
--> statement-breakpoint
CREATE TABLE "drive_virus_scans" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"status" text NOT NULL,
	"stats_json" text,
	"permalink" text,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"refresh_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "mcp_oauth_access_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_client" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" boolean DEFAULT false NOT NULL,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"client_credentials_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] DEFAULT '{}'::text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text[],
	"response_types" text[],
	"require_pkce" boolean,
	"dpop_bound_access_tokens" boolean DEFAULT false NOT NULL,
	"reference_id" text,
	"metadata" jsonb,
	CONSTRAINT "mcp_oauth_client_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_client_assertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_client_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_refresh_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp with time zone,
	"auth_time" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "mcp_oauth_refresh_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb,
	CONSTRAINT "mcp_oauth_resource_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "description" varchar(2000) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "folder_color" text;--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "public_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "trashed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "trash_root_id" uuid;--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "deletion_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "password_version" uuid;--> statement-breakpoint
ALTER TABLE "drive_activity" ADD CONSTRAINT "drive_activity_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_activity" ADD CONSTRAINT "drive_activity_item_id_drive_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."drive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_favorites" ADD CONSTRAINT "drive_favorites_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_favorites" ADD CONSTRAINT "drive_favorites_item_id_drive_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."drive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_folder_unlocks" ADD CONSTRAINT "drive_folder_unlocks_session_id_auth_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_folder_unlocks" ADD CONSTRAINT "drive_folder_unlocks_folder_id_drive_items_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."drive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_virus_scans" ADD CONSTRAINT "drive_virus_scans_item_id_drive_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."drive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_access_token" ADD CONSTRAINT "mcp_oauth_access_token_client_id_mcp_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_access_token" ADD CONSTRAINT "mcp_oauth_access_token_session_id_auth_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_access_token" ADD CONSTRAINT "mcp_oauth_access_token_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_access_token" ADD CONSTRAINT "mcp_oauth_access_token_refresh_id_mcp_oauth_refresh_token_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "public"."mcp_oauth_refresh_token"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_client" ADD CONSTRAINT "mcp_oauth_client_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_client_resource" ADD CONSTRAINT "mcp_oauth_client_resource_client_id_mcp_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_client_resource" ADD CONSTRAINT "mcp_oauth_client_resource_resource_id_mcp_oauth_resource_identifier_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."mcp_oauth_resource"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_consent" ADD CONSTRAINT "mcp_oauth_consent_client_id_mcp_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_consent" ADD CONSTRAINT "mcp_oauth_consent_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_refresh_token" ADD CONSTRAINT "mcp_oauth_refresh_token_client_id_mcp_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_refresh_token" ADD CONSTRAINT "mcp_oauth_refresh_token_session_id_auth_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_refresh_token" ADD CONSTRAINT "mcp_oauth_refresh_token_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_activity_accessed_at_idx" ON "drive_activity" USING btree ("accessed_at");--> statement-breakpoint
CREATE INDEX "drive_folder_unlocks_expires_idx" ON "drive_folder_unlocks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "drive_virus_scans_sha256_idx" ON "drive_virus_scans" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "mcp_oauth_access_token_client_idx" ON "mcp_oauth_access_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_access_token_session_idx" ON "mcp_oauth_access_token" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_access_token_user_idx" ON "mcp_oauth_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_access_token_auth_code_idx" ON "mcp_oauth_access_token" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_access_token_refresh_idx" ON "mcp_oauth_access_token" USING btree ("refresh_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_client_user_idx" ON "mcp_oauth_client" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_client_resource_pair_idx" ON "mcp_oauth_client_resource" USING btree ("client_id","resource_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_consent_client_idx" ON "mcp_oauth_consent" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_consent_user_idx" ON "mcp_oauth_consent" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_refresh_token_client_idx" ON "mcp_oauth_refresh_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_refresh_token_session_idx" ON "mcp_oauth_refresh_token" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_refresh_token_user_idx" ON "mcp_oauth_refresh_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_refresh_token_auth_code_idx" ON "mcp_oauth_refresh_token" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "drive_items_trashed_at_idx" ON "drive_items" USING btree ("trashed_at");--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_folder_color_valid" CHECK ("drive_items"."folder_color" is null or (
      "drive_items"."kind" = 'folder' and "drive_items"."folder_color" in ('blue', 'green', 'amber', 'red', 'violet', 'gray')
    ));--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_password_folder_only" CHECK ("drive_items"."password_hash" is null or "drive_items"."kind" = 'folder');--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_password_version_pair" CHECK ((
      "drive_items"."password_hash" is null and "drive_items"."password_version" is null
    ) or (
      "drive_items"."password_hash" is not null and length("drive_items"."password_hash") > 0
      and "drive_items"."password_version" is not null
    ));