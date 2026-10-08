import { writeFile } from "node:fs/promises";
const base = process.env.CRM_BASE_URL ?? "http://127.0.0.1:3000";
const token = process.env.CRM_API_TOKEN;
if (!token) throw new Error("Configure CRM_API_TOKEN no ambiente");
const url = new URL("/api/export-csv", base);
url.search = process.argv[2] ?? "period=month";
if (
  url.protocol !== "https:" &&
  !["localhost", "127.0.0.1"].includes(url.hostname)
)
  throw new Error("Exija HTTPS fora do ambiente local");
const response = await fetch(url, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(30000),
});
if (!response.ok) throw new Error(`Exportação falhou: HTTP ${response.status}`);
await writeFile(
  process.argv[3] ?? "leads.csv",
  new Uint8Array(await response.arrayBuffer()),
  { mode: 0o600 },
);
console.log("CSV exportado.");
