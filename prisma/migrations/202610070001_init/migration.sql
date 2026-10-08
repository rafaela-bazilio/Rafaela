CREATE TYPE "Status" AS ENUM ('NOVO','EM_ATENDIMENTO','QUER_FECHAR','FECHADO','PERDIDO');
CREATE TYPE "Direction" AS ENUM ('INBOUND','OUTBOUND');
CREATE TABLE "Lead" (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, email TEXT,
 status "Status" NOT NULL DEFAULT 'NOVO', "humanRequired" BOOLEAN NOT NULL DEFAULT false,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE TABLE "Contact" (
 id TEXT PRIMARY KEY, "leadId" TEXT NOT NULL REFERENCES "Lead"(id) ON UPDATE CASCADE,
 "firstContact" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Message" (
 id TEXT PRIMARY KEY, "leadId" TEXT NOT NULL REFERENCES "Lead"(id) ON UPDATE CASCADE,
 "externalId" TEXT UNIQUE, direction "Direction" NOT NULL, body TEXT NOT NULL,
 delivery TEXT NOT NULL DEFAULT 'RECEIVED', "filePath" TEXT, "fileName" TEXT, "mimeType" TEXT, "fileSize" INTEGER,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "AuditLog" (
 id TEXT PRIMARY KEY, "leadId" TEXT REFERENCES "Lead"(id) ON UPDATE CASCADE ON DELETE SET NULL,
 event TEXT NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "AiSettings" (
 id TEXT PRIMARY KEY DEFAULT 'office', enabled BOOLEAN NOT NULL DEFAULT true,
 greeting TEXT NOT NULL DEFAULT 'Olá, {nome}! Recebemos sua mensagem. Como podemos direcionar seu atendimento?',
 handoff TEXT NOT NULL DEFAULT '{nome}, vou encaminhar seu atendimento à equipe humana para orientações autorizadas.',
 "systemPrompt" TEXT NOT NULL DEFAULT 'Você é a recepção de um escritório de serviços profissionais.',
 "updatedAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "Lead_createdAt_idx" ON "Lead"("createdAt");
CREATE INDEX "Lead_status_createdAt_idx" ON "Lead"(status,"createdAt");
CREATE INDEX "Contact_createdAt_leadId_idx" ON "Contact"("createdAt","leadId");
CREATE UNIQUE INDEX "Contact_firstContact_unique" ON "Contact"("leadId") WHERE "firstContact" = true;
CREATE INDEX "Message_leadId_createdAt_idx" ON "Message"("leadId","createdAt");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
