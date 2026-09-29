// Permissões por usuário. Cada perfil tem um conjunto PADRÃO; o administrador pode personalizar
// usuário a usuário (Usuario.permissoes = lista de chaves; null = usa o padrão do perfil).
// "administrar" (usuários, permissões, integração, configurações gerais) é exclusivo do perfil
// ADMIN e não pode ser concedido — evita que alguém fique trancado fora ou se autopromova.
import { prisma } from "./prisma.js";
import { comoSistema } from "./tenant.js";

export const CATALOGO_PERMISSOES = [
  { chave: "containers.operar", grupo: "Containers", nome: "Operar containers", descricao: "Cadastrar containers, avançar etapas, editar dados, registrar temperatura na ficha e reconhecer alertas." },
  { chave: "containers.prazos", grupo: "Containers", nome: "Alterar prazos do container", descricao: "Mudar meta de estadia, custo/h, free time e faixa de temperatura de um container específico." },
  { chave: "containers.corrigir", grupo: "Containers", nome: "Desfazer e cancelar etapas", descricao: "Desfazer a última etapa registrada e cancelar containers." },
  { chave: "cadastros.editar", grupo: "Cadastros", nome: "Editar cadastros", descricao: "Regiões, Ponto de Carregamento, Armadores, Produtos, Locais e Tipos de local (inclusive busca de endereço)." },
  { chave: "etiquetas.emitir", grupo: "Etiquetas QR", nome: "Gerar e imprimir etiquetas", descricao: "Gerar lotes de etiquetas QR e imprimir (navegador/ZPL) as etiquetas que a própria pessoa gerou." },
  { chave: "etiquetas.cancelar", grupo: "Etiquetas QR", nome: "Cancelar e excluir etiquetas", descricao: "Inutilizar (cancelar) etiquetas QR que a própria pessoa gerou e excluir as que nunca foram usadas (sem container e sem leituras)." },
  { chave: "qr.registrar", grupo: "Etiquetas QR", nome: "Registrar leituras pelo celular", descricao: "Ligar etiqueta a container e registrar temperatura lendo o QR ou digitando o código." },
  { chave: "auditoria.ver", grupo: "Administração", nome: "Ver log de auditoria", descricao: "Consultar o histórico de alterações feitas no sistema." },
];
export const CHAVES = CATALOGO_PERMISSOES.map((p) => p.chave);

export const PADRAO_POR_PERFIL = {
  ADMIN: CHAVES,
  SUPERVISOR: CHAVES,
  OPERADOR: ["containers.operar", "qr.registrar"],
  VISUALIZACAO: [],
  TRANSPORTADOR: ["qr.registrar"],
  PORTARIA: ["qr.registrar"],
  GESTOR_TRANSPORTADORA: [],
};

// Perfis de campo usam só parte do sistema; o resto da API fica fechado para eles.
// - Transportador: só as telas do QR (celular).
// - Portaria: telas do QR + consulta do Pátio (e o resumo de alertas que o Pátio mostra).
// - Gestor da transportadora: só a gestão dos motoristas da própria transportadora.
// `escrita` = onde o perfil pode gravar (fora dali, só consulta).
const API_DO_PERFIL = {
  TRANSPORTADOR: { rotas: ["/qr/"], escrita: ["/qr/"], mensagem: "O perfil Transportador acessa apenas a leitura das etiquetas QR." },
  PORTARIA: { rotas: ["/qr/", "/painel", "/alertas/resumo"], escrita: ["/qr/"], mensagem: "O perfil Portaria acessa apenas a leitura das etiquetas QR e a consulta do Pátio." },
  GESTOR_TRANSPORTADORA: { rotas: ["/motoristas"], escrita: ["/motoristas"], mensagem: "O perfil Gestor da transportadora acessa apenas a gestão dos motoristas." },
};
export const ehGestorTransportadora = (req) => req.usuario?.perfil === "GESTOR_TRANSPORTADORA";
export const ehTransportador = (req) => req.usuario?.perfil === "TRANSPORTADOR";
export const ehPortaria = (req) => req.usuario?.perfil === "PORTARIA";
export function restringirPerfisDeCampo(req, res, next) {
  const regra = API_DO_PERFIL[req.usuario?.perfil];
  if (regra && !regra.rotas.some((r) => req.path === r || req.path.startsWith(r.endsWith("/") ? r : `${r}/`))) {
    return res.status(403).json({ erro: regra.mensagem });
  }
  // Fora das rotas de escrita do perfil (ex.: consulta do Pátio), só leitura.
  if (regra && req.method !== "GET" && !regra.escrita.some((r) => req.path.startsWith(r))) return res.status(403).json({ erro: regra.mensagem });
  next();
}

// Lista final de permissões do usuário (+ "administrar" para ADMIN).
export function permissoesEfetivas(usuario) {
  if (usuario.perfil === "ADMIN") return [...CHAVES, "administrar"];
  const lista = Array.isArray(usuario.permissoes) ? usuario.permissoes : PADRAO_POR_PERFIL[usuario.perfil] ?? [];
  return CHAVES.filter((c) => lista.includes(c));
}

export const ehPersonalizado = (usuario) => usuario.perfil !== "ADMIN" && Array.isArray(usuario.permissoes);

/**
 * Middleware (depois do requireAuth): relê o usuário no banco a CADA requisição, para que
 * desativar a conta, trocar o perfil ou mudar permissões valha na hora — sem esperar a sessão
 * (JWT de 12h) expirar. Atualiza req.usuario.perfil e preenche req.permissoes.
 */
export async function carregarUsuarioAtual(req, res, next) {
  try {
    // Busca pelo e-mail (único na plataforma) antes de saber a organização: modo sistema.
    const u = await comoSistema(() => prisma.usuario.findUnique({ where: { email: req.usuario.email }, include: { organizacao: { select: { nome: true, ativo: true } } } }));
    if (!u || !u.ativo) return res.status(401).json({ erro: "Conta desativada ou inexistente. Fale com um administrador." });
    if (u.organizacao && !u.organizacao.ativo) return res.status(401).json({ erro: `A organização ${u.organizacao.nome} está desativada. Fale com o administrador da plataforma.` });
    // Sessão emitida antes da última troca de senha (versão diferente) não vale mais.
    if ((req.usuario.sv ?? 0) !== (u.sessoesValidasApos?.getTime() ?? 0)) {
      return res.status(401).json({ erro: "Sua senha foi alterada. Entre novamente." });
    }
    req.usuario = { ...req.usuario, id: u.id, nome: u.nome, perfil: u.perfil, transportadoraId: u.transportadoraId, organizacaoId: u.organizacaoId, organizacaoNome: u.organizacao?.nome ?? null };
    req.permissoes = permissoesEfetivas(u);
    next();
  } catch (err) {
    next(err);
  }
}

export const tem = (req, chave) => Boolean(req.permissoes?.includes(chave));

export function requirePermissao(chave) {
  return (req, res, next) => {
    if (!tem(req, chave)) {
      const p = CATALOGO_PERMISSOES.find((x) => x.chave === chave);
      return res.status(403).json({
        erro: chave === "administrar"
          ? "Só um administrador pode fazer isso."
          : `Seu usuário não tem a permissão "${p?.nome ?? chave}". Peça a um administrador (Configurações → Perfis e permissões).`,
      });
    }
    next();
  };
}
