import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { requireRole, PERMISSOES } from "../lib/auth.js";
import { registrarLog } from "../lib/auditoria.js";
import { decimaisParaNumero } from "../lib/containerView.js";
import { texto, inteiro, decimal, id as validarId } from "../lib/validacao.js";

// Cadastros de apoio (Regiões, Cliente/Fábrica, Armadores, Produtos) com o mesmo CRUD.
// Registro já usado não é excluído fisicamente: desativa-se (ativo = false).
// `uso` = relação que conta onde o registro é usado (bloqueia exclusão).

// A região pertence à FÁBRICA, mas a fábrica é um texto dentro de Cliente/Fábrica. Para uma
// fábrica nunca ficar dividida entre duas abas do Pátio:
// - sem região informada, o grupo herda a região dos outros clientes da mesma fábrica;
// - com região informada, ela é aplicada a todos os clientes daquela fábrica.
async function sincronizarRegiaoDaFabrica(tx, dados, corpo, antes) {
  const fabrica = dados.fabrica ?? antes?.fabrica;
  const outros = await tx.grupoOperacao.findMany({
    where: { fabrica: { equals: fabrica, mode: "insensitive" }, ...(antes ? { id: { not: antes.id } } : {}) },
    select: { id: true, regiaoId: true },
  });

  if ("regiaoId" in corpo) {
    if (dados.regiaoId) {
      const regiao = await tx.regiao.findUnique({ where: { id: dados.regiaoId } });
      if (!regiao) throw erroHttp(400, "Região não encontrada.");
      if (!regiao.ativo && regiao.id !== antes?.regiaoId) throw erroHttp(400, `A região "${regiao.nome}" está inativa.`);
    }
    const aAtualizar = outros.filter((o) => o.regiaoId !== dados.regiaoId).map((o) => o.id);
    return async () => {
      if (aAtualizar.length) {
        await tx.grupoOperacao.updateMany({ where: { id: { in: aAtualizar } }, data: { regiaoId: dados.regiaoId } });
      }
      return aAtualizar.length;
    };
  }

  // Região não informada: herda da fábrica (criação, ou renomeação para outra fábrica).
  if (outros.length && (!antes || dados.fabrica !== undefined)) {
    dados.regiaoId = outros[0].regiaoId;
  }
  return async () => 0;
}

const CADASTROS = {
  regioes: {
    modelo: "regiao",
    entidade: "Regiao",
    uso: "grupos",
    rotulo: (r) => r.nome,
    ordem: [{ nome: "asc" }],
    validar: (b, parcial) => {
      const d = {};
      if (!parcial || "nome" in b) d.nome = texto(b.nome, "Nome da região", { obrigatorio: true, max: 80 });
      if ("ativo" in b) d.ativo = Boolean(b.ativo);
      return d;
    },
  },
  grupos: {
    modelo: "grupoOperacao",
    entidade: "GrupoOperacao",
    uso: "containers",
    incluir: { regiao: { select: { id: true, nome: true } } },
    rotulo: (r) => `${r.cliente} / ${r.fabrica}`,
    ordem: [{ cliente: "asc" }, { fabrica: "asc" }],
    validar: (b, parcial) => {
      const d = {};
      if (!parcial || "cliente" in b) d.cliente = texto(b.cliente, "Cliente", { obrigatorio: true, max: 120 });
      if (!parcial || "fabrica" in b) d.fabrica = texto(b.fabrica, "Fábrica", { obrigatorio: true, max: 120 });
      if ("regiaoId" in b) d.regiaoId = b.regiaoId === null || b.regiaoId === "" ? null : validarId(b.regiaoId, "Região");
      if (!parcial || "metaEstadiaHoras" in b)
        d.metaEstadiaHoras = inteiro(b.metaEstadiaHoras, "Meta de estadia (h)", { obrigatorio: true, min: 1, max: 2000 });
      if (!parcial || "alertaEstadiaHoras" in b)
        d.alertaEstadiaHoras = inteiro(b.alertaEstadiaHoras ?? 6, "Antecedência do alerta (h)", { obrigatorio: true, min: 0, max: 2000 });
      if ("custoEstadiaPorHora" in b) d.custoEstadiaPorHora = decimal(b.custoEstadiaPorHora, "Custo por hora excedida", { min: 0 });
      if ("ativo" in b) d.ativo = Boolean(b.ativo);
      return d;
    },
    antesDeSalvar: sincronizarRegiaoDaFabrica,
  },
  armadores: {
    modelo: "armador",
    entidade: "Armador",
    uso: "containers",
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
    uso: "containers",
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
  const repo = (cliente = prisma) => cliente[cfg.modelo];
  const include = { ...cfg.incluir, _count: { select: { [cfg.uso]: true } } };
  // `emUso` = quantos registros dependem deste (containers, ou fábricas no caso de região).
  const serializar = ({ _count, ...r }) => ({ ...decimaisParaNumero(r), emUso: _count?.[cfg.uso] ?? 0 });

  cadastrosRouter.get(`/${rota}`, asyncHandler(async (req, res) => {
    const where = req.query.ativos === "1" ? { ativo: true } : {};
    const registros = await repo().findMany({ where, orderBy: cfg.ordem, include });
    res.json(registros.map(serializar));
  }));

  cadastrosRouter.post(`/${rota}`, requireRole(...PERMISSOES.cadastros), asyncHandler(async (req, res) => {
    const corpo = req.body ?? {};
    const dados = cfg.validar(corpo, false);
    cfg.validarConjunto?.(dados);
    const { criado, propagados } = await prisma.$transaction(async (tx) => {
      const depoisDeSalvar = cfg.antesDeSalvar ? await cfg.antesDeSalvar(tx, dados, corpo, null) : null;
      const criado = await repo(tx).create({ data: dados, include }).catch(traduzirErroUnico);
      return { criado, propagados: depoisDeSalvar ? await depoisDeSalvar() : 0 };
    });
    await registrarLog({
      usuarioEmail: req.usuario.email,
      acao: "CRIAR",
      entidade: cfg.entidade,
      entidadeId: criado.id,
      descricao: `Cadastro criado: ${cfg.rotulo(criado)}${propagados ? ` (região aplicada a mais ${propagados} cliente(s) da mesma fábrica)` : ""}`,
      dadosDepois: criado,
    });
    res.status(201).json(serializar(criado));
  }));

  cadastrosRouter.patch(`/${rota}/:id`, requireRole(...PERMISSOES.cadastros), asyncHandler(async (req, res) => {
    const registroId = validarId(req.params.id);
    const corpo = req.body ?? {};
    const antes = await repo().findUnique({ where: { id: registroId } });
    if (!antes) throw erroHttp(404, "Cadastro não encontrado.");
    const dados = cfg.validar(corpo, true);
    cfg.validarConjunto?.({ ...antes, ...dados });
    const { depois, propagados } = await prisma.$transaction(async (tx) => {
      const depoisDeSalvar = cfg.antesDeSalvar ? await cfg.antesDeSalvar(tx, dados, corpo, antes) : null;
      const depois = await repo(tx).update({ where: { id: registroId }, data: dados, include }).catch(traduzirErroUnico);
      return { depois, propagados: depoisDeSalvar ? await depoisDeSalvar() : 0 };
    });
    await registrarLog({
      usuarioEmail: req.usuario.email,
      acao: "ALTERAR",
      entidade: cfg.entidade,
      entidadeId: registroId,
      descricao:
        `Cadastro alterado: ${cfg.rotulo(depois)}` +
        (propagados ? ` (região aplicada a mais ${propagados} cliente(s) da mesma fábrica)` : "") +
        (cfg.uso === "containers" ? " (containers já em andamento mantêm os prazos antigos)" : ""),
      dadosAntes: antes,
      dadosDepois: depois,
    });
    res.json({ ...serializar(depois), propagados });
  }));

  cadastrosRouter.delete(`/${rota}/:id`, requireRole(...PERMISSOES.cadastros), asyncHandler(async (req, res) => {
    const registroId = validarId(req.params.id);
    const antes = await repo().findUnique({ where: { id: registroId }, include: { _count: { select: { [cfg.uso]: true } } } });
    if (!antes) throw erroHttp(404, "Cadastro não encontrado.");
    if (antes._count[cfg.uso] > 0) {
      throw erroHttp(
        409,
        cfg.uso === "grupos"
          ? "Esta região tem fábricas vinculadas. Mova as fábricas para outra região ou desative a região."
          : "Este cadastro já foi usado em containers. Desative-o em vez de excluir, para preservar o histórico."
      );
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
