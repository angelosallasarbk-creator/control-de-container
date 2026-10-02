// Organizações (clientes da plataforma) — criação, cadastros padrão e rotinas por organização (v3.0).
import bcrypt from "bcryptjs";
import { prisma } from "./prisma.js";
import { comOrganizacao, comoSistema } from "./tenant.js";
import { erroHttp } from "./asyncHandler.js";
import { registrarLog } from "./auditoria.js";

/**
 * Roda fn dentro de cada organização ativa, uma por vez. Falha de uma não impede as outras.
 * incluirInativas: também as desativadas (retenção LGPD — o prazo vale para elas também; v3.3).
 */
export async function paraCadaOrganizacao(fn, rotulo = "rotina", { incluirInativas = false } = {}) {
  const orgs = await prisma.organizacao.findMany({ where: incluirInativas ? {} : { ativo: true }, select: { id: true, nome: true }, orderBy: { id: "asc" } });
  const resultados = [];
  for (const org of orgs) {
    try {
      resultados.push(await comOrganizacao(org.id, () => fn(org)));
    } catch (err) {
      console.error(`${rotulo}: falha na organização ${org.nome}:`, err);
    }
  }
  return resultados;
}

/**
 * Portas de entrada SEM usuário (motorista pelo QR, token de integração, link do SMS) recebem a
 * organização de um código. Organização desativada não recebe mais dados: 403 (v3.2, item 4).
 */
export async function exigirOrganizacaoAtiva(organizacaoId) {
  const org = await comoSistema(() => prisma.organizacao.findUnique({ where: { id: organizacaoId }, select: { ativo: true } }));
  if (!org?.ativo) throw erroHttp(403, "Este cliente está desativado na plataforma. Fale com o responsável.");
}

/** Motorista bloqueado POR ESTE cliente (v3.2, item 2) — o da transportadora fica em Motorista.bloqueado. */
export async function motoristaBloqueadoNaOrganizacao(motoristaId, organizacaoId) {
  if (!motoristaId || !organizacaoId) return false;
  const v = await prisma.motoristaOrganizacao.findUnique({
    where: { motoristaId_organizacaoId: { motoristaId, organizacaoId } }, select: { bloqueado: true },
  });
  return Boolean(v?.bloqueado);
}

// Cadastros com que toda organização nova começa (os mesmos que a AS TECH LOG recebeu nas migrações).
const TIPOS_LOCAL_PADRAO = [
  { nome: "Fábrica", funcao: "CARREGAMENTO", rotuloChegada: "Chegada na fábrica", rotuloSaida: "Saída da fábrica" },
  { nome: "Armazém", funcao: "CARREGAMENTO", rotuloChegada: "Chegada no armazém", rotuloSaida: "Saída do armazém" },
  { nome: "Porto / Terminal", funcao: "RETIRADA_ENTREGA", rotuloColeta: "Coleta no porto", rotuloEntrega: "Entrega no porto" },
  { nome: "Terminal Ferroviário", funcao: "RETIRADA_ENTREGA", rotuloColeta: "Coleta ferroviária", rotuloEntrega: "Entrega no terminal ferroviário" },
  { nome: "Ponto Fiscal", funcao: "PARADA" },
];
const TIPOS_OPERACAO_PADRAO = [
  {
    nome: "Exportação padrão", padrao: true, descricao: "Retira o vazio no porto, ova no ponto de carregamento e entrega o cheio no porto.",
    etapas: [["COLETA", null, "RETIRADA_ENTREGA"], ["CHEGADA", null, "CARREGAMENTO"], ["INICIO_OPERACAO"], ["LIBERACAO"], ["SAIDA"], ["ENTREGA", null, "RETIRADA_ENTREGA"]],
  },
  {
    nome: "Coleta de cheio", descricao: "Coleta o container já carregado na fábrica/armazém e entrega no destino.",
    etapas: [["COLETA", "Coleta do cheio", "CARREGAMENTO"], ["ENTREGA", "Entrega do cheio", "RETIRADA_ENTREGA"]],
  },
  {
    nome: "Importação", descricao: "Retira o cheio no porto, desova no cliente e devolve o vazio.",
    etapas: [["COLETA", "Retirada do cheio", "RETIRADA_ENTREGA"], ["CHEGADA", "Chegada no cliente", "CARREGAMENTO"], ["INICIO_OPERACAO", "Em desova"], ["LIBERACAO", "Desova concluída"], ["SAIDA", "Saída do cliente"], ["ENTREGA", "Devolução do vazio", "RETIRADA_ENTREGA"]],
  },
  { nome: "Transferência", descricao: "Leva o container de um local a outro, com paradas se necessário.", etapas: [["COLETA"], ["ENTREGA"]] },
];

/** Cria os cadastros padrão (tipos de local e de operação) de uma organização nova. */
export async function semearOrganizacao(tx, organizacaoId) {
  await tx.tipoLocal.createMany({ data: TIPOS_LOCAL_PADRAO.map((t) => ({ ...t, organizacaoId })) });
  for (const { etapas, ...tipo } of TIPOS_OPERACAO_PADRAO) {
    const t = await tx.tipoOperacao.create({ data: { ...tipo, organizacaoId } });
    await tx.etapaFluxo.createMany({
      data: etapas.map(([acao, nome = null, funcaoLocal = null], i) => ({ organizacaoId, tipoOperacaoId: t.id, ordem: i + 1, acao, nome, funcaoLocal })),
    });
  }
}

/**
 * Cria uma organização com os cadastros padrão e o primeiro administrador (admin da plataforma).
 * Tudo numa transação: ou nasce completa, ou nada fica gravado.
 */
export async function criarOrganizacao({ nome, admin, criadoPor }) {
  const senhaHash = await bcrypt.hash(admin.senha, 10);
  return comoSistema(() =>
    prisma.$transaction(async (tx) => {
      const org = await tx.organizacao.create({ data: { nome, criadoPor } }).catch((err) => {
        if (err.code === "P2002") throw erroHttp(409, "Já existe uma organização com esse nome.");
        throw err;
      });
      await semearOrganizacao(tx, org.id);
      const usuario = await tx.usuario.create({ data: { organizacaoId: org.id, email: admin.email, nome: admin.nome, perfil: "ADMIN", senhaHash } }).catch((err) => {
        if (err.code === "P2002") throw erroHttp(409, "Esse e-mail já é usado por outra conta na plataforma.");
        throw err;
      });
      await registrarLog({ organizacaoId: org.id, usuarioEmail: criadoPor, acao: "CRIAR", entidade: "Organizacao", entidadeId: org.id, descricao: `Organização criada: ${nome} (administrador ${admin.email})` }, tx);
      return { org, usuario };
    })
  );
}

/**
 * Motorista (cadastro único na plataforma) passa a ser visível para a organização — e a
 * transportadora dele também. Chamado quando ele registra algo pelo QR daquele cliente ou quando
 * o cliente o cadastra. Idempotente.
 */
export async function vincularMotorista(motoristaId, organizacaoId, cliente = prisma) {
  if (!motoristaId || !organizacaoId) return;
  const m = await cliente.motorista.findUnique({ where: { id: motoristaId }, select: { transportadoraId: true } });
  if (!m) return;
  await cliente.motoristaOrganizacao.upsert({
    where: { motoristaId_organizacaoId: { motoristaId, organizacaoId } }, create: { motoristaId, organizacaoId }, update: {},
  });
  await cliente.transportadoraOrganizacao.upsert({
    where: { transportadoraId_organizacaoId: { transportadoraId: m.transportadoraId, organizacaoId } }, create: { transportadoraId: m.transportadoraId, organizacaoId }, update: {},
  });
}
