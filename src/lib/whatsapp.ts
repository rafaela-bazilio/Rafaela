import { z } from "zod";
const media = z.object({
  mimetype: z.string(),
  fileName: z.string().optional(),
  caption: z.string().optional(),
});
const native = z.object({
  event: z.literal("messages.upsert"),
  instance: z.string().min(1).max(100),
  data: z.object({
    key: z.object({
      id: z.string().min(1),
      remoteJid: z.string(),
      fromMe: z.boolean(),
    }),
    pushName: z.string().trim().max(120).optional(),
    message: z.object({
      conversation: z.string().optional(),
      extendedTextMessage: z.object({ text: z.string() }).optional(),
      audioMessage: media.optional(),
      imageMessage: media.optional(),
      documentMessage: media.optional(),
    }),
  }),
});
export function normalizeWhatsapp(raw: unknown): unknown | null {
  if (typeof raw !== "object" || raw === null || !("event" in raw)) return raw;
  const event = native.parse(raw),
    d = event.data;
  if (d.key.fromMe || !d.key.remoteJid.endsWith("@s.whatsapp.net")) return null;
  const attachment =
    d.message.audioMessage ??
    d.message.imageMessage ??
    d.message.documentMessage;
  const body =
    d.message.conversation ??
    d.message.extendedTextMessage?.text ??
    attachment?.caption ??
    (attachment ? "[Arquivo recebido]" : undefined);
  if (!body) return null;
  return {
    externalId: `${event.instance}:${d.key.id}`,
    name: d.pushName || "Cliente WhatsApp",
    phone: `+${d.key.remoteJid.split("@")[0]}`,
    body,
    ...(attachment
      ? {
          media: {
            key: d.key,
            name: attachment.fileName ?? "arquivo",
            mime: attachment.mimetype,
          },
        }
      : {}),
  };
}
