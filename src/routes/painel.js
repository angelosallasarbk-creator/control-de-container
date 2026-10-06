import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { lerConfiguracao } from "../lib/configuracao.js";
import { semaforo, STATUS_ENCERRADOS } from "../lib/prazos.js";
import { situacaoDoResumo } from "../lib/resumoContainer.js";
import { SELECT_LINHA, carregarReferencias, comQrVinculado, montarLinha } from "../lib/listaContainers.js";
import { temOperacao } from "../lib/fluxo.js";
import { organizacaoAtual } from "../lib/tenant.js";
import { comCachePainel } from "../lib/cachePainel.js";

export const painelRouter = Router();

const somarPorMoeda = (acc, moeda, valor) => {
  if (valor > 0) acc[moeda] = Math.round(((acc[moeda] ?? 0) + valor) * 100) / 100;
};

// Fases do pátio (onde o container está fisicamente). Sem local de operação (ex.: Coleta de cheio,
// Transferência) o container vai direto para "A caminho da entrega".
const NA_FABRICA = ["NA_FABRICA", "EM_OPERACAO", "LIBERADO"];
const FASES = {
  chegando: (c, tem) => tem && ["PROGRAMADO", "COLETADO"].includes(c.status),
  fabrica: (c) => NA_FABRICA.includes(c.status),
  porto: (c, tem) => c.status === "SAIU_FABRICA" || (!tem && ["PROGRAMADO", "COLETADO"].includes(c.status)),
};
const GRAVIDADE = { VERMELHO: 0, AMARELO: 1, VERDE: 2 };
const PADRAO_POR_FASE = 60;

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
  total: 0,
  fases: { chegando: 0, fabrica: 0, porto: 0 },
  ocultos: { chegando: 0, fabrica: 0, porto: 0 },
  containers: [],
});

/**
 * Parte cara, igual para qualquer filtro: lê todos os ativos da organização e soma totais, semáforo,
 * custos e contagem por fase. Guardada por cachePainel.js (por organização, alguns segundos).
 * O que ela devolve NÃO pode ser alterado por quem usa (é compartilhado entre requisições).
 */
async function calcularBase() {
  const [linhas, refs, alertasAbertos, config, regioes] = await Promise.all([
    prisma.container.findMany({ where: { status: { notIn: STATUS_ENCERRADOS } }, select: SELECT_LINHA, orderBy: [{ chegadaFabricaEm: "asc" }, { criadoEm: "asc" }] }),
    carregarReferencias(),
    prisma.alerta.groupBy({ by: ["containerId", "nivel"], where: { chaveAberta: { not: null } }, _count: true }),
    lerConfiguracao(),
    // Regiões ativas viram abas do Pátio, mesmo sem container no momento.
    prisma.regiao.findMany({ where: { ativo: true }, orderBy: { nome: "asc" }, select: { id: true, nome: true } }),
  ]);

  const alertasPorContainer = new Map();
  for (const a of alertasAbertos) {
    const atual = alertasPorContainer.get(a.containerId) ?? { ATENCAO: 0, CRITICO: 0 };
    atual[a.nivel] += a._count;
    alertasPorContainer.set(a.containerId, atual);
  }

  const agora = new Date();
  const gruposAtivos = [...refs.grupos.values()].filter((g) => g.ativo)
    .sort((a, b) => a.fabrica.localeCompare(b.fabrica, "pt-BR") || a.cliente.localeCompare(b.cliente, "pt-BR"));
  const porGrupo = new Map(gruposAtivos.map((g) => [g.id, novoGrupo(g)]));
  const totais = {
    ativos: linhas.length,
    porStatus: {},
    semaforo: { VERDE: 0, AMARELO: 0, VERMELHO: 0 },
    alertasCriticos: 0,
    alertasAtencao: 0,
    custoDemurrage: {},
    custoEstadia: 0,
  };

  const itens = []; // quem pode virar card: { l, grupoId, fase, nivel, cor, alertas }
  for (const l of linhas) {
    // Grupo desativado com container ainda ativo continua aparecendo no painel.
    if (!porGrupo.has(l.grupoId)) porGrupo.set(l.grupoId, novoGrupo(refs.grupos.get(l.grupoId)));
    const g = porGrupo.get(l.grupoId);
    const situacao = situacaoDoResumo(l, l.resumo, agora, config);
    const cor = semaforo(situacao);
    const alertas = alertasPorContainer.get(l.id) ?? { ATENCAO: 0, CRITICO: 0 };
    const { estadia, demurrage } = situacao;
    for (const alvo of [g, totais]) {
      alvo.porStatus[l.status] = (alvo.porStatus[l.status] ?? 0) + 1;
      alvo.semaforo[cor]++;
      if (demurrage) somarPorMoeda(alvo.custoDemurrage, demurrage.moeda, demurrage.custo);
      if (estadia?.custo) alvo.custoEstadia = Math.round((alvo.custoEstadia + estadia.custo) * 100) / 100;
      alvo.alertasCriticos += alertas.CRITICO;
      alvo.alertasAtencao += alertas.ATENCAO;
    }
    g.total++;
    const fase = Object.keys(FASES).find((f) => FASES[f](l, temOperacao(l)));
    if (fase) {
      g.fases[fase]++;
      itens.push({ l, grupoId: g.id, fase, cor, nivel: GRAVIDADE[cor], alertas });
    }
  }
  return { agora, config, refs, regioes, totais, grupos: [...porGrupo.values()], itens };
}

/**
 * Visão do pátio: containers ativos agrupados por Ponto de Carregamento (com a região da fábrica),
 * com semáforo e custos.
 *
 * v3.10: os números (totais, semáforo, custos, contagem por fase) cobrem TODOS os containers ativos,
 * mas os cards só vêm para o escopo pedido, no máximo `porFase` por grupo e fase (os mais críticos
 * primeiro) — antes eram 1 MB com todos os cards de todos os grupos a cada minuto.
 * v3.11: o cálculo dos números é guardado alguns segundos por organização (lib/cachePainel.js).
 * Parâmetros: regiao (todas | sem | id), grupoId, soProblemas=1, porFase (padrão 60, máx. 200).
 */
painelRouter.get("/", asyncHandler(async (req, res) => {
  const regiao = String(req.query.regiao ?? "todas");
  if (!/^(todas|sem|\d+)$/.test(regiao)) throw erroHttp(400, "Região inválida.");
  const grupoFiltro = req.query.grupoId ? Number(req.query.grupoId) : null;
  if (grupoFiltro !== null && (!Number.isInteger(grupoFiltro) || grupoFiltro <= 0)) throw erroHttp(400, "Ponto de carregamento inválido.");
  const soProblemas = ["1", "true"].includes(String(req.query.soProblemas ?? ""));
  const porFase = Math.min(200, Math.max(1, Number.parseInt(req.query.porFase, 10) || PADRAO_POR_FASE));

  const base = await comCachePainel(organizacaoAtual(), calcularBase);
  const { agora, config, refs } = base;
  // Cópia por requisição: os cards e os "+N" dependem do filtro, o resto é compartilhado e só lido.
  const grupos = base.grupos.map((g) => ({ ...g, ocultos: { chegando: 0, fabrica: 0, porto: 0 }, containers: [] }));
  const porGrupo = new Map(grupos.map((g) => [g.id, g]));
  const noEscopo = (g) =>
    (regiao === "todas" || (regiao === "sem" ? !g.regiao : String(g.regiao?.id) === regiao)) && (!grupoFiltro || g.id === grupoFiltro);

  // Candidatos a card: do escopo pedido (e só com problema, se pedido).
  const candidatos = new Map(); // `${grupoId}:${fase}` → [item]
  for (const it of base.itens) {
    if (!noEscopo(porGrupo.get(it.grupoId)) || (soProblemas && it.cor === "VERDE")) continue;
    const chave = `${it.grupoId}:${it.fase}`;
    if (!candidatos.has(chave)) candidatos.set(chave, []);
    candidatos.get(chave).push(it);
  }

  // Escolhe os cards (mais críticos primeiro quando passa do limite, mantendo a ordem de chegada).
  const escolhidos = [];
  for (const [chave, lista] of candidatos) {
    const [grupoId, fase] = chave.split(":");
    const g = porGrupo.get(Number(grupoId));
    let ficam = lista;
    if (lista.length > porFase) {
      const ordem = new Map(lista.map((x, i) => [x, i]));
      ficam = [...lista].sort((a, b) => a.nivel - b.nivel || ordem.get(a) - ordem.get(b)).slice(0, porFase).sort((a, b) => ordem.get(a) - ordem.get(b));
      g.ocultos[fase] = lista.length - porFase;
    }
    for (const item of ficam) escolhidos.push({ g, ...item });
  }

  // Monta só os cards escolhidos.
  const qr = await comQrVinculado(escolhidos.map((e) => e.l.id));
  for (const { g, l, alertas } of escolhidos) {
    const c = montarLinha(l, refs, agora, config, qr.has(l.id));
    const { estadia, demurrage, temperatura, previsao } = c.situacao;
    g.containers.push({
      id: c.id,
      numero: c.numero,
      qrVinculado: c.qrVinculado,
      tipo: c.tipo,
      reefer: c.reefer,
      status: c.status,
      rotulosEtapa: c.rotulosEtapa,
      // Tipo de Operação: sem local de operação o container vai direto da coleta à entrega (seção
      // "A caminho da entrega"); o nome aparece no card quando não é o tipo padrão.
      temOperacao: c.temOperacao,
      tipoOperacao: l.fluxo && !l.fluxo.padrao ? l.fluxo.tipo : null,
      semaforo: c.semaforo,
      posicaoPatio: c.posicaoPatio,
      armador: c.armador.nome,
      booking: c.booking,
      coletaProgramadaEm: c.coletaProgramadaEm,
      atrasoColeta: c.situacao.atrasoColeta?.atrasada ? { horasAtraso: c.situacao.atrasoColeta.horasAtraso, situacao: c.situacao.atrasoColeta.situacao } : null,
      estadia: estadia && { horasDecorridas: estadia.horasDecorridas, metaHoras: estadia.metaHoras, horasRestantes: estadia.horasRestantes, situacao: estadia.situacao, percentualConsumido: estadia.percentualConsumido },
      demurrage: demurrage && { diasRestantes: demurrage.diasRestantes, diasExcedidos: demurrage.diasExcedidos, situacao: demurrage.situacao, custo: demurrage.custo, moeda: demurrage.moeda },
      temperatura: temperatura && {
        ultima: temperatura.ultima,
        foraDaFaixa: temperatura.foraDaFaixa,
        semLeitura: temperatura.semLeitura,
        tempMin: temperatura.tempMin,
        tempMax: temperatura.tempMax,
      },
      // Entrega a definir (v3.7): sem ETA final; o card mostra o aviso.
      entregaADefinir: !l.portoEntregaId,
      previsao: previsao?.disponivel && !previsao.parcial
        ? {
            previsaoEntrega: previsao.previsaoEntrega,
            folgaHoras: previsao.folgaHoras,
            riscoDemurrage: previsao.riscoDemurrage,
            riscoDeadline: previsao.riscoDeadline,
            diasDemurragePrevistos: previsao.diasDemurragePrevistos,
            hipotetico: previsao.hipotetico,
          }
        : null,
      alertas,
    });
  }

  res.json({ geradoEm: agora, totais: base.totais, regioes: base.regioes, grupos, escopo: { regiao, grupoId: grupoFiltro, soProblemas, porFase } });
}));
