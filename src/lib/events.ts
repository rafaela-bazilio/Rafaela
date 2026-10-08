import { digest } from "./auth";
import { db } from "./db";
export function eventStream(
  signal: AbortSignal,
  userId?: string,
  token?: string,
) {
  const encoder = new TextEncoder();
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    controller: ReadableStreamDefaultController<Uint8Array>;
  let last = "";
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    try {
      controller.close();
    } catch {}
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      signal.addEventListener("abort", stop, { once: true });
      async function tick() {
        if (stopped) return;
        try {
          if (token) {
            const session = await db.session.findUnique({
              where: { id: digest(token) },
              include: { user: { select: { active: true } } },
            });
            if (
              !session ||
              !session.user.active ||
              session.expiresAt <= new Date()
            ) {
              stop();
              return;
            }
          }
          if (userId)
            await db.user.update({
              where: { id: userId },
              data: { lastSeenAt: new Date() },
            });
          const log = await db.auditLog.findFirst({
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { id: true },
          });
          const online = await db.user.findMany({
            where: {
              active: true,
              lastSeenAt: { gte: new Date(Date.now() - 10000) },
            },
            select: { id: true },
            orderBy: { id: "asc" },
          });
          const marker =
            (log?.id ?? "initial") + online.map((u) => u.id).join(",");
          if (marker !== last) {
            last = marker;
            controller.enqueue(
              encoder.encode(
                "data: " + JSON.stringify({ type: "refresh" }) + "\n\n",
              ),
            );
          } else controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          stop();
          return;
        }
        if (!stopped) timer = setTimeout(() => void tick(), 2000);
      }
      void tick();
    },
    cancel() {
      stop();
      signal.removeEventListener("abort", stop);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
