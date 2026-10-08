# Validação executável

- `npm test`: validação E.164/email, timezone/períodos, proteção contra fórmulas em CSV, handoff por intenção, fallback sem credenciais, `pushName`/eventos próprios e mensagens configuráveis.
- `npm run test:integration`: usa **crm_test**, separado do banco principal; valida webhook concorrente/idempotente, primeiro contato, leads únicos, status, métricas, CSV/PDF, login/logout, RBAC, responsáveis, conflito de versão, notas entre usuários, SSE após mudança de outra sessão e upload/download autenticado de PDF/imagem/áudio. O teste cria registros próprios e os remove no finally.
- Saída e recebimento Evolution são exercitados com respostas HTTP simuladas para verificar endpoints, payloads e estados de entrega. Isso não comprova codec, conexão ou entrega real no WhatsApp.
- `npm run typecheck` e `npm run build`: tipos e compilação de produção.
- `node scripts/smoke.mjs`: aplicação HTTP real, acesso autorizado a métricas e exportações; sem publicar links de loopback.

Homologação externa pendente: credenciais OpenAI/Evolution, webhook da instância real, codec de voz, envio/recebimento entre aparelhos e callbacks de entrega. Gravação do navegador depende de permissão de microfone e HTTPS. Nenhuma mensagem foi enviada a clientes reais durante os testes.
