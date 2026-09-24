import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { requireRole, PERMISSOES } from "../lib/auth.js";
import { registrarLog } from "../lib/auditoria.js";
import { decimaisParaNumero } from "../lib/containerView.js";
import { texto, inteiro, decimal, id as validarId } from "../lib/validacao.js";

// Cadastros de apoio (Cliente/Fábrica, Armadores, Produtos) com o mesmo CRUD.
// Não há exclusão física de registro já usado por container: desativa-se (ativo = false).

const CADASTROS = {
  grupos: {
    modelo: "grupoOperacao",
    entidade: "GrupoOperacao",
    rotulo: (r) => `${r.cliente} / ${r.fabrica}`,
    ordem: [{ cliente: "asc" }, { fabrica: "asc" }],
    validar: (b, parcial) => {
      const d = {};
      if (!parcial || "cliente" in b) d.cliente = texto(b.cliente, "Cliente", { obrigatorio: true, max: 120 });
      if (!parcial || "fabrica" in b) d.fabrica = texto(b.fabrica, "Fábrica", { obrigatorio: true, max: 120 });
      if (!parcial || "metaEstadiaHoras" in b)
        d.metaEstadiaHoras = inteiro(b.metaEstadiaHoras, "Meta de estadia (h)", { obrigatorio: true, min: 1, max: 2000 });
      if (!parcial || "alertaEstadiaHoras" in b)
        d.alertaEstadiaHoras = inteiro(b.alertaEstadiaHoras ?? 6, "Antecedência do alerta (h)", { obrigatorio: true, min: 0, max: 2000 });
      if ("custoEstadiaPorHora" in b) d.custoEstadiaPorHora = decimal(b.custoEstadiaPorHora, "Custo por hora excedida", { min: 0 });
      if ("ativo" in b) d.ativo = Boolean(b.ativo);
      return d;
    },
  },
  armadores: {
    modelo: "armador",
    entidade: "Armador",
    rotulo: (r) => r.nome,
    ordem: [{ nome: "asc" }],
    validar: (b, parcial) => {
      const d = {};
      if (!parcial || "nome" in b) d.nome = texto(b.nome, "Nome", { obrigatorio: true, max: 120 });
      if (!parcial || "freeTimeDias" in b) d.freeTimeDias = inteiro(b.freeTimeDias, "Free time (dias)", { obrigatorio: true, min: 0, max: 365 });
      if (!parcial || "valorDiaria" in b) d.valorDiaria = decimal(b.valorDiaria, "Valor da diária", { obrigatorio: true, min: 0 });
      if ("moeda" in b) d.moeda = (texto(b.moeda, "Moeda", { max: 3 }) ?? "USD").toUpperCase();
      if (!parcial || "alertaDemurrageDias" in b)
        d.alertaDemurrageDias = inteiro(b.alertaDemurrageDias ?? 2, "Antecedência do alerta (dias)", { obrigatorio: true, min: 0, max: 365 });
      if ("ativo" in b) d.ativo = Boolean(b.ativo);
      return d;
    },
  },
  produtos: {
    modelo: "produto",
    entidade: "Produto",
    rotulo: (r) => r.nome,
    ordem: [{ nome: "asc" }],
    validar: (b, parcial) => {
      const d = {};
      if (!parcial || "nome" in b) d.nome = texto(b.nome, "Nome", { obrigatorio: true, max: 120 });
      for (const [campo, rotulo] of [["setpoint", "Setpoint"], ["tempMin", "Temperatura mínima"], ["tempMax", "Temperatura máxima"]]) {
        if (!parcial || campo in b) d[campo] = decimal(b[campo], rotulo, { obrigatorio: true, min: -60, max: 60 });
      }
      if (!parcial || "toleranciaMinutos" in b)
        d.toleranciaMinutos = inteiro(b.toleranciaMinutos ?? 30, "Tolerância (min)", { obrigatorio: true, min: 0, max: 1440 });
      if ("ativo" in b) d.ativo = Boolean(b.ativo);
      return d;
    },
    validarConjunto: (r) => {
      if (Number(r.tempMin) > Number(r.tempMax)) throw erroHttp(400, "A temperatura mínima não pode ser maior que a máxima.");
      if (Number(r.setpoint) < Number(r.tempMin) || Number(r.setpoint) > Number(r.tempMax))
        throw erroHttp(400, "O setpoint precisa estar dentro da faixa mínima–máxima.");
    },
  },
};

export const cadastrosRouter = Router();

function traduzirErroUnico(err) {
  if (err.code === "P2002") throw erroHttp(409, "Já existe um cadastro com esse nome.");
  throw err;
}

for (const [rota, cfg] of Object.entries(CADASTROS)) {
  const repo = () => prisma[cfg.modelo];

  cadastrosRouter.get(`/${rota}`, asyncHandler(async (req, res) => {
    const where = req.query.ativos === "1" ? { ativo: true } : {};
    const registros = await repo().findMany({ where, orderBy: cfg.ordem, include: { _count: { select: { containers: true } } } });
    res.json(registros.map((r) => decimaisParaNumero(r)));
  }));

  cadastrosRouter.post(`/${rota}`, requireRole(...PERMISSOES.cadastros), asyncHandler(async (req, res) => {
    const dados = cfg.validar(req.body ?? {}, false);
    cfg.validarConjunto?.(dados);
    const criado = await repo().create({ data: dados }).catch(traduzirErroUnico);
    await registrarLog({
      usuarioEmail: req.usuario.email,
      acao: "CRIAR",
      entidade: cfg.entidade,
      entidadeId: criado.id,
      descricao: `Cadastro criado: ${cfg.rotulo(criado)}`,
      dadosDepois: criado,
    });
    res.status(201).json(decimaisParaNumero(criado));
  }));

  cadastrosRouter.patch(`/${rota}/:id`, requireRole(...PERMISSOES.cadastros), asyncHandler(async (req, res) => {
    const registroId = validarId(req.params.id);
    const antes = await repo().findUnique({ where: { id: registroId } });
    if (!antes) throw erroHttp(404, "Cadastro não encontrado.");
    const dados = cfg.validar(req.body ?? {}, true);
    cfg.validarConjunto?.({ ...antes, ...dados });
    const depois = await repo().update({ where: { id: registroId }, data: dados }).catch(traduzirErroUnico);
    await registrarLog({
      usuarioEmail: req.usuario.email,
      acao: "ALTERAR",
      entidade: cfg.entidade,
      entidadeId: registroId,
      descricao: `Cadastro alterado: ${cfg.rotulo(depois)} (containers já em andamento mantêm os prazos antigos)`,
      dadosAntes: antes,
      dadosDepois: depois,
    });
    res.json(decimaisParaNumero(depois));
  }));

  cadastrosRouter.delete(`/${rota}/:id`, requireRole(...PERMISSOES.cadastros), asyncHandler(async (req, res) => {
    const registroId = validarId(req.params.id);
    const antes = await repo().findUnique({ where: { id: registroId }, include: { _count: { select: { containers: true } } } });
    if (!antes) throw erroHttp(404, "Cadastro não encontrado.");
    if (antes._count.containers > 0) {
      throw erroHttp(409, "Este cadastro já foi usado em containers. Desative-o em vez de excluir, para preservar o histórico.");
    }
    await repo().delete({ where: { id: registroId } });
    await registrarLog({
      usuarioEmail: req.usuario.email,
      acao: "EXCLUIR",
      entidade: cfg.entidade,
      entidadeId: registroId,
      descricao: `Cadastro excluído: ${cfg.rotulo(antes)}`,
      dadosAntes: antes,
    });
    res.status(204).end();
  }));
}
