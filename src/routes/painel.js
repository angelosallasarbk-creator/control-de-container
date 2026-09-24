import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { lerConfiguracao } from "../lib/configuracao.js";
import { montarContainer } from "../lib/containerView.js";
import { STATUS_ENCERRADOS } from "../lib/prazos.js";

export const painelRouter = Router();

const somarPorMoeda = (acc, moeda, valor) => {
  if (valor > 0) acc[moeda] = Math.round(((acc[moeda] ?? 0) + valor) * 100) / 100;
};

// Visão do pátio: containers ativos agrupados por Cliente / Fábrica (com a região da fábrica),
// com semáforo e custos. A separação em abas por região é feita na tela.
painelRouter.get("/", asyncHandler(async (_req, res) => {
  const [containers, grupos, alertasAbertos, config] = await Promise.all([
    prisma.container.findMany({
      where: { status: { notIn: STATUS_ENCERRADOS } },
      include: { grupo: { include: { regiao: true } }, armador: true, produto: true, leituras: { orderBy: { lidaEm: "desc" }, take: 50 } },
      orderBy: [{ chegadaFabricaEm: "asc" }, { criadoEm: "asc" }],
    }),
    prisma.grupoOperacao.findMany({
      where: { ativo: true },
      include: { regiao: true },
      orderBy: [{ fabrica: "asc" }, { cliente: "asc" }],
    }),
    prisma.alerta.groupBy({ by: ["containerId", "nivel"], where: { chaveAberta: { not: null } }, _count: true }),
    lerConfiguracao(),
  ]);

  const alertasPorContainer = new Map();
  for (const a of alertasAbertos) {
    const atual = alertasPorContainer.get(a.containerId) ?? { ATENCAO: 0, CRITICO: 0 };
    atual[a.nivel] += a._count;
    alertasPorContainer.set(a.containerId, atual);
  }

  const agora = new Date();
  const novoGrupo = (g) => ({
    id: g.id,
    cliente: g.cliente,
    fabrica: g.fabrica,
    regiao: g.regiao ? { id: g.regiao.id, nome: g.regiao.nome } : null,
    metaEstadiaHoras: g.metaEstadiaHoras,
    porStatus: {},
    semaforo: { VERDE: 0, AMARELO: 0, VERMELHO: 0 },
    alertasCriticos: 0,
    alertasAtencao: 0,
    custoDemurrage: {},
    custoEstadia: 0,
    containers: [],
  });
  const porGrupo = new Map(grupos.map((g) => [g.id, novoGrupo(g)]));
  const totais = {
    ativos: containers.length,
    porStatus: {},
    semaforo: { VERDE: 0, AMARELO: 0, VERMELHO: 0 },
    alertasCriticos: 0,
    alertasAtencao: 0,
    custoDemurrage: {},
    custoEstadia: 0,
  };

  for (const bruto of containers) {
    const c = montarContainer(bruto, [...bruto.leituras].reverse(), agora, config);
    // Grupo desativado com container ainda ativo continua aparecendo no painel.
    if (!porGrupo.has(c.grupoId)) porGrupo.set(c.grupoId, novoGrupo(c.grupo));
    const g = porGrupo.get(c.grupoId);
    const alertas = alertasPorContainer.get(c.id) ?? { ATENCAO: 0, CRITICO: 0 };
    const { estadia, demurrage, temperatura } = c.situacao;

    for (const alvo of [g, totais]) {
      alvo.porStatus[c.status] = (alvo.porStatus[c.status] ?? 0) + 1;
      alvo.semaforo[c.semaforo]++;
      if (demurrage) somarPorMoeda(alvo.custoDemurrage, demurrage.moeda, demurrage.custo);
      if (estadia?.custo) alvo.custoEstadia = Math.round((alvo.custoEstadia + estadia.custo) * 100) / 100;
      alvo.alertasCriticos += alertas.CRITICO;
      alvo.alertasAtencao += alertas.ATENCAO;
    }

    g.containers.push({
      id: c.id,
      numero: c.numero,
      tipo: c.tipo,
      reefer: c.reefer,
      status: c.status,
      semaforo: c.semaforo,
      posicaoPatio: c.posicaoPatio,
      armador: c.armador.nome,
      booking: c.booking,
      estadia: estadia && { horasDecorridas: estadia.horasDecorridas, metaHoras: estadia.metaHoras, horasRestantes: estadia.horasRestantes, situacao: estadia.situacao, percentualConsumido: estadia.percentualConsumido },
      demurrage: demurrage && { diasRestantes: demurrage.diasRestantes, diasExcedidos: demurrage.diasExcedidos, situacao: demurrage.situacao, custo: demurrage.custo, moeda: demurrage.moeda },
      temperatura: temperatura && {
        ultima: temperatura.ultima,
        foraDaFaixa: temperatura.foraDaFaixa,
        semLeitura: temperatura.semLeitura,
        tempMin: temperatura.tempMin,
        tempMax: temperatura.tempMax,
      },
      alertas,
    });
  }

  // Regiões ativas viram abas do Pátio, mesmo sem container no momento.
  const regioes = await prisma.regiao.findMany({ where: { ativo: true }, orderBy: { nome: "asc" }, select: { id: true, nome: true } });
  res.json({ geradoEm: agora, totais, regioes, grupos: [...porGrupo.values()] });
}));
