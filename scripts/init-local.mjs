import { access, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
try {
  await access(".env");
  console.log("Configuração local existente preservada.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const random = () => randomBytes(32).toString("hex"),
    password = random();
  await writeFile(
    ".env",
    `DATABASE_URL=postgresql://crm:${password}@localhost:5432/crm\nPOSTGRES_PASSWORD=${password}\nCRM_API_TOKEN=${random()}\nWEBHOOK_TOKEN=${random()}\nMEDIA_DIR=/workspace/crm-media\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log("Configuração local privada criada; valores não são exibidos.");
}
