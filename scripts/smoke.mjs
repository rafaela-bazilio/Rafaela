import "dotenv/config";
import assert from "node:assert/strict";
const base = process.env.CRM_BASE_URL ?? "http://127.0.0.1:3000";
if (!process.env.CRM_API_TOKEN)
  throw new Error("CRM_API_TOKEN não configurado");
const landing = await fetch(base, { signal: AbortSignal.timeout(5000) });
assert.equal(landing.status, 200);
assert.match(await landing.text(), /QUEIROZ E ANDRADE ADVOGADOS/);
assert.equal(
  (
    await fetch(new URL("/api/metrics", base), {
      signal: AbortSignal.timeout(5000),
    })
  ).status,
  401,
);
for (const path of [
  "/api/metrics?period=month",
  "/api/export-csv?period=month",
  "/api/export-pdf?period=month",
]) {
  const response = await fetch(new URL(path, base), {
    headers: { Authorization: `Bearer ${process.env.CRM_API_TOKEN}` },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, path);
  if (path.includes("pdf"))
    assert.equal(
      Buffer.from(await response.arrayBuffer())
        .subarray(0, 4)
        .toString(),
      "%PDF",
    );
  else if (path.includes("metrics"))
    assert.equal(typeof (await response.json()).newLeads, "number");
  else assert.match(await response.text(), /Criado UTC/);
}
console.log("Smoke HTTP passou: página, autenticação, métricas, CSV e PDF.");
