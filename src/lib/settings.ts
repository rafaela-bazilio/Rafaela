import { z } from "zod";
import { db } from "./db";
export const settingsInput = z
  .object({
    enabled: z.boolean(),
    autoSend: z.boolean().default(false),
    rules: z
      .array(
        z
          .object({
            keywords: z.array(z.string().trim().min(2).max(50)).min(1).max(10),
            reply: z.string().trim().min(1).max(1000),
          })
          .strict(),
      )
      .max(30)
      .default([]),
    greeting: z.string().trim().min(1).max(1000),
    handoff: z.string().trim().min(1).max(1000),
    systemPrompt: z.string().trim().min(1).max(2000),
  })
  .strict()
  .superRefine((v, ctx) => {
    // Configuração não deve autorizar promessas de preço ou condições de contrato.
    for (const field of ["greeting", "handoff"] as const) {
      if (
        /R\$|\$\s*\d|\d\s*%|gratuit|garantimos|desconto|custa|preço|pagamento|prazo.*garant/i.test(
          v[field],
        )
      )
        ctx.addIssue({
          code: "custom",
          path: [field],
          message:
            "Mensagem não pode prometer valores ou condições comerciais.",
        });
      if (/\{(?!nome\})[^}]*\}/.test(v[field]))
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "Use somente a variável {nome}.",
        });
    }
    for (const [index, rule] of v.rules.entries()) {
      if (
        /R\$|\$\s*\d|\d\s*%|gratuit|garantimos|desconto|custa|preço|pagamento/i.test(
          rule.reply,
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["rules", index, "reply"],
          message: "Encaminhe condições comerciais para humanos.",
        });
      if (/\{(?!nome\})[^}]*\}/.test(rule.reply))
        ctx.addIssue({
          code: "custom",
          path: ["rules", index, "reply"],
          message: "Use somente {nome}.",
        });
    }
  });
export async function getSettings() {
  return (
    (await db.aiSettings.findUnique({ where: { id: "office" } })) ?? {
      id: "office",
      enabled: true,
      autoSend: false,
      rules: [],
      greeting:
        "Olá, {nome}! Recebemos sua mensagem. Como podemos direcionar seu atendimento?",
      handoff:
        "{nome}, vou encaminhar seu atendimento à equipe humana para orientações autorizadas.",
      systemPrompt:
        process.env.SYSTEM_PROMPT ??
        "Você é a recepção de um escritório de serviços profissionais.",
    }
  );
}
export function personalize(template: string, name: string) {
  return template.replaceAll(
    "{nome}",
    name === "Cliente WhatsApp" ? "Olá" : name,
  );
}

export function approvedReply(rules: unknown, text: string): string | null {
  const parsed = z
    .array(z.object({ keywords: z.array(z.string()), reply: z.string() }))
    .safeParse(rules);
  if (!parsed.success) return null;
  const normalize = (v: string) =>
    v
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  const input = normalize(text);
  return (
    parsed.data.find((rule) =>
      rule.keywords.some((keyword) => input.includes(normalize(keyword))),
    )?.reply ?? null
  );
}
