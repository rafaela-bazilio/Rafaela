// Backend-only migration runner: transaction, advisory lock and immutable checksums.
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL não configurada");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(17431021)");
  await client.query(
    'CREATE TABLE IF NOT EXISTS "_crm_migrations" (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)',
  );
  for (const entry of (
    await readdir("prisma/migrations", { withFileTypes: true })
  )
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = await readFile(
      `prisma/migrations/${entry.name}/migration.sql`,
      "utf8",
    );
    const checksum = createHash("sha256").update(sql).digest("hex");
    const prior = await client.query(
      'SELECT checksum FROM "_crm_migrations" WHERE name=$1',
      [entry.name],
    );
    if (prior.rows.length) {
      if (prior.rows[0].checksum !== checksum)
        throw new Error(`Migration alterada: ${entry.name}`);
      continue;
    }
    await client.query(sql);
    await client.query(
      'INSERT INTO "_crm_migrations" (name,checksum) VALUES ($1,$2)',
      [entry.name, checksum],
    );
    console.log("Migration aplicada:", entry.name);
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
