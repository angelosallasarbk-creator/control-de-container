// Permissões por usuário. Cada perfil tem um conjunto PADRÃO; o administrador pode personalizar
// usuário a usuário (Usuario.permissoes = lista de chaves; null = usa o padrão do perfil).
// "administrar" (usuários, permissões, integração, configurações gerais) é exclusivo do perfil
// ADMIN e não pode ser concedido — evita que alguém fique trancado fora ou se autopromova.
import { prisma } from "./prisma.js";

export const CATALOGO_PERMISSOES = [
  { chave: "containers.operar", grupo: "Containers", nome: "Operar containers", descricao: "Cadastrar containers, avançar etapas, editar dados, registrar temperatura na ficha e reconhecer alertas." },
  { chave: "containers.prazos", grupo: "Containers", nome: "Alterar prazos do container", descricao: "Mudar meta de estadia, custo/h, free time e faixa de temperatura de um container específico." },
  { chave: "containers.corrigir", grupo: "Containers", nome: "Desfazer e cancelar etapas", descricao: "Desfazer a última etapa registrada e cancelar containers." },
  { chave: "cadastros.editar", grupo: "Cadastros", nome: "Editar cadastros", descricao: "Regiões, Cliente/Fábrica, Armadores, Produtos e Locais (inclusive busca de endereço)." },
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
};

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
    const u = await prisma.usuario.findUnique({ where: { email: req.usuario.email } });
    if (!u || !u.ativo) return res.status(401).json({ erro: "Conta desativada ou inexistente. Fale com um administrador." });
    req.usuario = { ...req.usuario, id: u.id, nome: u.nome, perfil: u.perfil };
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
