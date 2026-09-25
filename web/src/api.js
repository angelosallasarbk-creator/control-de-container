const BASE = "/api";

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const corpo = await res.json().catch(() => ({}));
    const erro = new Error(corpo.erro || `Erro ${res.status} em ${path}`);
    erro.status = res.status;
    erro.codigo = corpo.codigo;
    erro.dados = corpo;
    throw erro;
  }
  if (res.status === 204) return null;
  return res.json();
}

const qs = (params = {}) => {
  const limpo = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== "" && v !== null && v !== undefined));
  const s = new URLSearchParams(limpo).toString();
  return s ? `?${s}` : "";
};

export const api = {
  login: (email, senha) => request("/auth/login", { method: "POST", body: { email, senha } }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () => request("/auth/me"),

  painel: () => request("/painel"),

  containers: (params) => request(`/containers${qs(params)}`),
  container: (id) => request(`/containers/${id}`),
  criarContainer: (dados) => request("/containers", { method: "POST", body: dados }),
  editarContainer: (id, dados) => request(`/containers/${id}`, { method: "PATCH", body: dados }),
  avancar: (id, dados) => request(`/containers/${id}/avancar`, { method: "POST", body: dados }),
  desfazer: (id) => request(`/containers/${id}/desfazer`, { method: "POST" }),
  cancelar: (id, motivo) => request(`/containers/${id}/cancelar`, { method: "POST", body: { motivo } }),
  registrarLeitura: (id, dados) => request(`/containers/${id}/leituras`, { method: "POST", body: dados }),

  custos: (params) => request(`/custos${qs(params)}`),

  etiquetas: (params) => request(`/etiquetas${qs(params)}`),
  lotesEtiquetas: () => request("/etiquetas/lotes"),
  gerarEtiquetas: (quantidade) => request("/etiquetas/lotes", { method: "POST", body: { quantidade } }),
  // Uma única requisição para todas as selecionadas (o servidor separa as que podem sair).
  excluirEtiquetas: (ids) => request("/etiquetas/excluir", { method: "POST", body: { ids } }),
  marcarImpressas: (ids) => request("/etiquetas/impressas", { method: "POST", body: { ids } }),
  cancelarEtiqueta: (id, motivo) => request(`/etiquetas/${id}/cancelar`, { method: "POST", body: { motivo } }),
  configImpressao: () => request("/etiquetas/impressao"),
  // ZPL volta como texto (arquivo para a Zebra), não JSON.
  baixarZpl: async (dados) => {
    const res = await fetch(`${BASE}/etiquetas/zpl`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dados),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).erro || `Erro ${res.status}`);
    return res.text();
  },

  qr: (token) => request(`/qr/${token}`),
  qrPorCodigo: (codigo) => request(`/qr/codigo/${encodeURIComponent(codigo.trim())}`),
  qrVincular: (token, dados) => request(`/qr/${token}/vincular`, { method: "POST", body: dados }),
  qrLeitura: (token, dados) => request(`/qr/${token}/leituras`, { method: "POST", body: dados }),

  locais: (params) => request(`/locais${qs(params)}`),
  criarLocal: (dados) => request("/locais", { method: "POST", body: dados }),
  atualizarLocal: (id, dados) => request(`/locais/${id}`, { method: "PATCH", body: dados }),
  excluirLocal: (id) => request(`/locais/${id}`, { method: "DELETE" }),
  geocodificar: (q) => request(`/locais/geocodificar${qs({ q })}`),
  estimarRota: (params) => request(`/rotas/estimar${qs(params)}`),

  alertas: (params) => request(`/alertas${qs(params)}`),
  resumoAlertas: () => request("/alertas/resumo"),
  reconhecerAlerta: (id, acaoTomada) => request(`/alertas/${id}/reconhecer`, { method: "POST", body: { acaoTomada } }),

  // Cadastros genéricos: recurso = grupos | armadores | produtos
  listar: (recurso, params) => request(`/${recurso}${qs(params)}`),
  criar: (recurso, dados) => request(`/${recurso}`, { method: "POST", body: dados }),
  atualizar: (recurso, id, dados) => request(`/${recurso}/${id}`, { method: "PATCH", body: dados }),
  excluir: (recurso, id) => request(`/${recurso}/${id}`, { method: "DELETE" }),

  usuarios: () => request("/usuarios"),
  catalogoPermissoes: () => request("/usuarios/permissoes/catalogo"),
  // permissoes: lista de chaves, ou null para voltar ao padrão do perfil.
  salvarPermissoes: (id, permissoes) => request(`/usuarios/${id}/permissoes`, { method: "PUT", body: { permissoes } }),
  criarUsuario: (dados) => request("/usuarios", { method: "POST", body: dados }),
  atualizarUsuario: (id, dados) => request(`/usuarios/${id}`, { method: "PATCH", body: dados }),

  tokens: () => request("/tokens"),
  criarToken: (nome) => request("/tokens", { method: "POST", body: { nome } }),
  revogarToken: (id) => request(`/tokens/${id}/revogar`, { method: "POST" }),

  configuracao: () => request("/configuracao"),
  salvarConfiguracao: (dados) => request("/configuracao", { method: "PUT", body: dados }),
  logs: (params) => request(`/logs${qs(params)}`),
};
