import "dotenv/config";
import { db } from "../src/lib/db";
import { userInput, hashPassword } from "../src/lib/auth";
const input = userInput.parse({
  name: process.env.ADMIN_NAME ?? "Administrador",
  email: process.env.ADMIN_EMAIL,
  password: process.env.ADMIN_PASSWORD,
  role: "ADMIN",
});
try {
  if (await db.user.findUnique({ where: { email: input.email } }))
    console.log("Administrador já existe; senha preservada.");
  else {
    await db.user.create({
      data: {
        name: input.name,
        email: input.email,
        role: input.role,
        passwordHash: hashPassword(input.password),
      },
    });
    console.log("Administrador criado.");
  }
} finally {
  await db.$disconnect();
}
