// Cadastro de Tipos de Operação (menu "Tipo de Operação"): nome, fluxo de etapas com o tipo de
// local e o local sugerido de cada uma, e as etapas que abrem/fecham o free time.
// Mudar um tipo não altera containers já criados (cada um guarda a cópia do fluxo).
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { requirePermissao } from "../lib/permissoes.js";
import { registrarLog } from "../lib/auditoria.js";
import { texto, id as validarId, umDe } from "../lib/validacao.js";
import { validarEtapasFluxo, STATUS_DA_ACAO, ROTULO_ACAO, motivoLocalForaDaRegra } from "../lib/fluxo.js";

export const tiposOperacaoRouter = Router();

// Etapas que ficam no local de operação: o local é o mesmo da chegada (não tem tipo próprio).
const NO_LOCAL_DA_CHEGADA = ["INICIO_OPERACAO", "LIBERACAO", "SAIDA"];

const INCLUDE = {
  etapas: {
    orderBy: { ordem: "asc" },
    include: { tipoLocal: { select: { id: true, nome: true } }, localSugerido: { select: { id: true, nome: true } } },
  },
  _count: { select: { containers: true } },
};
const serializar = ({ _count, ...t }) => ({ ...t, containers: _count?.containers ?? 0 });
const erroNomeRepetido = (err) => {
  if (err.code === "P2002") throw erroHttp(409, "Já existe um tipo de operação com esse nome.");
  throw err;
};

// Confere tipos de local e locais sugeridos das etapas (existem e combinam com a regra da etapa).
async function conferirLocais(etapas) {
  const idsTipo = etapas.map((e) => e.tipoLocalId).filter(Boolean);
  const idsLocal = etapas.map((e) => e.localSugeridoId).filter(Boolean);
  const [tipos, locais, gruposParada] = await Promise.all([
    prisma.tipoLocal.findMany({ where: { id: { in: idsTipo } } }),
    prisma.local.findMany({ where: { id: { in: idsLocal } }, include: { tipo: true } }),
    prisma.grupoOperacao.findMany({ where: { podeSerParada: true, ativo: true, localId: { in: idsLocal } }, select: { localId: true } }),
  ]);
  const tipoPorId = new Map(tipos.map((t) => [t.id, t]));
  const localPorId = new Map(locais.map((l) => [l.id, l]));
  const servemDeParada = new Set(gruposParada.map((g) => g.localId));
  etapas.forEach((e, i) => {
    const rotulo = `Etapa ${i + 1} (${e.nome || ROTULO_ACAO[e.acao]})`;
    if (NO_LOCAL_DA_CHEGADA.includes(e.acao)) {
      Object.assign(e, { funcaoLocal: null, tipoLocalId: null, localSugeridoId: null });
      return;
    }
    if (e.acao === "PASSAGEM") e.funcaoLocal = "PARADA";
    if (e.tipoLocalId) {
      const tipo = tipoPorId.get(e.tipoLocalId);
      if (!tipo) throw erroHttp(400, `${rotulo}: tipo de local não encontrado.`);
      e.funcaoLocal = tipo.funcao; // o tipo específico define a função
    }
    if (e.localSugeridoId) {
      const local = localPorId.get(e.localSugeridoId);
      if (!local) throw erroHttp(400, `${rotulo}: local sugerido não encontrado.`);
      if (!local.ativo) throw erroHttp(400, `${rotulo}: o local "${local.nome}" está inativo.`);
      if (e.acao === "PASSAGEM") {
        if (local.tipo.funcao !== "PARADA" && !servemDeParada.has(local.id)) throw erroHttp(400, `${rotulo}: "${local.nome}" não é ponto de parada.`);
      } else {
        const motivo = motivoLocalForaDaRegra(local, { funcao: e.funcaoLocal, tipoLocalId: e.tipoLocalId }, tipoPorId.get(e.tipoLocalId)?.nome);
        if (motivo) throw erroHttp(400, `${rotulo}: ${motivo}.`);
      }
    }
  });
  return etapas;
}

async function validar(b, antes = null) {
  const d = {};
  if (!antes || "nome" in b) d.nome = texto(b.nome, "Nome do tipo de operação", { obrigatorio: true, max: 60 });
  if (!antes || "descricao" in b) d.descricao = texto(b.descricao, "Descrição", { max: 300 });
  if ("ativo" in b) d.ativo = Boolean(b.ativo);
  if ("padrao" in b) d.padrao = Boolean(b.padrao);
  let etapas = null;
  if (!antes || "etapas" in b) etapas = await conferirLocais(validarEtapasFluxo(b.etapas));
  // Free time: etapas que existem no fluxo, início antes do fim.
  const statusDoFluxo = (etapas ?? antes.etapas).filter((e) => e.acao !== "PASSAGEM").map((e) => STATUS_DA_ACAO[e.acao]);
  const inicio = "freeTimeInicio" in b ? b.freeTimeInicio : antes?.freeTimeInicio ?? "COLETADO";
  const fim = "freeTimeFim" in b ? b.freeTimeFim : antes?.freeTimeFim ?? "ENTREGUE_PORTO";
  d.freeTimeInicio = umDe(inicio, statusDoFluxo, "Início do free time (etapa do fluxo)", { obrigatorio: true });
  d.freeTimeFim = umDe(fim, statusDoFluxo, "Fim do free time (etapa do fluxo)", { obrigatorio: true });
  if (statusDoFluxo.indexOf(d.freeTimeInicio) >= statusDoFluxo.indexOf(d.freeTimeFim)) throw erroHttp(400, "O free time precisa começar numa etapa anterior à do fim.");
  return { dados: d, etapas };
}

const gravarEtapas = (tx, tipoOperacaoId, etapas) =>
  tx.etapaFluxo.createMany({ data: etapas.map((e, i) => ({ tipoOperacaoId, ordem: i + 1, ...e })) });

tiposOperacaoRouter.get("/", asyncHandler(async (req, res) => {
  const where = req.query.ativos === "1" ? { ativo: true } : {};
  const tipos = await prisma.tipoOperacao.findMany({ where, orderBy: [{ padrao: "desc" }, { nome: "asc" }], include: INCLUDE });
  res.json(tipos.map(serializar));
}));

tiposOperacaoRouter.post("/", requirePermissao("cadastros.editar"), asyncHandler(async (req, res) => {
  const { dados, etapas } = await validar(req.body ?? {});
  if (dados.padrao && dados.ativo === false) throw erroHttp(400, "O tipo padrão precisa estar ativo.");
  const criado = await prisma.$transaction(async (tx) => {
    if (dados.padrao) await tx.tipoOperacao.updateMany({ where: { padrao: true }, data: { padrao: false } });
    const t = await tx.tipoOperacao.create({ data: dados }).catch(erroNomeRepetido);
    await gravarEtapas(tx, t.id, etapas);
    const completo = await tx.tipoOperacao.findUnique({ where: { id: t.id }, include: INCLUDE });
    await registrarLog({ usuarioEmail: req.usuario.email, acao: "CRIAR", entidade: "TipoOperacao", entidadeId: t.id, descricao: `Tipo de operação criado: ${t.nome} (${etapas.length} etapas)`, dadosDepois: completo }, tx);
    return completo;
  });
  res.status(201).json(serializar(criado));
}));

tiposOperacaoRouter.patch("/:id", requirePermissao("cadastros.editar"), asyncHandler(async (req, res) => {
  const tipoId = validarId(req.params.id);
  const antes = await prisma.tipoOperacao.findUnique({ where: { id: tipoId }, include: INCLUDE });
  if (!antes) throw erroHttp(404, "Tipo de operação não encontrado.");
  const { dados, etapas } = await validar(req.body ?? {}, antes);
  if (antes.padrao && dados.padrao === false) throw erroHttp(409, "Para trocar o tipo padrão, marque outro tipo como padrão.");
  if ((antes.padrao || dados.padrao) && dados.ativo === false) throw erroHttp(409, "O tipo padrão não pode ser desativado. Marque outro tipo como padrão antes.");
  const depois = await prisma.$transaction(async (tx) => {
    if (dados.padrao && !antes.padrao) await tx.tipoOperacao.updateMany({ where: { padrao: true }, data: { padrao: false } });
    await tx.tipoOperacao.update({ where: { id: tipoId }, data: dados }).catch(erroNomeRepetido);
    if (etapas) {
      await tx.etapaFluxo.deleteMany({ where: { tipoOperacaoId: tipoId } });
      await gravarEtapas(tx, tipoId, etapas);
    }
    const completo = await tx.tipoOperacao.findUnique({ where: { id: tipoId }, include: INCLUDE });
    await registrarLog({
      usuarioEmail: req.usuario.email, acao: "ALTERAR", entidade: "TipoOperacao", entidadeId: tipoId,
      descricao: `Tipo de operação alterado: ${completo.nome}${etapas ? " (fluxo alterado — vale para containers novos)" : ""}`,
      dadosAntes: antes, dadosDepois: completo,
    }, tx);
    return completo;
  });
  res.json(serializar(depois));
}));

tiposOperacaoRouter.delete("/:id", requirePermissao("cadastros.editar"), asyncHandler(async (req, res) => {
  const tipoId = validarId(req.params.id);
  const antes = await prisma.tipoOperacao.findUnique({ where: { id: tipoId }, include: INCLUDE });
  if (!antes) throw erroHttp(404, "Tipo de operação não encontrado.");
  if (antes.padrao) throw erroHttp(409, "O tipo padrão não pode ser excluído.");
  if (antes._count.containers > 0) throw erroHttp(409, `Há ${antes._count.containers} container(s) deste tipo. Desative o tipo em vez de excluir.`);
  await prisma.tipoOperacao.delete({ where: { id: tipoId } });
  await registrarLog({ usuarioEmail: req.usuario.email, acao: "EXCLUIR", entidade: "TipoOperacao", entidadeId: tipoId, descricao: `Tipo de operação excluído: ${antes.nome}`, dadosAntes: antes });
  res.status(204).end();
}));
