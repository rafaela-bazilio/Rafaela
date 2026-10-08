import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { z } from "zod";
import { db } from "./db";
export const loginInput = z
  .object({
    email: z
      .string()
      .email()
      .transform((v) => v.toLowerCase()),
    password: z.string().min(1).max(128),
  })
  .strict();
export const userInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z
      .string()
      .email()
      .transform((v) => v.toLowerCase()),
    password: z.string().min(12).max(128),
    role: z.enum(["ADMIN", "AGENT"]),
  })
  .strict();
export const bootstrapInput = userInput.omit({ role: true }).strict();
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, hash: string) {
  const [salt, value] = hash.split(":");
  if (!salt || !value) return false;
  const actual = scryptSync(password, salt, 64),
    expected = Buffer.from(value, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function sessionToken(req: Request) {
  return req.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith("crm_session="))
    ?.slice(12);
}
export async function currentUser(req: Request) {
  const token = sessionToken(req);
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { id: digest(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt <= new Date() || !session.user.active)
    return null;
  return session.user;
}
export function cookie(token: string, maxAge: number) {
  return `crm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
export async function login(raw: unknown) {
  const input = loginInput.parse(raw),
    key = digest(input.email),
    since = new Date(Date.now() - 15 * 60000);
  const allowed = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    if (
      (await tx.loginAttempt.count({
        where: { key, createdAt: { gte: since } },
      })) >= 10
    )
      return false;
    await tx.loginAttempt.create({ data: { key } });
    return true;
  });
  if (!allowed) throw new Error("LOGIN_RATE_LIMIT");
  const user = await db.user.findUnique({ where: { email: input.email } });
  const valid = verifyPassword(
    input.password,
    user?.passwordHash ?? "00000000000000000000000000000000:" + "0".repeat(128),
  );
  if (!user || !user.active || !valid) throw new Error("INVALID_LOGIN");
  const token = randomBytes(32).toString("hex");
  await db.$transaction([
    db.session.create({
      data: {
        id: digest(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + 8 * 3600000),
      },
    }),
    db.auditLog.create({ data: { userId: user.id, event: "USER_LOGIN" } }),
  ]);
  return { token, user: { id: user.id, name: user.name, role: user.role } };
}

export async function bootstrapAdmin(raw: unknown) {
  const input = bootstrapInput.parse(raw);
  const token = randomBytes(32).toString("hex");
  const user = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(17431022)`;
    if ((await tx.user.count()) !== 0) throw new Error("BOOTSTRAP_COMPLETE");
    const created = await tx.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash: hashPassword(input.password),
        role: "ADMIN",
      },
    });
    await tx.session.create({
      data: {
        id: digest(token),
        userId: created.id,
        expiresAt: new Date(Date.now() + 8 * 3600000),
      },
    });
    await tx.auditLog.create({
      data: { userId: created.id, event: "INITIAL_ADMIN_CREATED" },
    });
    return created;
  });
  return { token, user: { id: user.id, name: user.name, role: user.role } };
}
