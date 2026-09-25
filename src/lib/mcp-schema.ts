import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { session, user } from "@/lib/auth-schema";

// Table shapes mirror the field declarations the installed @better-auth/mcp@1.7.6
// (built on @better-auth/oauth-provider@1.7.6) plugin requires, inspected directly
// from node_modules/@better-auth/oauth-provider/dist/oauth-1Ud-hvZY.d.mts. Every
// better-auth model also carries an implicit "id" primary key, matching the
// convention already used by auth-schema.ts. Column names stay snake_case per
// this codebase's existing style; the drizzle export keys (camelCase) are what
// better-auth's field names must match for the drizzle adapter's model mapping.

export const oauthClient = pgTable("mcp_oauth_client", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret"),
  clientDiscoveryId: text("client_discovery_id"),
  disabled: boolean("disabled").notNull().default(false),
  skipConsent: boolean("skip_consent"),
  enableEndSession: boolean("enable_end_session"),
  subjectType: text("subject_type"),
  scopes: text("scopes").array(),
  clientCredentialsScopes: text("client_credentials_scopes").array().notNull().default(sql`'{}'::text[]`),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  name: text("name"),
  uri: text("uri"),
  icon: text("icon"),
  contacts: text("contacts").array(),
  tos: text("tos"),
  policy: text("policy"),
  softwareId: text("software_id"),
  softwareVersion: text("software_version"),
  softwareStatement: text("software_statement"),
  redirectUris: text("redirect_uris").array().notNull().default(sql`'{}'::text[]`),
  postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
  backchannelLogoutUri: text("backchannel_logout_uri"),
  backchannelLogoutSessionRequired: boolean("backchannel_logout_session_required"),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
  applicationType: text("application_type"),
  jwks: text("jwks"),
  jwksUri: text("jwks_uri"),
  grantTypes: text("grant_types").array(),
  responseTypes: text("response_types").array(),
  requirePKCE: boolean("require_pkce"),
  dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").notNull().default(false),
  referenceId: text("reference_id"),
  metadata: jsonb("metadata"),
}, (table) => [
  index("mcp_oauth_client_user_idx").on(table.userId),
]);

export const oauthRefreshToken = pgTable("mcp_oauth_refresh_token", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  clientId: text("client_id").notNull().references(() => oauthClient.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  authorizationCodeId: text("authorization_code_id"),
  resources: text("resources").array(),
  requestedUserInfoClaims: text("requested_user_info_claims").array(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revoked: timestamp("revoked", { withTimezone: true }),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  rotationReplayResponse: text("rotation_replay_response"),
  rotationReplayExpiresAt: timestamp("rotation_replay_expires_at", { withTimezone: true }),
  authTime: timestamp("auth_time", { withTimezone: true }),
  confirmation: jsonb("confirmation"),
  scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
}, (table) => [
  index("mcp_oauth_refresh_token_client_idx").on(table.clientId),
  index("mcp_oauth_refresh_token_session_idx").on(table.sessionId),
  index("mcp_oauth_refresh_token_user_idx").on(table.userId),
  index("mcp_oauth_refresh_token_auth_code_idx").on(table.authorizationCodeId),
]);

export const oauthAccessToken = pgTable("mcp_oauth_access_token", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  clientId: text("client_id").notNull().references(() => oauthClient.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  authorizationCodeId: text("authorization_code_id"),
  resources: text("resources").array(),
  requestedUserInfoClaims: text("requested_user_info_claims").array(),
  refreshId: text("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revoked: timestamp("revoked", { withTimezone: true }),
  confirmation: jsonb("confirmation"),
  scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
}, (table) => [
  index("mcp_oauth_access_token_client_idx").on(table.clientId),
  index("mcp_oauth_access_token_session_idx").on(table.sessionId),
  index("mcp_oauth_access_token_user_idx").on(table.userId),
  index("mcp_oauth_access_token_auth_code_idx").on(table.authorizationCodeId),
  index("mcp_oauth_access_token_refresh_idx").on(table.refreshId),
]);

export const oauthConsent = pgTable("mcp_oauth_consent", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().references(() => oauthClient.clientId, { onDelete: "cascade" }),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  resources: text("resources").array(),
  requestedUserInfoClaims: text("requested_user_info_claims").array(),
  scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("mcp_oauth_consent_client_idx").on(table.clientId),
  index("mcp_oauth_consent_user_idx").on(table.userId),
]);

export const oauthResource = pgTable("mcp_oauth_resource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes").array(),
  customClaims: jsonb("custom_claims"),
  dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required").notNull().default(false),
  disabled: boolean("disabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  policyVersion: integer("policy_version").notNull().default(1),
  metadata: jsonb("metadata"),
});

// Join table linking a client to a protected resource it may request. Only load-bearing
// when `enforcePerClientResources: true`; kept here so the plugin never hits a missing
// model if it links resources during registration regardless of that flag.
export const oauthClientResource = pgTable("mcp_oauth_client_resource", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().references(() => oauthClient.clientId, { onDelete: "cascade" }),
  resourceId: text("resource_id").notNull().references(() => oauthResource.identifier, { onDelete: "cascade" }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("mcp_oauth_client_resource_pair_idx").on(table.clientId, table.resourceId),
]);

// One-time-use record for private_key_jwt client assertion jti values; the id is a
// digest of the per-client assertion identifier so a replay collides on the primary
// key. Never referenced by application code, only relied on by the plugin itself.
export const oauthClientAssertion = pgTable("mcp_oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  alg: text("alg"),
  crv: text("crv"),
});
