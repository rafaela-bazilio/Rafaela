# QUEIROZ E ANDRADE ADVOGADOS

CRM para um escritório de serviços profissionais: dashboard 360°, funil visual, atendimento, equipe em tempo real, respostas configuráveis e chat com áudio, PDF e imagens. Base executável para homologação; integrações externas precisam de instância e credenciais reais para validar entrega.

## 1. Visão Geral da Arquitetura & Stack Tecnológica Recomendada

Next.js 16 / React 19, TypeScript, PostgreSQL 17 e Prisma 7 com adaptador JS. OpenAI e Evolution API v2 são integrações documentadas e opcionais. Respostas aprovadas por palavra-chave funcionam sem serviço pago de IA. Sem resposta autorizada, o sistema encaminha para humanos.

```sh
npm ci --ignore-scripts --cache /workspace/.npm-cache
npm run setup:local
npm run db:up
npm run db:generate
npm run db:migrate
npm test
npm run test:integration
npm run build
npm run dev
```

Node.js 24 e Docker são os pré-requisitos locais. `setup:local` cria `.env` privado com credenciais locais aleatórias, sem exibir valores; preserva arquivo existente. Para PostgreSQL externo, configure DATABASE_URL e omita `db:up`. Copie as variáveis opcionais de `.env.example` conforme necessário.

Para publicar, o projeto inclui um `Dockerfile` portátil. A hospedagem precisa fornecer HTTPS, PostgreSQL persistente e um volume persistente montado em `/data/media`. Configure `DATABASE_URL`, `CRM_API_TOKEN`, `WEBHOOK_TOKEN` e `MEDIA_DIR=/data/media`; a rota pública `/api/health` confirma aplicação e banco sem revelar dados. O container aplica migrações transacionais antes de iniciar. Evolution e LLM continuam opcionais até a homologação.

No Railway, use `railway.toml`, adicione um serviço PostgreSQL e referencie sua `DATABASE_URL` no serviço web. Crie `CRM_API_TOKEN` e `WEBHOOK_TOKEN` distintos, aleatórios e com pelo menos 32 caracteres. Adicione um volume em `/data/media`; mantenha uma única réplica enquanto os anexos estiverem nesse volume. O primeiro acesso administrativo é criado pela interface depois que o domínio HTTPS estiver disponível.

No primeiro acesso, a própria tela solicita nome, email e uma senha de administrador com pelo menos 12 caracteres. Esse cadastro aparece somente enquanto não existir usuário e é protegido por transação contra criação concorrente. Depois, adicione membros na seção Equipe. Como alternativa para automação, configure **ADMIN_EMAIL** e **ADMIN_PASSWORD** de forma segura e execute `npm run db:admin`. Não compartilhe credenciais em chat, código, logs ou Git. ADMIN_NAME é opcional.

Use o checkout existente: tarefas na nuvem já são isoladas; não crie worktrees sem solicitação explícita. Banco local usa volume Docker, e anexos usam MEDIA_DIR; esses dados exigem backup/restore em outra máquina. Veja [decisões da arquitetura](docs/ARCHITECTURE.md).

## 2. Esquema do Banco de Dados (Database Schema)

[Schema Prisma](prisma/schema.prisma) e [migrações](prisma/migrations):

| Entidade       | Responsabilidade                                                                 |
| -------------- | -------------------------------------------------------------------------------- |
| Lead           | Cliente único por telefone E.164, nome, email, status, responsável e pausa da IA |
| Contact        | Cada interação recebida e flag `firstContact`                                    |
| Message        | Texto, direção, timestamp, estado de envio e metadados de mídia                  |
| AuditLog       | Eventos UTC e usuário responsável, sem corpos confidenciais                      |
| AiSettings     | Prompt de recepção, saudação, transferência, FAQ aprovada e autoenvio            |
| User / Session | Equipe ADMIN/AGENT e sessões individuais                                         |
| Note           | Contexto interno colaborativo, nunca enviado ao cliente                          |
| LoginAttempt   | Limite persistido de tentativas de login                                         |

Status: NOVO, EM_ATENDIMENTO, QUER_FECHAR, FECHADO e PERDIDO. Pedido de contrato exige humano; estados terminais não são reabertos pelo webhook. Telefone é validado em E.164 e email é validado antes de inserção. Todas as entidades persistidas registram UTC com `timestamptz`; APIs usam ISO 8601.

**Integridade:** contatos recorrentes não criam leads novos. Telefone único, deduplicação por ID externo, lock por telefone e primeiro contato atômico. Novo lead é contabilizado por `Lead.createdAt`, não por quantidade de mensagens. Índices: criação, status+criação, histórico por lead e responsável. Alterações concorrentes de status/responsável usam `expectedUpdatedAt` e retornam 409 em conflito.

## 3. Módulo de Relatórios e Consultas (Queries e Endpoints de Exportação CSV/PDF)

[Queries Prisma/SQL parametrizadas](src/lib/reports.ts). Semana começa segunda-feira 00:00 UTC; mês começa dia 1; período customizado é `[start,end)`, até 366 dias. Parâmetros: `period=week|month|custom`, `start/end` ISO com timezone e `status` opcional.

| Método / rota                    | Função                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| GET /api/metrics                 | Contatos, novos leads, fechamento atual, fila humana, conversão, funil e atividade |
| GET /api/leads?status=NOVO&q=Ana | Até 200 leads recentes por status/nome, responsável e contagens                    |
| POST /api/leads                  | `{name,phone,email?}` validado                                                     |
| PATCH /api/leads/:id             | `{status,expectedUpdatedAt}`                                                       |
| PATCH /api/leads/:id/assign      | `{assignedToId,expectedUpdatedAt}`; responsável ativo ou null                      |
| GET /api/messages?leadId=...     | Até 100 mensagens recentes                                                         |
| POST /api/messages               | `{leadId,body}`; assume humano e cria PENDING                                      |
| POST /api/messages/:id/dispatch  | Envio via Evolution configurada                                                    |
| GET /api/export-csv              | CSV com proteção contra injeção de fórmulas                                        |
| GET /api/export-pdf              | PDF paginado automaticamente                                                       |
| POST /api/webhooks/whatsapp      | Evento canônico ou Evolution nativo autenticado                                    |
| GET/PATCH /api/settings          | Configuração de IA; alterações exclusivas de ADMIN                                 |
| POST/GET /api/media              | Upload multipart; download por `/api/media/:messageId`                             |
| POST /api/auth/login             | `{email,password}`; sessão HttpOnly                                                |
| POST /api/auth/logout            | Revoga sessão                                                                      |
| GET /api/auth/me                 | Usuário e papel atuais                                                             |
| GET/POST /api/team               | Equipe ativa; criação exclusiva de ADMIN                                           |
| GET/POST /api/notes              | Notas por lead; criação exige usuário individual                                   |
| GET /api/events                  | Stream SSE autenticado para sincronizar a equipe                                   |

Rotas internas aceitam sessão ou `Authorization: Bearer <CRM_API_TOKEN>`; webhook exige **WEBHOOK_TOKEN** distinto. O token interno é administrativo e serve para bootstrap/testes, não para compartilhar com atendentes. Cookies são Secure em produção: use HTTPS. Mutação valida origem e payload; não há conexão SQL no browser.

Contatos/novos leads usam o período e filtro de status atual. Fechamento, distribuição do funil e fila humana são **estado atual de todos os leads**. Conversão é percentual FECHADO na coorte criada no período, independente do filtro de status. Não representa histórico de transições. Exportações selecionam leads **criados** no período, até 10.000 linhas; excesso é rejeitado, não truncado. Lista do funil usa status e os 200 mais recentes; o período aplica-se aos indicadores/exportações.

Script completo de exportação imediata: [scripts/export-csv.mjs](scripts/export-csv.mjs).

```sh
# CRM_API_TOKEN deve estar definido de forma segura no ambiente.
CRM_BASE_URL=http://127.0.0.1:3000 node scripts/export-csv.mjs 'period=custom&start=2026-10-01T00:00:00Z&end=2026-11-01T00:00:00Z&status=QUER_FECHAR' leads.csv
```

## 4. Módulo de Automação de IA (Prompt de Sistema + Código da Função de Atendimento)

[Guardrails/prompt](src/lib/ai.ts), [recepção e despacho](src/lib/service.ts), [configuração](src/lib/settings.ts).

Na seção Configurações, ADMIN edita saudação, transferência humana, prompt de recepção e até 30 respostas aprovadas por assunto/palavra-chave. `{nome}` personaliza textos. Regras de contrato, condições comerciais e confidencialidade precedem FAQ e LLM e permanecem obrigatórias. Nunca coloque segredos ou dados internos em prompts/templates. A validação bloqueia padrões comerciais comuns, mas o administrador deve revisar todo conteúdo aprovado.

LLM opcional: `LLM_API_KEY`, `LLM_MODEL` e prompt configurável. Contexto limitado a 12 mensagens / 2.000 caracteres por mensagem, timeout 15s, saída JSON validada. O modelo não possui ferramentas ou acesso ao banco; texto livre não é entregue ao cliente. Sem FAQ autorizada ou decisão segura, exige humano. Não há transcrição, OCR ou aconselhamento profissional automatizado.

**Nome do WhatsApp:** usa `data.pushName` quando disponível. Sem nome, cria `Cliente WhatsApp`; preenche esse nome provisório quando receber um nome disponível. Nunca substitui nome previamente cadastrado pela equipe. Não acessa agenda privada do cliente.

Evento canônico de texto:

```json
{
  "externalId": "instance:message-id",
  "name": "Ana",
  "phone": "+5511999999999",
  "email": "ana@example.com",
  "body": "Quero fechar contrato"
}
```

Evolution nativo: aceita `messages.upsert` com `data.key`, `data.pushName`, `conversation`, `extendedTextMessage`, `audioMessage`, `imageMessage` ou `documentMessage`. Ignora grupos, mensagens próprias e formatos não suportados. Configure autenticação do webhook em um gateway/provedor com Bearer WEBHOOK_TOKEN, sem colocar token em URL.

**Mídia:** chat grava áudio no navegador ou anexa MP3/OGG/WAV/WebM/M4A, PDF, JPEG, PNG e WebP até 15 MB. Assinatura real é validada com `file-type`. Upload usa multipart `leadId`, `file`, `body?`; download exige autenticação. Arquivos ficam fora de `public/`, em MEDIA_DIR privado. Imagens/áudios são carregados por URLs Blob autenticadas; PDFs são baixados. MP4/WebM dependem de MIME de áudio e codec: confirmar compatibilidade em homologação.

Evolution exige **EVOLUTION_URL** HTTPS, **EVOLUTION_INSTANCE** e **EVOLUTION_API_KEY**. Entrada busca arquivo por `/chat/getBase64FromMediaMessage/{instance}`, sem seguir URL do cliente. Saída usa `/message/sendText`, `/message/sendWhatsAppAudio` ou `/message/sendMedia`, com instância. Áudio/imagem/documento recebido aciona humano; não é interpretado pelo LLM.

Outbox: PENDING → SENDING → ACCEPTED/FAILED/UNKNOWN. ACCEPTED significa aceitação, não entrega/leitura. Por padrão, o operador despacha mensagens; autoenvio de respostas autorizadas pode ser habilitado por ADMIN após configurar Evolution e homologar. Não reenviar automaticamente UNKNOWN/SENDING: reconciliar com provedor. Worker durável, retries e callbacks de entrega ainda precisam ser adicionados para produção.

**As automações de IA exigem testes em ambiente de homologação antes do uso em produção com clientes reais.**

## 5. Estrutura Visual do Dashboard (Frontend Layout & Componentes)

[Dashboard](app/page.tsx), [gravação de áudio](app/Recorder.tsx) e [estilos responsivos](app/style.css):

- Navegação lateral e acesso individual, layout responsivo, controles identificados e erros explícitos.
- Visão 360°: indicadores, distribuição do funil, conversão da coorte, volume diário, fila humana e atividade.
- Kanban com arraste entre etapas, tabela alternativa e filtros de status; seleção de status também funciona sem arraste.
- Cliente: telefone, email, cadastro UTC, responsável, contatos, mensagens e notas internas.
- Chat: histórico, respostas manuais, reprodução/gravação de voz e envio/recebimento de PDF/imagens.
- Equipe: usuários ADMIN/AGENT, presença online, atribuição e notas compartilhadas. SSE atualiza mudanças em cerca de 2s e reconecta em falhas.
- Configurações: respostas por assunto, mensagens personalizadas, prompt e controle de autoenvio.

## Validação e limites de produção

[Plano e evidências dos testes](docs/VALIDATION.md). `npm run test:integration` cria banco local **crm_test**, nunca usa banco remoto/principal. Exercita PostgreSQL real; respostas Evolution são simuladas. Credenciais/instância externa, entrega real, codecs e microfone no navegador precisam de homologação.

As migrações usam runner SQL com transação, lock e checksum, via `npm run db:migrate`. Não misture `_crm_migrations` com `prisma migrate deploy` sem baseline. Gerador Prisma usa pacotes oficiais internos fixados em 7.10.0 para evitar download desnecessário de binários; revisar compatibilidade em upgrades. Verificação TLS/checksum não é desativada.

Antes de produção: RBAC mais granular, desativação/recuperação de contas, MFA/OIDC conforme necessidade, rate limiting global, limite de conexões, worker de outbox, callbacks, antivírus/quarentena, backups/restore, consentimento e retenção LGPD. Esta versão é de um único escritório; não implementa múltiplos tenants. SSE usa polling compartilhado via PostgreSQL; escalar para pub/sub em equipes grandes. Não publicar até concluir homologação com clientes de teste.

Para LLM na nuvem, a chave opcional LLM_API_KEY pode ser inserida nas configurações seguras do ambiente. OPENAI_API_KEY é um alias aceito em execução local, mas esse nome é reservado para bindings da plataforma. Libere api.openai.com e o hostname real do Evolution na política de rede ao configurar integrações externas.
