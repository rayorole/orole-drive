import "server-only";

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type Database = PostgresJsDatabase;
export type DriveTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Database is not configured. Ask the drive administrator to set DATABASE_URL.");
  }

  const client = postgres(url, {
    max: 5,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 20,
  });
  return drizzle(client);
}

const databaseGlobal = globalThis as typeof globalThis & {
  oroleDatabase?: Database;
};

export function getDb() {
  return databaseGlobal.oroleDatabase ??= createDb();
}
