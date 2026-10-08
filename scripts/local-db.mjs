import "dotenv/config";
import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
if (!process.env.DATABASE_URL) throw new Error("Configure DATABASE_URL");
const url = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(url.hostname))
  throw new Error(
    "Banco externo: use o serviço PostgreSQL configurado; não inicie banco local",
  );
if (!process.env.POSTGRES_PASSWORD)
  throw new Error("Configure POSTGRES_PASSWORD correspondente à DATABASE_URL");
const result = spawnSync(
  "docker",
  ["compose", "--env-file", ".env", "up", "-d", "db"],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
let ready = false;
for (let i = 0; i < 40; i++) {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 1000,
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
    ready = true;
    break;
  } catch {
    await setTimeout(500);
  } finally {
    await client.end().catch(() => {});
  }
}
if (!ready) throw new Error("PostgreSQL não ficou disponível");
console.log("PostgreSQL disponível.");
