import "dotenv/config";
import pg from "pg";
import { spawnSync } from "node:child_process";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL não configurada");
const url = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(url.hostname))
  throw new Error(
    "Teste automático usa somente PostgreSQL local; não alterar bancos remotos",
  );
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
try {
  if (
    !(await client.query("SELECT 1 FROM pg_database WHERE datname='crm_test'"))
      .rowCount
  )
    await client.query("CREATE DATABASE crm_test");
} finally {
  await client.end();
}
url.pathname = "/crm_test";
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  CRM_TEST_DATABASE: "1",
};
for (const [command, args] of [
  ["node", ["scripts/migrate.mjs"]],
  ["node", ["--import", "tsx", "--test", "tests/integration.test.ts"]],
]) {
  const run = spawnSync(command, args, { env, stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
