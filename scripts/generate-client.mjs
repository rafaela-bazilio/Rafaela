// Binary-free generator using Prisma's version-pinned official npm packages.
// No checksum/TLS verification is disabled. Runtime uses the PostgreSQL JS adapter.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { getGenerators } = require("@prisma/internals");
const { PrismaClientJsGenerator } = require("@prisma/client-generator-js");
const generators = await getGenerators({
  schemaPath: "prisma/schema.prisma",
  registry: {
    "prisma-client-js": {
      type: "in-process",
      generator: new PrismaClientJsGenerator({
        cliCommand: "prisma",
        shouldResolvePrismaClient: true,
      }),
    },
  },
  cliCommand: "prisma",
});
try {
  for (const generator of generators) await generator.generate();
} finally {
  for (const generator of generators) generator.stop();
}
