import test from "node:test";
import { Prisma } from "@prisma/client";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GET, POST, PATCH } from "../app/api/[...path]/route";
import { db } from "../src/lib/db";
import { removeMedia } from "../src/lib/media";
if (
  process.env.CRM_TEST_DATABASE !== "1" ||
  new URL(process.env.DATABASE_URL!).pathname !== "/crm_test"
)
  throw new Error("Use npm run test:integration para isolar o banco");
process.env.CRM_API_TOKEN = "test-admin-token-".repeat(3);
process.env.WEBHOOK_TOKEN = "test-webhook-token-".repeat(3);
delete process.env.OPENAI_API_KEY;
delete process.env.LLM_API_KEY;
const req = (
  path: string,
  method = "GET",
  body?: unknown,
  token = process.env.CRM_API_TOKEN,
  cookie?: string,
) =>
  new Request("http://localhost/api/" + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(cookie ? { cookie } : {}),
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
test("fluxo real PostgreSQL: webhook, métricas, exportação, equipe, conflitos e mídia", async () => {
  const suffix = randomUUID(),
    email = `test-${suffix}@example.com`,
    agentEmail = `agent-${suffix}@example.com`,
    phone = "+5511" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
  let leadId = "";
  const mediaPaths: string[] = [];
  const userIds: string[] = [];
  const priorSettings = await db.aiSettings.findUnique({
    where: { id: "office" },
  });
  const originalFetch = globalThis.fetch;
  const originalProvider = {
    url: process.env.EVOLUTION_URL,
    key: process.env.EVOLUTION_API_KEY,
    instance: process.env.EVOLUTION_INSTANCE,
  };
  try {
    assert.equal((await GET(req("metrics", "GET", undefined, ""))).status, 401);
    assert.equal(
      (await POST(req("leads", "POST", { name: "Ana", phone: "invalido" })))
        .status,
      400,
    );
    const config = {
      enabled: true,
      autoSend: false,
      greeting: "Olá, {nome}!",
      handoff: "Vamos chamar a equipe humana.",
      systemPrompt: "Recepção",
      rules: [
        {
          keywords: ["olá"],
          reply: "Olá, {nome}! Nossa equipe recebeu seu contato.",
        },
      ],
    };
    assert.equal((await PATCH(req("settings", "PATCH", config))).status, 200);
    const event = {
      externalId: suffix,
      name: "Ana WhatsApp",
      phone,
      body: "Olá",
    };
    const results = await Promise.all([
      POST(req("webhooks/whatsapp", "POST", event, process.env.WEBHOOK_TOKEN)),
      POST(req("webhooks/whatsapp", "POST", event, process.env.WEBHOOK_TOKEN)),
    ]);
    assert.ok(results.every((r) => r.status === 200));
    const lead = await db.lead.findUniqueOrThrow({ where: { phone } });
    leadId = lead.id;
    assert.equal(await db.contact.count({ where: { leadId } }), 1);
    const firstReply = await db.message.findFirstOrThrow({
      where: { leadId, direction: "OUTBOUND" },
    });
    assert.match(firstReply.body, /Ana WhatsApp/);
    assert.equal(firstReply.delivery, "PENDING");
    await POST(
      req(
        "webhooks/whatsapp",
        "POST",
        { ...event, externalId: suffix + "-2", body: "Quero fechar contrato" },
        process.env.WEBHOOK_TOKEN,
      ),
    );
    assert.equal(await db.lead.count({ where: { phone } }), 1);
    assert.equal(await db.contact.count({ where: { leadId } }), 2);
    assert.equal(
      await db.contact.count({ where: { leadId, firstContact: true } }),
      1,
    );
    const closing = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    assert.equal(closing.status, "QUER_FECHAR");
    assert.equal(closing.humanRequired, true);
    assert.equal(
      (
        await PATCH(
          req("leads/" + leadId, "PATCH", {
            status: "EM_ATENDIMENTO",
            expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
          }),
        )
      ).status,
      409,
    );
    const metrics = await (await GET(req("metrics?period=month"))).json();
    assert.ok(metrics.contacts >= 2);
    assert.ok(metrics.newLeads >= 1);
    assert.ok(metrics.closing >= 1);
    assert.ok(metrics.days.length > 0);
    const csv = await GET(req("export-csv?period=month&status=QUER_FECHAR"));
    assert.equal(csv.status, 200);
    assert.match(await csv.text(), /Ana WhatsApp/);
    const pdf = await GET(req("export-pdf?period=month"));
    assert.equal(pdf.status, 200);
    assert.equal(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 4)
        .toString(),
      "%PDF",
    );
    const bootstrapState = await GET(
      req("auth/bootstrap", "GET", undefined, ""),
    );
    assert.equal(bootstrapState.status, 200);
    assert.equal((await bootstrapState.json()).required, true);
    const create = await POST(
      req(
        "auth/bootstrap",
        "POST",
        {
          name: "Admin teste",
          email,
          password: "senha-forte-test-2026",
        },
        "",
      ),
    );
    assert.equal(create.status, 201);
    const admin = await create.json();
    userIds.push(admin.id);
    assert.equal(
      (
        await POST(
          req(
            "auth/bootstrap",
            "POST",
            {
              name: "Outro administrador",
              email: `other-${suffix}@example.com`,
              password: "outra-senha-forte-2026",
            },
            "",
          ),
        )
      ).status,
      409,
    );
    const cookie = create.headers.get("set-cookie")!.split(";")[0];
    const login = await POST(
      req(
        "auth/login",
        "POST",
        { email, password: "senha-forte-test-2026" },
        "",
      ),
    );
    assert.equal(login.status, 200);
    assert.equal(
      (await GET(req("auth/me", "GET", undefined, "", cookie))).status,
      200,
    );
    const member = await POST(
      req(
        "team",
        "POST",
        {
          name: "Agente teste",
          email: agentEmail,
          password: "senha-forte-test-2026",
          role: "AGENT",
        },
        "",
        cookie,
      ),
    );
    assert.equal(member.status, 201);
    const agent = await member.json();
    userIds.push(agent.id);
    const al = await POST(
      req(
        "auth/login",
        "POST",
        { email: agentEmail, password: "senha-forte-test-2026" },
        "",
      ),
    );
    const ac = al.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await PATCH(
          req(
            "settings",
            "PATCH",
            {
              enabled: true,
              greeting: "Olá {nome}",
              handoff: "Equipe humana.",
              systemPrompt: "Recepção",
            },
            "",
            ac,
          ),
        )
      ).status,
      403,
    );
    const assign = await PATCH(
      req(
        "leads/" + leadId + "/assign",
        "PATCH",
        {
          assignedToId: agent.id,
          expectedUpdatedAt: closing.updatedAt.toISOString(),
        },
        "",
        cookie,
      ),
    );
    assert.equal(assign.status, 200);
    const note = await POST(
      req(
        "notes",
        "POST",
        { leadId, body: "Cliente solicita retorno da equipe." },
        "",
        ac,
      ),
    );
    assert.equal(note.status, 201);
    const notes = await (
      await GET(req("notes?leadId=" + leadId, "GET", undefined, "", cookie))
    ).json();
    assert.equal(notes[0].user.name, "Agente teste");
    const form = new FormData();
    form.append("leadId", leadId);
    form.append(
      "file",
      new File(
        [Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF")],
        "teste.pdf",
        { type: "application/pdf" },
      ),
    );
    const upload = await POST(
      new Request("http://localhost/api/media", {
        method: "POST",
        headers: { cookie },
        body: form,
      }),
    );
    assert.equal(upload.status, 201);
    const message = await upload.json();
    mediaPaths.push(message.filePath);
    assert.equal(
      (await GET(req("media/" + message.id, "GET", undefined, ""))).status,
      401,
    );
    const download = await GET(
      req("media/" + message.id, "GET", undefined, "", cookie),
    );
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("Content-Type"), "application/pdf");
    const bad = new FormData();
    bad.append("leadId", leadId);
    bad.append(
      "file",
      new File(["<script>evil</script>"], "falso.pdf", {
        type: "application/pdf",
      }),
    );
    assert.equal(
      (
        await POST(
          new Request("http://localhost/api/media", {
            method: "POST",
            headers: { cookie },
            body: bad,
          }),
        )
      ).status,
      409,
    );
    process.env.EVOLUTION_URL = "https://provider.test";
    process.env.EVOLUTION_API_KEY = "fake-key-for-mock";
    process.env.EVOLUTION_INSTANCE = "office-test";
    const providerCalls: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = async (target, options) => {
      const url = String(target);
      const payload = JSON.parse(String(options?.body ?? "{}"));
      providerCalls.push({ url, body: payload });
      if (url.includes("getBase64FromMediaMessage"))
        return Response.json({
          base64: Buffer.from(
            "%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF",
          ).toString("base64"),
        });
      return Response.json({ key: { id: "mock-provider-id" } });
    };
    const sent = await POST(
      req(`messages/${message.id}/dispatch`, "POST", {}, "", cookie),
    );
    assert.equal(sent.status, 200);
    assert.equal((await sent.json()).state, "ACCEPTED");
    assert.ok(providerCalls.at(-1)?.url.includes("/message/sendMedia/"));
    assert.equal(providerCalls.at(-1)?.body.mediatype, "document");
    assert.equal(
      (
        await POST(
          req(`messages/${message.id}/dispatch`, "POST", {}, "", cookie),
        )
      ).status,
      409,
    );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHksAAAAASUVORK5CYII=",
      "base64",
    );
    const wav = Buffer.alloc(44);
    wav.write("RIFF");
    wav.writeUInt32LE(36, 4);
    wav.write("WAVE", 8);
    wav.write("fmt ", 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    for (const [bytes, name, mime, endpoint] of [
      [png, "imagem.png", "image/png", "sendMedia"],
      [wav, "voz.wav", "audio/wav", "sendWhatsAppAudio"],
    ] as const) {
      const form = new FormData();
      form.append("leadId", leadId);
      form.append("file", new File([bytes], name, { type: mime }));
      const upload = await POST(
        new Request("http://localhost/api/media", {
          method: "POST",
          headers: { cookie },
          body: form,
        }),
      );
      assert.equal(upload.status, 201);
      const item = await upload.json();
      mediaPaths.push(item.filePath);
      assert.equal(
        (
          await POST(
            req(`messages/${item.id}/dispatch`, "POST", {}, "", cookie),
          )
        ).status,
        200,
      );
      assert.ok(providerCalls.at(-1)?.url.includes(endpoint));
    }
    const incoming = await POST(
      req(
        "webhooks/whatsapp",
        "POST",
        {
          event: "messages.upsert",
          instance: "office-test",
          data: {
            key: {
              id: suffix + "-media",
              remoteJid: phone.slice(1) + "@s.whatsapp.net",
              fromMe: false,
            },
            pushName: "Nome diferente",
            message: {
              documentMessage: {
                mimetype: "application/pdf",
                fileName: "entrada.pdf",
              },
            },
          },
        },
        process.env.WEBHOOK_TOKEN,
      ),
    );
    assert.equal(incoming.status, 200);
    const receivedFile = await db.message.findUniqueOrThrow({
      where: { externalId: "office-test:" + suffix + "-media" },
    });
    assert.equal(receivedFile.mimeType, "application/pdf");
    mediaPaths.push(receivedFile.filePath!);
    assert.equal(
      (await db.lead.findUniqueOrThrow({ where: { id: leadId } })).name,
      "Ana WhatsApp",
    );
    globalThis.fetch = originalFetch;
    const streamAbort = new AbortController();
    const stream = await GET(
      new Request("http://localhost/api/events", {
        headers: { cookie },
        signal: streamAbort.signal,
      }),
    );
    const reader = stream.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /data:.*refresh/);
    await POST(
      req(
        "notes",
        "POST",
        { leadId, body: "Atualização da segunda sessão" },
        "",
        ac,
      ),
    );
    let refreshed = false;
    for (let i = 0; i < 3 && !refreshed; i++) {
      const next = await reader.read();
      refreshed = new TextDecoder().decode(next.value).includes("data:");
    }
    assert.equal(refreshed, true);
    streamAbort.abort();
    await reader.cancel();
    await POST(req("auth/logout", "POST", {}, "", cookie));
    assert.equal(
      (await GET(req("auth/me", "GET", undefined, "", cookie))).status,
      401,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [
      ["EVOLUTION_URL", originalProvider.url],
      ["EVOLUTION_API_KEY", originalProvider.key],
      ["EVOLUTION_INSTANCE", originalProvider.instance],
    ]) {
      if (value) process.env[key!] = value;
      else delete process.env[key!];
    }
    if (priorSettings)
      await db.aiSettings.upsert({
        where: { id: "office" },
        create: {
          ...priorSettings,
          rules:
            priorSettings.rules === null
              ? Prisma.JsonNull
              : (priorSettings.rules as Prisma.InputJsonValue),
        },
        update: {
          ...priorSettings,
          rules:
            priorSettings.rules === null
              ? Prisma.JsonNull
              : (priorSettings.rules as Prisma.InputJsonValue),
        },
      });
    else await db.aiSettings.deleteMany({ where: { id: "office" } });
    if (leadId) {
      await db.note.deleteMany({ where: { leadId } });
      await db.auditLog.deleteMany({ where: { leadId } });
      await db.message.deleteMany({ where: { leadId } });
      await db.contact.deleteMany({ where: { leadId } });
      await db.lead.delete({ where: { id: leadId } });
    }
    await db.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await db.session.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    for (const path of mediaPaths) await removeMedia(path);
    await db.$disconnect();
  }
});
