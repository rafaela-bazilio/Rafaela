import { db } from "./db";
import { inboundInput } from "./validation";
import { needsHuman, reception } from "./ai";
import { getSettings, personalize, approvedReply } from "./settings";
import { normalizeWhatsapp } from "./whatsapp";
import {
  fetchIncomingMedia,
  readMedia,
  removeMedia,
  evolutionEndpoint,
} from "./media";

export async function receive(raw: unknown) {
  const normalized = normalizeWhatsapp(raw);
  if (!normalized) return { ignored: true };
  const input = inboundInput.parse(normalized);
  const settings = await getSettings();
  if (await db.message.findUnique({ where: { externalId: input.externalId } }))
    return { duplicate: true };
  if (
    input.media &&
    (input.media.key.remoteJid !== input.phone.slice(1) + "@s.whatsapp.net" ||
      (process.env.EVOLUTION_INSTANCE &&
        !input.externalId.startsWith(process.env.EVOLUTION_INSTANCE + ":")))
  )
    throw new Error("INVALID_MEDIA");
  const attachment = input.media
    ? await fetchIncomingMedia(
        input.media.key,
        input.media.name,
        input.media.mime,
      )
    : undefined;
  // Serialização por telefone: criação, primeiro contato e deduplicação são atômicos.
  const received = await db
    .$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.phone}))`;
      const duplicate = await tx.message.findUnique({
        where: { externalId: input.externalId },
      });
      if (duplicate) return { duplicate: true, leadId: duplicate.leadId };
      let lead = await tx.lead.findUnique({ where: { phone: input.phone } });
      const firstContact =
        !lead || (await tx.contact.count({ where: { leadId: lead.id } })) === 0;
      if (!lead)
        lead = await tx.lead.create({
          data: { name: input.name, phone: input.phone, email: input.email },
        });
      else if (
        lead.name === "Cliente WhatsApp" &&
        input.name !== "Cliente WhatsApp"
      )
        lead = await tx.lead.update({
          where: { id: lead.id },
          data: { name: input.name },
        });
      const closing = /contrat|fechar/i.test(input.body);
      const human =
        !!attachment ||
        !settings.enabled ||
        closing ||
        needsHuman(input.body) ||
        lead.humanRequired ||
        ["FECHADO", "PERDIDO"].includes(lead.status);
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          humanRequired: human,
          ...(closing && !["FECHADO", "PERDIDO"].includes(lead.status)
            ? { status: "QUER_FECHAR" }
            : {}),
        },
      });
      await tx.contact.create({ data: { leadId: lead.id, firstContact } });
      await tx.message.create({
        data: {
          leadId: lead.id,
          externalId: input.externalId,
          direction: "INBOUND",
          body: input.body,
          ...attachment,
        },
      });
      await tx.auditLog.create({
        data: {
          leadId: lead.id,
          event: human ? "HUMAN_HANDOFF" : "INBOUND_RECEIVED",
        },
      });
      return { duplicate: false, leadId: lead.id, human };
    })
    .catch(async (error) => {
      if (attachment) await removeMedia(attachment.filePath);
      throw error;
    });
  if (received.duplicate) {
    if (attachment) await removeMedia(attachment.filePath);
    return received;
  }
  if (received.human) {
    const reply = await db.$transaction(async (tx) => {
      const reply = await tx.message.create({
        data: {
          leadId: received.leadId,
          body: personalize(settings.handoff, input.name),
          direction: "OUTBOUND",
          delivery: "PENDING",
        },
      });
      await tx.auditLog.create({
        data: { leadId: received.leadId, event: "HUMAN_NOTICE_QUEUED" },
      });
      return reply;
    });
    if (settings.autoSend)
      await dispatch(reply.id).catch(() => {
        console.error("AUTO_DISPATCH_REQUIRES_REVIEW");
      });
    return received;
  }
  const history = await db.message.findMany({
    where: { leadId: received.leadId },
    orderBy: { createdAt: "desc" },
    take: 12,
  });
  const approved = approvedReply(settings.rules, input.body);
  const decision = approved
    ? { reply: approved, handoff: false }
    : await reception(
        history.reverse().map((m) => ({
          role:
            m.direction === "INBOUND"
              ? ("user" as const)
              : ("assistant" as const),
          content: m.body,
        })),
        settings.systemPrompt,
      );
  const reply = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.phone}))`;
    const latest = await tx.lead.findUniqueOrThrow({
      where: { id: received.leadId },
    });
    if (latest.humanRequired) return;
    if (decision.handoff) {
      await tx.lead.update({
        where: { id: latest.id },
        data: { humanRequired: true },
      });
      await tx.auditLog.create({
        data: { leadId: latest.id, event: "AI_HUMAN_HANDOFF" },
      });
    }
    // Outbox persistida: nunca afirmar entrega antes do provedor confirmar.
    const reply = await tx.message.create({
      data: {
        leadId: latest.id,
        body: personalize(
          decision.handoff ? settings.handoff : (approved ?? settings.greeting),
          latest.name,
        ),
        direction: "OUTBOUND",
        delivery: "PENDING",
      },
    });
    await tx.auditLog.create({
      data: { leadId: latest.id, event: "AI_REPLY_QUEUED" },
    });
    return reply;
  });
  if (settings.autoSend && reply)
    await dispatch(reply.id).catch(() => {
      console.error("AUTO_DISPATCH_REQUIRES_REVIEW");
    });
  return received;
}
export async function dispatch(id: string) {
  const base = process.env.EVOLUTION_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;
  if (!base || !key || !instance) throw new Error("PROVIDER_NOT_CONFIGURED");
  const endpoint = evolutionEndpoint(
    `/message/sendText/${encodeURIComponent(instance)}`,
  );
  if (endpoint.protocol !== "https:")
    throw new Error("PROVIDER_REQUIRES_HTTPS");
  const claimed = await db.message.updateMany({
    where: { id, direction: "OUTBOUND", delivery: "PENDING" },
    data: { delivery: "SENDING" },
  });
  if (!claimed.count) throw new Error("MESSAGE_NOT_PENDING");
  const message = await db.message.findUniqueOrThrow({
    where: { id },
    include: { lead: true },
  });
  let state = "UNKNOWN";
  try {
    let target = endpoint;
    let payload: Record<string, unknown> = {
      number: message.lead.phone.slice(1),
      text: message.body,
    };
    if (message.filePath && message.mimeType) {
      const media = (await readMedia(message.filePath)).toString("base64");
      const audio = message.mimeType.startsWith("audio/");
      target = evolutionEndpoint(
        `/message/${audio ? "sendWhatsAppAudio" : "sendMedia"}/${encodeURIComponent(instance)}`,
      );
      payload = audio
        ? { number: message.lead.phone.slice(1), audio: media }
        : {
            number: message.lead.phone.slice(1),
            mediatype: message.mimeType.startsWith("image/")
              ? "image"
              : "document",
            mimetype: message.mimeType,
            caption: message.body,
            fileName: message.fileName,
            media,
          };
    }
    const response = await fetch(target, {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state = response.ok ? "ACCEPTED" : "FAILED";
  } finally {
    await db.$transaction([
      db.message.update({ where: { id }, data: { delivery: state } }),
      db.auditLog.create({
        data: { leadId: message.leadId, event: `PROVIDER_${state}` },
      }),
    ]);
  }
  return { state };
}
