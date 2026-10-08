"use client";
import Recorder from "./Recorder";
import { useEffect, useState, useRef } from "react";
type Lead = {
  id: string;
  name: string;
  phone: string;
  status: string;
  humanRequired: boolean;
  email?: string;
  createdAt: string;
  updatedAt: string;
  assignedToId?: string;
  assignedTo?: { id: string; name: string };
  _count?: { contacts: number; messages: number };
};
type Message = {
  id: string;
  body: string;
  direction: string;
  delivery: string;
  createdAt: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
};
type Metrics = {
  contacts: number;
  newLeads: number;
  closing: number;
  days: { day: string; count: number }[];
  funnel: { status: string; count: number }[];
  humanQueue: number;
  conversion: number;
  recent: {
    id: string;
    event: string;
    createdAt: string;
    user?: { name: string };
    lead?: { name: string };
  }[];
};
const stages = {
  NOVO: "Novo",
  EM_ATENDIMENTO: "Em atendimento",
  QUER_FECHAR: "Quer fechar contrato",
  FECHADO: "Fechado",
  PERDIDO: "Perdido",
};
export default function Dashboard() {
  const [loginEmail, setLoginEmail] = useState(""),
    [loginPassword, setLoginPassword] = useState(""),
    [loginName, setLoginName] = useState(""),
    [confirmPassword, setConfirmPassword] = useState(""),
    [bootstrapRequired, setBootstrapRequired] = useState<boolean | null>(null),
    [me, setMe] = useState<{ name: string; role: string }>(),
    [team, setTeam] = useState<
      {
        id: string;
        name: string;
        email: string;
        role: string;
        lastSeenAt?: string;
      }[]
    >([]),
    [member, setMember] = useState({
      name: "",
      email: "",
      password: "",
      role: "AGENT",
    }),
    [notes, setNotes] = useState<
      { id: string; body: string; createdAt: string; user: { name: string } }[]
    >([]),
    [note, setNote] = useState(""),
    [live, setLive] = useState(false);
  const callbacks = useRef<{
    refresh: () => Promise<void>;
    chat: () => Promise<void>;
  }>({ refresh: async () => {}, chat: async () => {} });
  const [token, setToken] = useState(""),
    [connected, setConnected] = useState(false),
    [error, setError] = useState("");

  useEffect(() => {
    void guard(async () => {
      const response = await fetch("/api/auth/bootstrap", {
        headers: { "Cache-Control": "no-store" },
      });
      if (!response.ok)
        throw new Error("Não foi possível verificar o acesso inicial.");
      const data = (await response.json()) as { required: boolean };
      setBootstrapRequired(data.required);
    });
  }, []);
  const [leads, setLeads] = useState<Lead[]>([]),
    [metrics, setMetrics] = useState<Metrics>();
  const [period, setPeriod] = useState("month"),
    [status, setStatus] = useState(""),
    [start, setStart] = useState(""),
    [end, setEnd] = useState("");
  const [selected, setSelected] = useState<Lead>(),
    [messages, setMessages] = useState<Message[]>([]),
    [body, setBody] = useState("");
  const [file, setFile] = useState<File>(),
    [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<{
      enabled: boolean;
      autoSend: boolean;
      greeting: string;
      handoff: string;
      systemPrompt: string;
      rules: { keywords: string[]; reply: string }[];
    }>({
      enabled: true,
      autoSend: false,
      greeting: "",
      handoff: "",
      systemPrompt: "",
      rules: [],
    }),
    [saved, setSaved] = useState("");
  const [name, setName] = useState(""),
    [phone, setPhone] = useState(""),
    [email, setEmail] = useState(""),
    [view, setView] = useState("kanban");
  const query = () => {
    const q = new URLSearchParams({ period });
    if (status) q.set("status", status);
    if (period === "custom") {
      if (!start || !end) throw new Error("Informe início e fim.");
      q.set("start", new Date(start + ":00Z").toISOString());
      q.set("end", new Date(end + ":00Z").toISOString());
    }
    return q.toString();
  };
  async function request(path: string, options: RequestInit = {}) {
    const r = await fetch("/api/" + path, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
    });
    if (!r.ok) {
      const data = await r.json();
      throw new Error(data.error);
    }
    return r;
  }
  async function guard(action: () => Promise<void>) {
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function refresh() {
    const q = query();
    const [l, m, t] = await Promise.all([
      request("leads?" + q),
      request("metrics?" + q),
      request("team"),
    ]);
    setTeam(await t.json());
    const latest: Lead[] = await l.json();
    setLeads(latest);
    setSelected((prev) =>
      prev ? (latest.find((v) => v.id === prev.id) ?? prev) : prev,
    );
    setMetrics(await m.json());
    if (!connected) {
      setSettings(await (await request("settings")).json());
      setMe(await (await request("auth/me")).json());
    }
    setConnected(true);
  }
  async function chat(lead: Lead) {
    setSelected((prev) => (prev?.id === lead.id ? prev : lead));
    const [messages, notes] = await Promise.all([
      request("messages?leadId=" + lead.id),
      request("notes?leadId=" + lead.id),
    ]);
    setMessages((await messages.json()).reverse());
    setNotes(await notes.json());
  }
  callbacks.current = {
    refresh,
    chat: async () => {
      if (selected) await chat(selected);
    },
  };
  useEffect(() => {
    if (!connected) return;
    const abort = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    async function connect() {
      try {
        const r = await fetch("/api/events", {
          headers: { Authorization: `Bearer ${token}` },
          signal: abort.signal,
        });
        if (!r.ok || !r.body) throw new Error("Realtime indisponível");
        setLive(true);
        const reader = r.body.getReader(),
          decoder = new TextDecoder();
        let pending = "";
        while (!abort.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const frames = pending.split("\n\n");
          pending = frames.pop() ?? "";
          for (const frame of frames)
            if (frame.startsWith("data:")) {
              await callbacks.current.refresh();
              await callbacks.current.chat();
            }
        }
      } catch {
        if (abort.signal.aborted) return;
      }
      setLive(false);
      if (!abort.signal.aborted) retry = setTimeout(() => void connect(), 3000);
    }
    void connect();
    return () => {
      abort.abort();
      clearTimeout(retry);
    };
  }, [connected, token]);
  async function move(lead: Lead, status: string) {
    const updated = await (
      await request("leads/" + lead.id, {
        method: "PATCH",
        body: JSON.stringify({ status, expectedUpdatedAt: lead.updatedAt }),
      })
    ).json();
    if (selected?.id === lead.id) setSelected(updated);
    await refresh();
  }
  async function attachment(message: Message) {
    const r = await request("media/" + message.id);
    const href = URL.createObjectURL(await r.blob());
    if (
      message.mimeType?.startsWith("audio/") ||
      message.mimeType?.startsWith("image/")
    )
      setMediaUrls((old) => {
        if (old[message.id]) URL.revokeObjectURL(old[message.id]);
        return { ...old, [message.id]: href };
      });
    else {
      const a = document.createElement("a");
      a.href = href;
      a.download = message.fileName ?? "arquivo";
      a.click();
      URL.revokeObjectURL(href);
    }
  }
  async function upload() {
    if (!file || !selected) return;
    const form = new FormData();
    form.append("file", file);
    form.append("leadId", selected.id);
    form.append("body", body || "[Arquivo enviado]");
    await request("media", { method: "POST", body: form });
    setFile(undefined);
    setBody("");
    await chat(selected);
  }
  async function download(format: string) {
    const r = await request(`export-${format}?${query()}`);
    const href = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = href;
    a.download = `leads.${format}`;
    a.click();
    URL.revokeObjectURL(href);
  }
  return (
    <>
      <aside className="sidebar">
        <div className="brand">
          <b>QA</b>
          <span>
            QUEIROZ E ANDRADE
            <br />
            ADVOGADOS
          </span>
        </div>
        <nav>
          <a href="#overview">◈ Visão 360°</a>
          <a href="#pipeline">▥ Funil de vendas</a>
          <a href="#conversation">◌ Conversas</a>
          <a href="#team">♧ Equipe</a>
          <a href="#settings">⚙ Configurações</a>
        </nav>
        <div className="sidebar-foot">
          Relacionamentos que
          <br />
          se tornam oportunidades.
        </div>
      </aside>
      <main id="overview">
        <header>
          <div>
            <span className="eyebrow">RELACIONAMENTO • ATENDIMENTO</span>
            <h1>QUEIROZ E ANDRADE ADVOGADOS</h1>
            <p>Uma visão clara de cada conversa e oportunidade.</p>
          </div>
          <div className="header-actions">
            <span className="badge">
              {connected
                ? live
                  ? "● Equipe em tempo real"
                  : "Reconectando equipe…"
                : "Atendimento profissional"}
            </span>
            {connected && (
              <button
                className="secondary"
                onClick={() =>
                  void guard(async () => {
                    await request("auth/logout", { method: "POST" });
                    setConnected(false);
                    setToken("");
                    setMe(undefined);
                  })
                }
              >
                Sair
              </button>
            )}
          </div>
        </header>
        {!connected ? (
          <section className="login">
            <span className="eyebrow">BEM-VINDO AO SEU ESCRITÓRIO</span>
            <h2>
              {bootstrapRequired
                ? "Crie o primeiro acesso administrativo"
                : "Entre para acompanhar sua equipe"}
            </h2>
            {bootstrapRequired === null && (
              <p className="muted">Preparando o acesso seguro…</p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void guard(async () => {
                  if (bootstrapRequired && loginPassword !== confirmPassword)
                    throw new Error("As senhas não coincidem.");
                  await request(
                    bootstrapRequired ? "auth/bootstrap" : "auth/login",
                    {
                      method: "POST",
                      body: JSON.stringify({
                        ...(bootstrapRequired ? { name: loginName } : {}),
                        email: loginEmail,
                        password: loginPassword,
                      }),
                    },
                  );
                  setLoginPassword("");
                  setConfirmPassword("");
                  setBootstrapRequired(false);
                  await refresh();
                });
              }}
            >
              {bootstrapRequired && (
                <input
                  aria-label="Nome do administrador"
                  placeholder="Nome do administrador"
                  required
                  value={loginName}
                  onChange={(e) => setLoginName(e.target.value)}
                  autoComplete="name"
                />
              )}
              <input
                aria-label="Email de acesso"
                type="email"
                placeholder="Seu email"
                required
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                autoComplete="username"
              />
              <input
                aria-label="Senha"
                type="password"
                placeholder="Senha"
                required
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                autoComplete="current-password"
              />
              {bootstrapRequired && (
                <input
                  aria-label="Confirmar senha"
                  type="password"
                  minLength={12}
                  maxLength={128}
                  placeholder="Confirme a senha"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              )}
              <button disabled={bootstrapRequired === null}>
                {bootstrapRequired ? "Criar administrador e entrar" : "Entrar"}
              </button>
            </form>
            {!bootstrapRequired && (
              <details>
                <summary>Acesso interno de configuração</summary>
                <input
                  aria-label="Token interno"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                />
                <button onClick={() => void guard(refresh)}>Conectar</button>
              </details>
            )}
          </section>
        ) : (
          <>
            <section className="filters">
              <select
                aria-label="Período"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
              >
                <option value="week">Semana atual (UTC)</option>
                <option value="month">Mês atual (UTC)</option>
                <option value="custom">Intervalo personalizado</option>
              </select>
              {period === "custom" && (
                <>
                  <input
                    aria-label="Início UTC"
                    type="datetime-local"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                  />
                  <input
                    aria-label="Fim UTC exclusivo"
                    type="datetime-local"
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                  />
                </>
              )}
              <select
                aria-label="Status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">Todos os status</option>
                {Object.entries(stages).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
              <button onClick={() => void guard(refresh)}>Aplicar</button>
              <button
                className="secondary"
                onClick={() => void guard(() => download("csv"))}
              >
                CSV
              </button>
              <button
                className="secondary"
                onClick={() => void guard(() => download("pdf"))}
              >
                PDF
              </button>
            </section>
            <div className="cards">
              {[
                ["Contatos no período", metrics?.contacts],
                ["Novos leads no período", metrics?.newLeads],
                ["Querem fechar • estado atual", metrics?.closing],
                ["Precisam de atendimento humano", metrics?.humanQueue],
                [
                  "Conversão da coorte no período",
                  `${metrics?.conversion ?? 0}%`,
                ],
              ].map(([label, value]) => (
                <section key={label}>
                  <span>{label}</span>
                  <strong>{value ?? "—"}</strong>
                </section>
              ))}
            </div>
            <div className="insights">
              <section>
                <h2>Distribuição do funil • estado atual</h2>
                <p className="muted">
                  Todos os leads, independente do período selecionado.
                </p>
                {Object.entries(stages).map(([key, label]) => {
                  const count =
                    metrics?.funnel.find((v) => v.status === key)?.count ?? 0;
                  const total =
                    metrics?.funnel.reduce((a, v) => a + v.count, 0) || 1;
                  return (
                    <div className="funnel-row" key={key}>
                      <span>{label}</span>
                      <div>
                        <i style={{ width: `${(count / total) * 100}%` }} />
                      </div>
                      <b>{count}</b>
                    </div>
                  );
                })}
              </section>
              <section>
                <h2>Atividade da equipe</h2>
                {metrics?.recent.map((log) => (
                  <div className="activity" key={log.id}>
                    <span>●</span>
                    <div>
                      <b>{log.user?.name ?? "Sistema"}</b>
                      <p>
                        {log.event.replaceAll("_", " ")}{" "}
                        {log.lead?.name && `• ${log.lead.name}`}
                      </p>
                      <small>{log.createdAt}</small>
                    </div>
                  </div>
                ))}
              </section>
            </div>
            <section>
              <h2>Volume diário de contatos</h2>
              <div className="chart">
                {metrics?.days.length ? (
                  metrics.days.map((d) => (
                    <div className="bar-item" key={d.day}>
                      <span>{d.count}</span>
                      <div
                        className="bar"
                        style={{
                          height: `${Math.max(8, (d.count / Math.max(...metrics.days.map((v) => v.count))) * 100)}px`,
                        }}
                      />
                      <small>{d.day.slice(5)}</small>
                    </div>
                  ))
                ) : (
                  <p>Nenhum contato registrado neste período.</p>
                )}
              </div>
            </section>
            <section id="pipeline">
              <div className="title-row">
                <h2>Funil de relacionamento</h2>
                <button
                  className="secondary"
                  onClick={() =>
                    setView(view === "kanban" ? "table" : "kanban")
                  }
                >
                  {view === "kanban" ? "Ver tabela" : "Ver Kanban"}
                </button>
              </div>
              <p className="muted">
                Lista dos 200 leads mais recentes, filtrada por status. O
                período aplica-se aos indicadores e exportações.
              </p>
              {view === "kanban" ? (
                <div className="kanban">
                  {Object.entries(stages).map(([key, label]) => (
                    <div
                      className="column"
                      key={key}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const lead = leads.find(
                          (l) => l.id === e.dataTransfer.getData("text/plain"),
                        );
                        if (lead) void guard(() => move(lead, key));
                      }}
                    >
                      <h3>{label}</h3>
                      {leads
                        .filter((l) => l.status === key)
                        .map((l) => (
                          <button
                            className="lead"
                            draggable
                            onDragStart={(e) =>
                              e.dataTransfer.setData("text/plain", l.id)
                            }
                            key={l.id}
                            onClick={() => void guard(() => chat(l))}
                          >
                            <b>{l.name}</b>
                            <span>{l.phone}</span>
                            <small>
                              {l.assignedTo?.name ?? "Sem responsável"}
                            </small>
                            {l.humanRequired && (
                              <small>Equipe humana necessária</small>
                            )}
                          </button>
                        ))}
                    </div>
                  ))}
                </div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Nome</th>
                      <th>Telefone</th>
                      <th>Status</th>
                      <th>Atendimento</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.map((l) => (
                      <tr key={l.id}>
                        <td>{l.name}</td>
                        <td>{l.phone}</td>
                        <td>{stages[l.status as keyof typeof stages]}</td>
                        <td>
                          <button onClick={() => void guard(() => chat(l))}>
                            Abrir conversa
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            <section id="settings">
              <h2>Configurações do atendimento com IA</h2>
              <p className="muted">
                Personalize mensagens autorizadas usando {"{nome}"}. O nome vem
                do WhatsApp quando disponível; nomes já cadastrados são
                preservados. As regras de transferência para humanos permanecem
                obrigatórias.
              </p>
              <form
                className="settings"
                onSubmit={(e) => {
                  e.preventDefault();
                  void guard(async () => {
                    const value = {
                      enabled: settings.enabled,
                      autoSend: settings.autoSend,
                      greeting: settings.greeting,
                      handoff: settings.handoff,
                      systemPrompt: settings.systemPrompt,
                      rules: settings.rules,
                    };
                    await request("settings", {
                      method: "PATCH",
                      body: JSON.stringify(value),
                    });
                    setSaved("Configurações salvas.");
                  });
                }}
              >
                <label>
                  <input
                    type="checkbox"
                    checked={settings.enabled}
                    onChange={(e) =>
                      setSettings({ ...settings, enabled: e.target.checked })
                    }
                  />{" "}
                  Habilitar recepção por IA
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.autoSend}
                    onChange={(e) =>
                      setSettings({ ...settings, autoSend: e.target.checked })
                    }
                  />{" "}
                  Enviar respostas autorizadas automaticamente pelo WhatsApp
                  (exige Evolution configurado e homologação)
                </label>
                <label>
                  Mensagem de saudação
                  <textarea
                    required
                    maxLength={1000}
                    value={settings.greeting}
                    onChange={(e) => {
                      setSaved("");
                      setSettings({ ...settings, greeting: e.target.value });
                    }}
                  />
                </label>
                <label>
                  Mensagem de encaminhamento humano
                  <textarea
                    required
                    maxLength={1000}
                    value={settings.handoff}
                    onChange={(e) => {
                      setSaved("");
                      setSettings({ ...settings, handoff: e.target.value });
                    }}
                  />
                </label>
                <label>
                  Orientação do sistema (sem dados confidenciais)
                  <textarea
                    required
                    maxLength={2000}
                    value={settings.systemPrompt}
                    onChange={(e) => {
                      setSaved("");
                      setSettings({
                        ...settings,
                        systemPrompt: e.target.value,
                      });
                    }}
                  />
                </label>
                <h3>Respostas aprovadas por assunto</h3>
                <p className="muted">
                  Cadastre palavras-chave e o texto autorizado. Pedidos de
                  contrato, preços ou dados confidenciais continuam sendo
                  encaminhados para humanos.
                </p>
                {settings.rules.map((rule, index) => (
                  <div className="rule-editor" key={index}>
                    <input
                      aria-label={`Palavras-chave da regra ${index + 1}`}
                      placeholder="Palavras-chave separadas por vírgula"
                      required
                      value={rule.keywords.join(",")}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          rules: settings.rules.map((r, i) =>
                            i === index
                              ? { ...r, keywords: e.target.value.split(",") }
                              : r,
                          ),
                        })
                      }
                    />
                    <textarea
                      aria-label={`Resposta aprovada ${index + 1}`}
                      required
                      maxLength={1000}
                      value={rule.reply}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          rules: settings.rules.map((r, i) =>
                            i === index ? { ...r, reply: e.target.value } : r,
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        setSettings({
                          ...settings,
                          rules: settings.rules.filter((_, i) => i !== index),
                        })
                      }
                    >
                      Remover resposta
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="secondary"
                  disabled={settings.rules.length >= 30}
                  onClick={() =>
                    setSettings({
                      ...settings,
                      rules: [
                        ...settings.rules,
                        {
                          keywords: ["horário"],
                          reply:
                            "Olá, {nome}! Nossa equipe pode informar o horário de atendimento.",
                        },
                      ],
                    })
                  }
                >
                  Adicionar resposta por assunto
                </button>
                <button disabled={me?.role !== "ADMIN"}>
                  Salvar configurações
                </button>
                <span role="status">{saved}</span>
              </form>
            </section>
            <section>
              <h2>Novo lead</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void guard(async () => {
                    await request("leads", {
                      method: "POST",
                      body: JSON.stringify({
                        name,
                        phone,
                        ...(email ? { email } : {}),
                      }),
                    });
                    setName("");
                    setPhone("");
                    setEmail("");
                    await refresh();
                  });
                }}
              >
                <input
                  aria-label="Nome"
                  placeholder="Nome"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <input
                  aria-label="Telefone E.164"
                  placeholder="+5511999999999"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
                <input
                  aria-label="Email"
                  placeholder="Email opcional"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <button>Cadastrar</button>
              </form>
            </section>
            {selected && (
              <section className="chat" id="conversation">
                <div className="title-row">
                  <h2>Conversa • {selected.name}</h2>
                  <select
                    aria-label="Alterar status"
                    value={selected.status}
                    onChange={(e) =>
                      void guard(async () => {
                        const l = await (
                          await request("leads/" + selected.id, {
                            method: "PATCH",
                            body: JSON.stringify({
                              status: e.target.value,
                              expectedUpdatedAt: selected.updatedAt,
                            }),
                          })
                        ).json();
                        setSelected(l);
                        await refresh();
                      })
                    }
                  >
                    {Object.entries(stages).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="lead-360">
                  <div>
                    <span className="eyebrow">CLIENTE • VISÃO 360°</span>
                    <h3>{selected.name}</h3>
                    <p>
                      {selected.phone}
                      <br />
                      {selected.email ?? "Email não informado"}
                    </p>
                    <small>
                      Cadastro UTC: {selected.createdAt}
                      <br />
                      {selected._count?.contacts ?? 0} contatos ·{" "}
                      {selected._count?.messages ?? messages.length} mensagens
                    </small>
                  </div>
                  <label>
                    Responsável
                    <select
                      aria-label="Responsável pelo lead"
                      value={selected.assignedToId ?? ""}
                      onChange={(e) =>
                        void guard(async () => {
                          const lead = await (
                            await request(`leads/${selected.id}/assign`, {
                              method: "PATCH",
                              body: JSON.stringify({
                                assignedToId: e.target.value || null,
                                expectedUpdatedAt: selected.updatedAt,
                              }),
                            })
                          ).json();
                          setSelected(lead);
                          await refresh();
                        })
                      }
                    >
                      <option value="">Sem responsável</option>
                      {team.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="messages">
                  {messages.map((m) => (
                    <article
                      className={m.direction === "OUTBOUND" ? "outbound" : ""}
                      key={m.id}
                    >
                      <p>{m.body}</p>
                      {m.fileName && (
                        <div>
                          <button
                            className="secondary"
                            onClick={() => void guard(() => attachment(m))}
                          >
                            {m.mimeType?.startsWith("audio/")
                              ? "Ouvir áudio"
                              : m.mimeType?.startsWith("image/")
                                ? "Abrir imagem"
                                : "Baixar PDF"}{" "}
                            • {m.fileName}
                          </button>
                          {mediaUrls[m.id] &&
                            (m.mimeType?.startsWith("audio/") ? (
                              <audio controls src={mediaUrls[m.id]} />
                            ) : (
                              <img
                                className="attachment-image"
                                src={mediaUrls[m.id]}
                                alt={m.fileName}
                              />
                            ))}
                        </div>
                      )}
                      <small>
                        {m.createdAt} • {m.delivery}
                      </small>
                      {m.delivery === "PENDING" && (
                        <button
                          onClick={() =>
                            void guard(async () => {
                              await request(`messages/${m.id}/dispatch`, {
                                method: "POST",
                              });
                              await chat(selected);
                            })
                          }
                        >
                          Enviar via WhatsApp
                        </button>
                      )}
                    </article>
                  ))}
                  {!messages.length && <p>Nenhuma mensagem.</p>}
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void guard(async () => {
                      await request("messages", {
                        method: "POST",
                        body: JSON.stringify({ leadId: selected.id, body }),
                      });
                      setBody("");
                      await chat(selected);
                    });
                  }}
                >
                  <input
                    aria-label="Mensagem manual"
                    required
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="Escreva uma resposta revisada pela equipe"
                  />
                  <button>Registrar resposta</button>
                </form>
                <div className="upload">
                  <Recorder onAudio={setFile} onError={setError} />
                  {file && <span>{file.name}</span>}
                  <label>
                    Áudio, PDF ou imagem (até 15 MB)
                    <input
                      type="file"
                      accept="application/pdf,image/jpeg,image/png,image/webp,audio/mpeg,audio/ogg,audio/wav,audio/webm,audio/mp4,audio/x-m4a"
                      onChange={(e) => setFile(e.target.files?.[0])}
                    />
                  </label>
                  <button disabled={!file} onClick={() => void guard(upload)}>
                    Registrar arquivo
                  </button>
                </div>
                <div className="notes">
                  <h3>Notas internas • colaboração</h3>
                  {notes.map((n) => (
                    <article key={n.id}>
                      <b>{n.user.name}</b>
                      <p>{n.body}</p>
                      <small>{n.createdAt}</small>
                    </article>
                  ))}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void guard(async () => {
                        await request("notes", {
                          method: "POST",
                          body: JSON.stringify({
                            leadId: selected.id,
                            body: note,
                          }),
                        });
                        setNote("");
                        await chat(selected);
                      });
                    }}
                  >
                    <input
                      aria-label="Nota interna"
                      placeholder="Compartilhe contexto com a equipe (não enviado ao cliente)"
                      required
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                    <button>Adicionar nota</button>
                  </form>
                </div>
                <p className="muted">
                  Registrar cria uma mensagem pendente. Enviar exige Evolution
                  API configurada; ACCEPTED significa aceitação pelo provedor,
                  não confirmação de leitura.
                </p>
              </section>
            )}
            <section id="team">
              <h2>Equipe conectada</h2>
              <p className="muted">
                Responsáveis e notas internas sincronizados em tempo real.
              </p>
              <div className="team-grid">
                {team.map((t) => (
                  <article className="team-member" key={t.id}>
                    <span className="avatar">
                      {t.name.slice(0, 1).toUpperCase()}
                    </span>
                    <div>
                      <b>{t.name}</b>
                      <p>{t.email}</p>
                      <small>
                        {t.role === "ADMIN" ? "Administrador" : "Atendente"} ·{" "}
                        {t.lastSeenAt &&
                        Date.now() - new Date(t.lastSeenAt).getTime() < 10000
                          ? "Online"
                          : "Offline"}
                      </small>
                    </div>
                  </article>
                ))}
              </div>
              {me?.role === "ADMIN" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void guard(async () => {
                      await request("team", {
                        method: "POST",
                        body: JSON.stringify(member),
                      });
                      setMember({
                        name: "",
                        email: "",
                        password: "",
                        role: "AGENT",
                      });
                      await refresh();
                    });
                  }}
                >
                  <input
                    aria-label="Nome do membro"
                    required
                    placeholder="Nome"
                    value={member.name}
                    onChange={(e) =>
                      setMember({ ...member, name: e.target.value })
                    }
                  />
                  <input
                    aria-label="Email do membro"
                    type="email"
                    required
                    placeholder="Email"
                    value={member.email}
                    onChange={(e) =>
                      setMember({ ...member, email: e.target.value })
                    }
                  />
                  <input
                    aria-label="Senha inicial do membro"
                    type="password"
                    required
                    minLength={12}
                    placeholder="Senha inicial (mín. 12 caracteres)"
                    value={member.password}
                    onChange={(e) =>
                      setMember({ ...member, password: e.target.value })
                    }
                  />
                  <select
                    aria-label="Permissão do membro"
                    value={member.role}
                    onChange={(e) =>
                      setMember({ ...member, role: e.target.value })
                    }
                  >
                    <option value="AGENT">Atendente</option>
                    <option value="ADMIN">Administrador</option>
                  </select>
                  <button>Adicionar membro</button>
                </form>
              )}
            </section>
          </>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <footer>
          As automações de IA exigem testes em ambiente de homologação antes do
          uso em produção com clientes reais.
        </footer>
      </main>
    </>
  );
}
