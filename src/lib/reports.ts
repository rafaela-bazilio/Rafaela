import { Prisma } from "@prisma/client";
import { db } from "./db";
import { filters } from "./validation";
export async function report(url: URL) {
  const f = filters(url);
  const createdAt = { gte: f.start, lt: f.end };
  const leadFilter = f.status ? { status: f.status } : {};
  return db.$transaction(
    async (tx) => {
      const contacts = await tx.contact.count({
        where: { createdAt, lead: leadFilter },
      });
      const newLeads = await tx.lead.count({
        where: { createdAt, ...leadFilter },
      });
      // Estado atual: não restringir à data de criação para não omitir leads antigos.
      const closing = await tx.lead.count({ where: { status: "QUER_FECHAR" } });
      const days = await tx.$queryRaw<Array<{ day: string; count: number }>>`
      SELECT to_char(c."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
      FROM "Contact" c JOIN "Lead" l ON l.id = c."leadId"
      WHERE c."createdAt" >= ${f.start} AND c."createdAt" < ${f.end}
      ${f.status ? Prisma.sql`AND l.status = ${f.status}::"Status"` : Prisma.empty}
      GROUP BY 1 ORDER BY 1`;
      const funnel = await tx.lead.groupBy({
        by: ["status"],
        _count: { _all: true },
      });
      const humanQueue = await tx.lead.count({
        where: {
          humanRequired: true,
          status: { notIn: ["FECHADO", "PERDIDO"] },
        },
      });
      const won = await tx.lead.count({
        where: { createdAt, status: "FECHADO" },
      });
      const allNew = await tx.lead.count({ where: { createdAt } });
      const recent = await tx.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 8,
        include: {
          user: { select: { name: true } },
          lead: { select: { name: true } },
        },
      });
      return {
        contacts,
        newLeads,
        closing,
        days,
        funnel: funnel.map((v) => ({ status: v.status, count: v._count._all })),
        humanQueue,
        conversion: allNew ? Math.round((won / allNew) * 100) : 0,
        recent,
        start: f.start,
        end: f.end,
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
export async function exportRows(url: URL) {
  const f = filters(url);
  // Limite explícito: não truncar silenciosamente relatórios grandes.
  const rows = await db.lead.findMany({
    where: { createdAt: { gte: f.start, lt: f.end }, status: f.status },
    orderBy: { createdAt: "asc" },
    take: 10001,
  });
  if (rows.length > 10000) throw new Error("EXPORT_TOO_LARGE");
  return rows;
}
