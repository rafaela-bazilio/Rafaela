import { z } from "zod";
import {
  currentUser,
  login,
  cookie,
  sessionToken,
  digest,
  userInput,
  hashPassword,
  bootstrapAdmin,
} from "../../../src/lib/auth";
import { eventStream } from "../../../src/lib/events";
import {
  saveMedia,
  readMedia,
  removeMedia,
  MAX_MEDIA_BYTES,
} from "../../../src/lib/media";
import { timingSafeEqual } from "node:crypto";
import PDFDocument from "pdfkit";
import { ZodError } from "zod";
import { db } from "../../../src/lib/db";
import {
  csv,
  leadInput,
  manualInput,
  patchInput,
  statuses,
} from "../../../src/lib/validation";
import { report, exportRows } from "../../../src/lib/reports";
import { getSettings, settingsInput } from "../../../src/lib/settings";
import { receive, dispatch } from "../../../src/lib/service";
export const runtime = "nodejs";
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
function authorized(req: Request, webhook: boolean) {
  const token = process.env[webhook ? "WEBHOOK_TOKEN" : "CRM_API_TOKEN"];
  const actual =
    req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return (
    !!token &&
    token.length >= 32 &&
    Buffer.byteLength(token) === Buffer.byteLength(actual) &&
    timingSafeEqual(Buffer.from(token), Buffer.from(actual))
  );
}
async function handler(req: Request) {
  const url = new URL(req.url),
    path = url.pathname.slice(5);
  try {
    if (
      req.method !== "GET" &&
      req.headers.get("origin") &&
      req.headers.get("origin") !== url.origin
    )
      return json({ error: "Origem inválida" }, 403);
    if (req.method === "POST" && path === "auth/login") {
      const result = await login(await req.json());
      return Response.json(result.user, {
        headers: {
          "Set-Cookie": cookie(result.token, 8 * 3600),
          "Cache-Control": "no-store",
        },
      });
    }
    if (req.method === "GET" && path === "auth/bootstrap")
      return json({ required: (await db.user.count()) === 0 });
    if (req.method === "GET" && path === "health") {
      await db.$queryRaw`SELECT 1`;
      return json({ status: "ok" });
    }
    if (req.method === "POST" && path === "auth/bootstrap") {
      const result = await bootstrapAdmin(await req.json());
      return Response.json(result.user, {
        status: 201,
        headers: {
          "Set-Cookie": cookie(result.token, 8 * 3600),
          "Cache-Control": "no-store",
        },
      });
    }
    const user = path === "webhooks/whatsapp" ? null : await currentUser(req);
    if (
      path === "webhooks/whatsapp"
        ? !authorized(req, true)
        : !user && !authorized(req, false)
    )
      return json({ error: "Não autorizado" }, 401);
    const admin = user?.role === "ADMIN" || (!user && authorized(req, false));
    if (req.method === "GET" && path === "auth/me")
      return json(
        user
          ? { id: user.id, name: user.name, role: user.role }
          : { name: "Configuração interna", role: "ADMIN" },
      );
    if (req.method === "POST" && path === "auth/logout") {
      const token = sessionToken(req);
      if (token) await db.session.deleteMany({ where: { id: digest(token) } });
      return Response.json(
        { ok: true },
        { headers: { "Set-Cookie": cookie("", 0) } },
      );
    }
    if (req.method === "GET" && path === "events")
      return eventStream(req.signal, user?.id, sessionToken(req));
    if (req.method === "GET" && path === "team")
      return json(
        await db.user.findMany({
          where: { active: true },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            lastSeenAt: true,
          },
          orderBy: { name: "asc" },
        }),
      );
    if (req.method === "POST" && path === "team") {
      if (!admin)
        return json(
          { error: "Somente administradores podem criar usuários" },
          403,
        );
      const input = userInput.parse(await req.json());
      const member = await db.$transaction(async (tx) => {
        const member = await tx.user.create({
          data: {
            name: input.name,
            email: input.email,
            role: input.role,
            passwordHash: hashPassword(input.password),
          },
          select: { id: true, name: true, email: true, role: true },
        });
        await tx.auditLog.create({
          data: { userId: user?.id, event: "USER_CREATED" },
        });
        return member;
      });
      return json(member, 201);
    }
    if (req.method === "GET" && path === "notes")
      return json(
        await db.note.findMany({
          where: { leadId: url.searchParams.get("leadId") ?? "" },
          include: { user: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
      );
    if (req.method === "POST" && path === "notes") {
      if (!user)
        return json(
          { error: "Entre com usuário individual para colaborar" },
          403,
        );
      const input = manualInput.parse(await req.json());
      return json(
        await db.$transaction(async (tx) => {
          const note = await tx.note.create({
            data: { ...input, userId: user.id },
          });
          await tx.auditLog.create({
            data: {
              leadId: input.leadId,
              userId: user.id,
              event: "NOTE_ADDED",
            },
          });
          return note;
        }),
        201,
      );
    }
    if (req.method === "PATCH" && /^leads\/[^/]+\/assign$/.test(path)) {
      const input = z
        .object({
          assignedToId: z.string().nullable(),
          expectedUpdatedAt: z.string().datetime(),
        })
        .strict()
        .parse(await req.json());
      if (
        input.assignedToId &&
        !(await db.user.findFirst({
          where: { id: input.assignedToId, active: true },
        }))
      )
        return json({ error: "Responsável inválido" }, 400);
      return json(
        await db.$transaction(async (tx) => {
          const changed = await tx.lead.updateMany({
            where: {
              id: path.split("/")[1],
              updatedAt: new Date(input.expectedUpdatedAt),
            },
            data: { assignedToId: input.assignedToId },
          });
          if (!changed.count) throw new Error("EDIT_CONFLICT");
          const lead = await tx.lead.findUniqueOrThrow({
            where: { id: path.split("/")[1] },
            include: {
              assignedTo: { select: { id: true, name: true } },
              _count: { select: { contacts: true, messages: true } },
            },
          });
          await tx.auditLog.create({
            data: { leadId: lead.id, userId: user?.id, event: "LEAD_ASSIGNED" },
          });
          return lead;
        }),
      );
    }

    if (req.method === "POST" && path === "webhooks/whatsapp")
      return json(await receive(await req.json()));
    if (req.method === "POST" && path === "media") {
      if (Number(req.headers.get("content-length")) > MAX_MEDIA_BYTES + 65536)
        return json({ error: "Arquivo muito grande" }, 413);
      const reader = req.body?.getReader();
      if (!reader) return json({ error: "Arquivo ausente" }, 400);
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_MEDIA_BYTES + 65536) {
            await reader.cancel();
            return json({ error: "Arquivo muito grande" }, 413);
          }
          parts.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const form = await new Request(req.url, {
        method: "POST",
        headers: { "Content-Type": req.headers.get("content-type") ?? "" },
        body: new Uint8Array(Buffer.concat(parts)),
      }).formData();
      const file = form.get("file"),
        leadId = form.get("leadId");
      if (!(file instanceof File) || typeof leadId !== "string")
        return json({ error: "Arquivo ou lead inválido" }, 400);
      const input = manualInput.parse({
        leadId,
        body: form.get("body") || "[Arquivo enviado]",
      });
      const attachment = await saveMedia(
        new Uint8Array(await file.arrayBuffer()),
        file.name,
        file.type,
      );
      try {
        return json(
          await db.$transaction(async (tx) => {
            await tx.lead.update({
              where: { id: input.leadId },
              data: { humanRequired: true },
            });
            const message = await tx.message.create({
              data: {
                ...input,
                ...attachment,
                direction: "OUTBOUND",
                delivery: "PENDING",
              },
            });
            await tx.auditLog.create({
              data: {
                userId: user?.id,
                leadId: input.leadId,
                event: "MEDIA_QUEUED",
              },
            });
            return message;
          }),
          201,
        );
      } catch (error) {
        await removeMedia(attachment.filePath);
        throw error;
      }
    }
    if (req.method === "GET" && /^media\/[^/]+$/.test(path)) {
      const message = await db.message.findUniqueOrThrow({
        where: { id: path.split("/")[1] },
      });
      if (!message.filePath) return json({ error: "Sem arquivo" }, 404);
      const data = await readMedia(message.filePath);
      return new Response(new Uint8Array(data), {
        headers: {
          "Content-Type": message.mimeType ?? "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(message.fileName ?? "arquivo")}`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'",
        },
      });
    }
    if (req.method === "GET" && path === "settings")
      return json(await getSettings());
    if (req.method === "PATCH" && path === "settings") {
      if (!admin)
        return json(
          { error: "Somente administradores podem alterar a IA" },
          403,
        );
      const input = settingsInput.parse(await req.json());
      if (
        input.autoSend &&
        (!process.env.EVOLUTION_URL ||
          !process.env.EVOLUTION_API_KEY ||
          !process.env.EVOLUTION_INSTANCE)
      )
        throw new Error("PROVIDER_NOT_CONFIGURED");
      return json(
        await db.$transaction(async (tx) => {
          const settings = await tx.aiSettings.upsert({
            where: { id: "office" },
            create: { id: "office", ...input },
            update: input,
          });
          await tx.auditLog.create({
            data: { userId: user?.id, event: "AI_SETTINGS_UPDATED" },
          });
          return settings;
        }),
      );
    }
    if (req.method === "GET" && path === "metrics")
      return json(await report(url));
    if (req.method === "GET" && path === "leads") {
      const status = url.searchParams.get("status");
      if (status && !statuses.includes(status as (typeof statuses)[number]))
        return json({ error: "Status inválido" }, 400);
      return json(
        await db.lead.findMany({
          where: {
            ...(status ? { status: status as (typeof statuses)[number] } : {}),
            ...(url.searchParams.get("q")
              ? {
                  name: {
                    contains: url.searchParams.get("q")!,
                    mode: "insensitive" as const,
                  },
                }
              : {}),
          },
          include: {
            assignedTo: { select: { id: true, name: true } },
            _count: { select: { contacts: true, messages: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
      );
    }
    if (req.method === "POST" && path === "leads") {
      const input = leadInput.parse(await req.json());
      return json(
        await db.$transaction(async (tx) => {
          const lead = await tx.lead.create({ data: input });
          await tx.auditLog.create({
            data: { userId: user?.id, leadId: lead.id, event: "LEAD_CREATED" },
          });
          return lead;
        }),
        201,
      );
    }
    if (req.method === "PATCH" && path.startsWith("leads/")) {
      const input = patchInput
        .extend({ expectedUpdatedAt: z.string().datetime() })
        .parse(await req.json());
      return json(
        await db.$transaction(async (tx) => {
          const changed = await tx.lead.updateMany({
            where: {
              id: path.slice(6),
              updatedAt: new Date(input.expectedUpdatedAt),
            },
            data: {
              status: input.status,
              ...(["QUER_FECHAR", "FECHADO", "PERDIDO"].includes(input.status)
                ? { humanRequired: true }
                : {}),
            },
          });
          if (!changed.count) throw new Error("EDIT_CONFLICT");
          const lead = await tx.lead.findUniqueOrThrow({
            where: { id: path.slice(6) },
            include: {
              assignedTo: { select: { id: true, name: true } },
              _count: { select: { contacts: true, messages: true } },
            },
          });
          await tx.auditLog.create({
            data: {
              userId: user?.id,
              leadId: lead.id,
              event: `STATUS_${input.status}`,
            },
          });
          return lead;
        }),
      );
    }
    if (req.method === "GET" && path === "messages")
      return json(
        await db.message.findMany({
          where: { leadId: url.searchParams.get("leadId") ?? "" },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
      );
    if (req.method === "POST" && path === "messages") {
      const input = manualInput.parse(await req.json());
      return json(
        await db.$transaction(async (tx) => {
          await tx.lead.update({
            where: { id: input.leadId },
            data: { humanRequired: true },
          });
          const message = await tx.message.create({
            data: { ...input, direction: "OUTBOUND", delivery: "PENDING" },
          });
          await tx.auditLog.create({
            data: {
              userId: user?.id,
              leadId: input.leadId,
              event: "MANUAL_MESSAGE_QUEUED",
            },
          });
          return message;
        }),
        201,
      );
    }
    if (req.method === "POST" && /^messages\/[^/]+\/dispatch$/.test(path))
      return json(await dispatch(path.split("/")[1]));
    if (req.method === "GET" && ["export-csv", "export-pdf"].includes(path)) {
      const rows = await exportRows(url);
      if (path === "export-csv")
        return new Response(
          csv([
            ["Nome", "Telefone", "Email", "Status", "Criado UTC"],
            ...rows.map((l) => [
              l.name,
              l.phone,
              l.email ?? "",
              l.status,
              l.createdAt.toISOString(),
            ]),
          ]),
          {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": 'attachment; filename="leads.csv"',
              "Cache-Control": "no-store",
            },
          },
        );
      const doc = new PDFDocument({ margin: 40 });
      const chunks: Buffer[] = [];
      const done = new Promise<Buffer>((resolve, reject) => {
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);
      });
      doc.fontSize(18).text("QUEIROZ E ANDRADE ADVOGADOS — Relatório de leads");
      doc.fontSize(10).text(`Gerado em UTC: ${new Date().toISOString()}`);
      for (const l of rows)
        doc
          .moveDown()
          .text(
            `${l.name} | ${l.phone} | ${l.email ?? ""}\n${l.status} | ${l.createdAt.toISOString()}`,
          );
      doc.end();
      return new Response(new Uint8Array(await done), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="leads.pdf"',
          "Cache-Control": "no-store",
        },
      });
    }
    return json({ error: "Rota inexistente" }, 404);
  } catch (error) {
    if (
      error instanceof ZodError ||
      error instanceof SyntaxError ||
      (error instanceof Error && error.message === "INVALID_PERIOD")
    )
      return json({ error: "Dados ou período inválidos" }, 400);
    const code = (error as { code?: string }).code;
    if (code === "P2002") return json({ error: "Registro já existente" }, 409);
    if (code === "P2025") return json({ error: "Registro inexistente" }, 404);
    if (error instanceof Error && error.message === "LOGIN_RATE_LIMIT")
      return json({ error: "Muitas tentativas; aguarde 15 minutos." }, 429);
    if (error instanceof Error && error.message === "INVALID_LOGIN")
      return json({ error: "Email ou senha inválidos" }, 401);
    if (error instanceof Error && error.message === "BOOTSTRAP_COMPLETE")
      return json({ error: "O administrador inicial já foi criado" }, 409);
    const known = [
      "EDIT_CONFLICT",
      "PROVIDER_NOT_CONFIGURED",
      "PROVIDER_REQUIRES_HTTPS",
      "MESSAGE_NOT_PENDING",
      "EXPORT_TOO_LARGE",
      "INVALID_MEDIA",
      "MEDIA_DOWNLOAD_FAILED",
    ];
    if (error instanceof Error && known.includes(error.message))
      return json({ error: error.message }, 409);
    // Não registrar corpos, tokens, prompts ou dados pessoais em logs técnicos.
    console.error("CRM_OPERATION_FAILED", code ?? "UNKNOWN");
    return json(
      { error: "Operação indisponível; tente novamente ou acione a equipe." },
      503,
    );
  }
}
export const GET = handler;
export const POST = handler;
export const PATCH = handler;
