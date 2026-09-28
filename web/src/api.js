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

// Rotas do QR: as mesmas para a equipe (/qr) e para o motorista (/motorista/qr, sessão própria).
const rotasQr = (prefixo) => ({
  qr: (token) => request(`${prefixo}/${token}`),
  qrVincular: (token, dados) => request(`${prefixo}/${token}/vincular`, { method: "POST", body: dados }),
  qrLeitura: (token, dados) => request(`${prefixo}/${token}/leituras`, { method: "POST", body: dados }),
  // Transportador/motorista: coleta pelo QR (Tipo > Local de retirada; cadastra o container se preciso).
  qrOpcoesColeta: () => request(`${prefixo}/opcoes/coleta`),
  // Programação (trajeto) do container pelo número — preenche a coleta em etiqueta nova.
  qrPassagem: (token, dados) => request(`${prefixo}/${token}/passagem`, { method: "POST", body: dados }),
  qrProgramacao: (numero) => request(`${prefixo}/opcoes/container/${encodeURIComponent(numero)}`),
  qrColeta: (token, dados) => request(`${prefixo}/${token}/coleta`, { method: "POST", body: dados }),
  // Portaria: entrada/saída no ponto de carregamento.
  qrPortaria: (token, dados) => request(`${prefixo}/${token}/portaria`, { method: "POST", body: dados }),
});
export const qrMotorista = rotasQr("/motorista/qr");

async function baixarArquivo(caminho, nome) {
  const res = await fetch(`${BASE}${caminho}`, { credentials: "include" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).erro || `Erro ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: nome });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function enviarArquivo(caminho, arquivo) {
  const res = await fetch(`${BASE}${caminho}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/octet-stream" }, body: arquivo });
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(corpo.erro || (res.status === 413 ? "Arquivo grande demais (máximo 5 MB)." : `Erro ${res.status}`));
  return corpo;
}

const qs = (params = {}) => {
  const limpo = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== "" && v !== null && v !== undefined));
  const s = new URLSearchParams(limpo).toString();
  return s ? `?${s}` : "";
};

export const api = {
  // lembrar = sessão de 30 dias (cookie httpOnly). A senha só trafega nesta requisição (HTTPS).
  login: (email, senha, lembrar = false) => request("/auth/login", { method: "POST", body: { email, senha, lembrar } }),
  logout: () => request("/auth/logout", { method: "POST" }),
  // Esqueci minha senha (link por e-mail, uso único, 30 min).
  esqueciSenha: (email) => request("/auth/esqueci-senha", { method: "POST", body: { email } }),
  conferirRedefinicao: (codigo) => request(`/auth/redefinir-senha/${encodeURIComponent(codigo)}`),
  redefinirSenha: (codigo, senha) => request("/auth/redefinir-senha", { method: "POST", body: { codigo, senha } }),
  enviarRedefinicao: (id) => request(`/usuarios/${id}/enviar-redefinicao`, { method: "POST" }),
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
  rastreamento: (id) => request(`/containers/${id}/rastreamento`),
  // Trajeto com pontos de parada (Editar trajeto) e passagem pelos pontos.
  salvarTrajeto: (id, pontos) => request(`/containers/${id}/trajeto`, { method: "PUT", body: { pontos } }),
  registrarPassagem: (id, paradaId, passouEm) => request(`/containers/${id}/paradas/${paradaId}/passagem`, { method: "POST", body: passouEm ? { passouEm } : {} }),
  desfazerPassagem: (id, paradaId) => request(`/containers/${id}/paradas/${paradaId}/passagem`, { method: "DELETE" }),
  solicitarPosicao: (id) => request(`/containers/${id}/solicitar-posicao`, { method: "POST" }),
  // Cadastro em lote: modelo .xlsx (download) e upload (prévia; confirmar = grava as válidas).
  baixarModeloContainers: async () => {
    const res = await fetch(`${BASE}/containers/modelo`, { credentials: "include" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).erro || `Erro ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: "modelo-containers.xlsx" });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
  importarContainers: async (arquivo, confirmar = false) => {
    const res = await fetch(`${BASE}/containers/importar${confirmar ? "?confirmar=1" : ""}`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/octet-stream" }, body: arquivo,
    });
    const corpo = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(corpo.erro || (res.status === 413 ? "Arquivo grande demais (máximo 5 MB)." : `Erro ${res.status}`));
    return corpo;
  },
  // Link do SMS de rastreamento (público, sem login).
  conferirPedidoPosicao: (codigo) => request(`/posicao/${encodeURIComponent(codigo)}`),
  enviarPosicao: (codigo, dados) => request(`/posicao/${encodeURIComponent(codigo)}`, { method: "POST", body: dados }),

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

  ...rotasQr("/qr"),
  qrPorCodigo: (codigo) => request(`/qr/codigo/${encodeURIComponent(codigo.trim())}`),

  // Motorista (sem usuário): entrar pelo celular com código SMS.
  motoristaPedirCodigo: (celular) => request("/motorista/codigo", { method: "POST", body: { celular } }),
  motoristaVerificar: (celular, codigo) => request("/motorista/verificar", { method: "POST", body: { celular, codigo } }),
  motoristaCadastro: (dados) => request("/motorista/cadastro", { method: "POST", body: dados }),
  motoristaEu: () => request("/motorista/eu"),
  motoristaAtualizar: (dados) => request("/motorista/eu", { method: "PATCH", body: dados }),
  motoristaSair: () => request("/motorista/sair", { method: "POST" }),
  // Gestão dos motoristas (gestor da transportadora / administração).
  motoristas: (params) => request(`/motoristas${qs(params)}`),
  criarMotorista: (dados) => request("/motoristas", { method: "POST", body: dados }),
  atualizarMotorista: (id, dados) => request(`/motoristas/${id}`, { method: "PATCH", body: dados }),
  sessoesMotorista: (id) => request(`/motoristas/${id}/sessoes`),
  encerrarSessoesMotorista: (id) => request(`/motoristas/${id}/encerrar-sessoes`, { method: "POST" }),
  baixarModeloMotoristas: () => baixarArquivo("/motoristas/modelo", "modelo-motoristas.xlsx"),
  importarMotoristas: (arquivo, confirmar = false) => enviarArquivo(`/motoristas/importar${confirmar ? "?confirmar=1" : ""}`, arquivo),

  locais: (params) => request(`/locais${qs(params)}`),
  criarLocal: (dados) => request("/locais", { method: "POST", body: dados }),
  atualizarLocal: (id, dados) => request(`/locais/${id}`, { method: "PATCH", body: dados }),
  excluirLocal: (id) => request(`/locais/${id}`, { method: "DELETE" }),
  tiposLocal: () => request("/tipos-local"),
  criarTipoLocal: (dados) => request("/tipos-local", { method: "POST", body: dados }),
  atualizarTipoLocal: (id, dados) => request(`/tipos-local/${id}`, { method: "PATCH", body: dados }),
  excluirTipoLocal: (id) => request(`/tipos-local/${id}`, { method: "DELETE" }),
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
