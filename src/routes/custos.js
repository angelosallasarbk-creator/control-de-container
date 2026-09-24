import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { lerConfiguracao } from "../lib/configuracao.js";
import { custosDiarios, temposPorEtapa, diaBrasilia, inicioDoDiaISO, MOEDA_ESTADIA } from "../lib/custos.js";

export const custosRouter = Router();

const DIA = 24 * 60 * 60 * 1000;
const PERIODO_PADRAO_DIAS = 90;
const PERIODO_MAXIMO_DIAS = 731;
const FORMATO_DIA = /^\d{4}-\d{2}-\d{2}$/;

function lerDia(valor, rotulo) {
  if (!FORMATO_DIA.test(String(valor)) || Number.isNaN(Date.parse(`${valor}T00:00:00Z`))) {
    throw erroHttp(400, `${rotulo} inválida (use AAAA-MM-DD).`);
  }
  return String(valor);
}

// Custo estimado no período [de, ate] (dias de Brasília, inclusive), lançado por competência.
// A tela agrega por região / Cliente-Fábrica, monta tendência e impactos a partir disto.
custosRouter.get("/", asyncHandler(async (req, res) => {
  const agora = new Date();
  const ate = req.query.ate ? lerDia(req.query.ate, "Data final") : diaBrasilia(agora);
  const de = req.query.de
    ? lerDia(req.query.de, "Data inicial")
    : diaBrasilia(inicioDoDiaISO(ate).getTime() - (PERIODO_PADRAO_DIAS - 1) * DIA);
  if (de > ate) throw erroHttp(400, "A data inicial não pode ser depois da final.");
  if ((Date.parse(ate) - Date.parse(de)) / DIA + 1 > PERIODO_MAXIMO_DIAS) {
    throw erroHttp(400, `Período máximo de ${PERIODO_MAXIMO_DIAS} dias.`);
  }
  const inicio = inicioDoDiaISO(de);
  const fim = new Date(inicioDoDiaISO(ate).getTime() + DIA); // exclusivo

  const [containers, grupos, regioes, config] = await Promise.all([
    // Cancelados ficam fora: não têm data de devolução para fechar a conta.
    prisma.container.findMany({
      where: {
        status: { not: "CANCELADO" },
        OR: [{ coletadoEm: { lt: fim } }, { chegadaFabricaEm: { lt: fim } }],
        AND: [{ OR: [{ entreguePortoEm: null }, { entreguePortoEm: { gte: inicio } }] }],
      },
      include: { armador: { select: { nome: true } } },
    }),
    prisma.grupoOperacao.findMany({ include: { regiao: true }, orderBy: [{ fabrica: "asc" }, { cliente: "asc" }] }),
    prisma.regiao.findMany({ where: { ativo: true }, orderBy: { nome: "asc" }, select: { id: true, nome: true } }),
    lerConfiguracao(),
  ]);

  const noPeriodo = (dia) => dia >= de && dia <= ate;
  const diasAgregados = new Map(); // `${grupoId}|${dia}` → linha
  const detalhes = [];
  const containersPorGrupo = new Map();

  for (const c of containers) {
    containersPorGrupo.set(c.grupoId, (containersPorGrupo.get(c.grupoId) ?? 0) + 1);
    const resumo = { estadiaHoras: 0, estadiaValor: 0, diarias: 0, demurrageValor: 0 };
    for (const [dia, v] of custosDiarios(c, agora)) {
      if (!noPeriodo(dia)) continue;
      const chave = `${c.grupoId}|${dia}`;
      const linha = diasAgregados.get(chave) ?? { grupoId: c.grupoId, dia, estadiaHoras: 0, diarias: 0, estadia: {}, demurrage: {} };
      linha.estadiaHoras += v.estadiaHoras;
      linha.diarias += v.diarias;
      if (v.estadiaValor) linha.estadia[MOEDA_ESTADIA] = (linha.estadia[MOEDA_ESTADIA] ?? 0) + v.estadiaValor;
      if (v.demurrageValor) linha.demurrage[c.moeda] = (linha.demurrage[c.moeda] ?? 0) + v.demurrageValor;
      diasAgregados.set(chave, linha);
      for (const k of Object.keys(resumo)) resumo[k] += v[k];
    }
    if (resumo.estadiaHoras > 0 || resumo.diarias > 0) {
      detalhes.push({
        id: c.id,
        numero: c.numero,
        tipo: c.tipo,
        status: c.status,
        grupoId: c.grupoId,
        armador: c.armador.nome,
        coletadoEm: c.coletadoEm,
        chegadaFabricaEm: c.chegadaFabricaEm,
        saidaFabricaEm: c.saidaFabricaEm,
        entreguePortoEm: c.entreguePortoEm,
        metaEstadiaHoras: c.metaEstadiaHoras,
        freeTimeDias: c.freeTimeDias,
        semCustoHora: c.custoEstadiaPorHora === null,
        estadiaHoras: Math.round(resumo.estadiaHoras * 10) / 10,
        estadiaValor: Math.round(resumo.estadiaValor * 100) / 100,
        estadiaMoeda: MOEDA_ESTADIA,
        diarias: resumo.diarias,
        demurrageValor: Math.round(resumo.demurrageValor * 100) / 100,
        demurrageMoeda: c.moeda,
        tempos: temposPorEtapa(c, agora),
      });
    }
  }

  const cotacoes = { BRL: 1, USD: config.cotacaoUSD || null, EUR: config.cotacaoEUR || null };
  res.json({
    de,
    ate,
    geradoEm: agora,
    cotacoes,
    regioes,
    grupos: grupos.map((g) => ({
      id: g.id,
      cliente: g.cliente,
      fabrica: g.fabrica,
      ativo: g.ativo,
      regiao: g.regiao ? { id: g.regiao.id, nome: g.regiao.nome } : null,
      metaEstadiaHoras: g.metaEstadiaHoras,
      custoEstadiaPorHora: g.custoEstadiaPorHora === null ? null : Number(g.custoEstadiaPorHora),
      containersNoPeriodo: containersPorGrupo.get(g.id) ?? 0,
    })),
    dias: [...diasAgregados.values()].sort((a, b) => a.dia.localeCompare(b.dia)),
    containers: detalhes,
  });
}));
