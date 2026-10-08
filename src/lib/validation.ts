import { z } from "zod";
export const statuses = [
  "NOVO",
  "EM_ATENDIMENTO",
  "QUER_FECHAR",
  "FECHADO",
  "PERDIDO",
] as const;
export const leadInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    phone: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/, "Use telefone E.164, ex.: +5511999999999"),
    email: z.string().email().max(254).optional(),
  })
  .strict();
export const inboundInput = leadInput.extend({
  externalId: z.string().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
  media: z
    .object({
      key: z.object({
        id: z.string().min(1).max(200),
        remoteJid: z.string().regex(/^[1-9]\d{7,14}@s\.whatsapp\.net$/),
        fromMe: z.literal(false),
      }),
      name: z.string().max(120),
      mime: z.string().max(100),
    })
    .optional(),
});
export const manualInput = z
  .object({
    leadId: z.string().min(1),
    body: z.string().trim().min(1).max(8000),
  })
  .strict();
export const patchInput = z.object({ status: z.enum(statuses) }).strict();
export function filters(url: URL) {
  const now = new Date();
  const period = z
    .enum(["week", "month", "custom"])
    .parse(url.searchParams.get("period") ?? "month");
  const parseDate = (v: string | null) =>
    z
      .string()
      .datetime({ offset: true })
      .transform((v) => new Date(v))
      .parse(v);
  let start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  let end = now;
  if (period === "week") {
    start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  }
  if (period === "custom") {
    start = parseDate(url.searchParams.get("start"));
    end = parseDate(url.searchParams.get("end"));
  }
  if (start >= end || end.getTime() - start.getTime() > 366 * 86400000)
    throw new Error("INVALID_PERIOD");
  const status = url.searchParams.get("status");
  return {
    start,
    end,
    status: status ? z.enum(statuses).parse(status) : undefined,
  };
}
export function csv(rows: Array<Array<string>>) {
  return (
    "\uFEFF" +
    rows
      .map((row) =>
        row
          .map((value) => {
            const safe = /^[=+@\-\t\r\n]/.test(value) ? "'" + value : value;
            return '"' + safe.replaceAll('"', '""') + '"';
          })
          .join(","),
      )
      .join("\r\n")
  );
}
