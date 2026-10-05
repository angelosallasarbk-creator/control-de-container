// Lista paginada de containers e dados leves para o painel (v3.10).
//
// Por que existe: GET /api/containers devolvia TODOS os containers de uma vez (6 MB com 1.286 ativos),
// cada um com 50 leituras carregadas e a previsão de rota recalculada. Aqui:
//  - filtro, ordenação e paginação no BANCO (índices em Container_lista_*), só a página sai;
//  - cada linha vem de colunas + do resumo gravado pela sincronização (lib/resumoContainer.js): sem
//    leituras, sem contexto de rota, sem JOIN por linha (cadastros pequenos entram por mapas de id);
//  - situação, horas restantes e custos continuam calculados na hora (relógio), pelas MESMAS funções
//    da ficha, então não ficam velhos entre uma varredura e outra.
// O isolamento por cliente é o de sempre: toda consulta passa pelo filtro/RLS da organização.
import { prisma } from "./prisma.js";
import { lerConfiguracao } from "./configuracao.js";
import { STATUS_ENCERRADOS } from "./prazos.js";
import { situacaoDoResumo } from "./resumoContainer.js";
import { montarContainerComSituacao, decimaisParaNumero } from "./containerView.js";
import { sincronizarAlertas } from "./alertas.js";
import { erroHttp } from "./asyncHandler.js";

export const LIMITE_PADRAO = 20;
export const LIMITE_MAXIMO = 100;
const STATUS = ["PROGRAMADO", "COLETADO", "NA_FABRICA", "EM_OPERACAO", "LIBERADO", "SAIU_FABRICA", "ENTREGUE_PORTO", "CANCELADO"];

// Colunas que as listas e o painel usam. Fora: observação, lacre, planejamento, rastreio*, acompanhamento*
// (a ficha carrega o resto). `resumo` entra para a situação (temperatura e previsão).
export const SELECT_LINHA = {
  id: true, numero: true, tipo: true, status: true, grupoId: true, armadorId: true, produtoId: true, tipoOperacaoId: true,
  portoRetiradaId: true, localCarregamentoId: true, portoEntregaId: true, fluxo: true,
  booking: true, navio: true, placa: true, motorista: true, posicaoPatio: true, criadoEm: true,
  coletaProgramadaEm: true, deadline: true, coletadoEm: true, chegadaFabricaEm: true, inicioOperacaoEm: true, liberadoEm: true,
  saidaFabricaEm: true, entreguePortoEm: true, canceladoEm: true,
  metaEstadiaHoras: true, alertaEstadiaHoras: true, custoEstadiaPorHora: true, freeTimeDias: true, valorDiaria: true, moeda: true,
  alertaDemurrageDias: true, setpoint: true, tempMin: true, tempMax: true, toleranciaMinutos: true,
  resumo: true, resumoEm: true,
};

// Mapas de cadastros pequenos (grupos, armadores, locais com o tipo): evitam um JOIN por linha.
export async function carregarReferencias() {
  const [grupos, armadores, locais] = await Promise.all([
    prisma.grupoOperacao.findMany({ include: { regiao: { select: { id: true, nome: true } } } }),
    prisma.armador.findMany({ select: { id: true, nome: true, moeda: true } }),
    prisma.local.findMany({ select: { id: true, nome: true, tipo: { select: { rotuloColeta: true, rotuloChegada: true, rotuloSaida: true, rotuloEntrega: true } } } }),
  ]);
  return {
    grupos: new Map(grupos.map((g) => [g.id, g])),
    armadores: new Map(armadores.map((a) => [a.id, a])),
    locais: new Map(locais.map((l) => [l.id, l])),
  };
}

// Containers com etiqueta QR ligada, entre os ids pedidos (1 consulta).
export async function comQrVinculado(ids) {
  if (!ids.length) return new Set();
  const linhas = await prisma.etiquetaQR.findMany({ where: { containerId: { in: ids }, status: "VINCULADA" }, select: { containerId: true }, distinct: ["containerId"] });
  return new Set(linhas.map((l) => l.containerId));
}

/** Monta o container (mesma forma da ficha/lista antiga) a partir da linha + mapas, sem leituras. */
export function montarLinha(c, refs, agora, cfg, temQr) {
  const local = (id) => (id ? refs.locais.get(id) ?? null : null);
  const completo = {
    ...c,
    grupo: refs.grupos.get(c.grupoId),
    armador: refs.armadores.get(c.armadorId),
    portoRetirada: local(c.portoRetiradaId),
    localCarregamento: local(c.localCarregamentoId),
    portoEntrega: local(c.portoEntregaId),
    _count: { etiquetas: temQr ? 1 : 0 },
  };
  return montarContainerComSituacao(completo, situacaoDoResumo(c, c.resumo, agora, cfg), cfg);
}

// Resposta enxuta da lista: só o que as telas de Containers e a lista lateral mostram.
function linhaDaLista(m) {
  return {
    id: m.id, numero: m.numero, tipo: m.tipo, status: m.status, grupoId: m.grupoId,
    grupo: m.grupo && { id: m.grupo.id, cliente: m.grupo.cliente, fabrica: m.grupo.fabrica, regiaoId: m.grupo.regiaoId },
    armador: m.armador && { id: m.armador.id, nome: m.armador.nome },
    booking: m.booking, navio: m.navio, placa: m.placa, motorista: m.motorista, deadline: m.deadline, criadoEm: m.criadoEm,
    reefer: m.reefer, rotulosEtapa: m.rotulosEtapa, qrVinculado: m.qrVinculado, semaforo: m.semaforo, situacao: m.situacao,
    portoRetirada: m.portoRetirada && { nome: m.portoRetirada.nome },
    localCarregamento: m.localCarregamento && { nome: m.localCarregamento.nome },
    portoEntrega: m.portoEntrega && { nome: m.portoEntrega.nome },
  };
}

// ---------- Filtros e ordenação (tudo no banco; ordenação só por chaves da lista) ----------

const nulos = (campo) => (dir) => ({ [campo]: { sort: dir, nulls: "last" } });
const simples = (campo) => (dir) => ({ [campo]: dir });
// Chaves aceitas (nunca texto livre). "asc" = o que a tela chama de crescente: crítico/urgente primeiro.
const ORDENS = {
  semaforo: [nulos("semaforoNivel")],
  numero: [simples("numero")],
  tipo: [simples("tipo")],
  grupo: [(dir) => ({ grupo: { cliente: dir } }), (dir) => ({ grupo: { fabrica: dir } })],
  armador: [(dir) => ({ armador: { nome: dir } })],
  etapa: [simples("status")],
  estadia: [nulos("estadiaLimiteEm")],
  demurrage: [nulos("demurrageVenceEm")],
  temperatura: [nulos("ultimaTemperatura")],
  deadline: [nulos("deadline")],
  previsao: [nulos("previsaoFolgaHoras")],
  recente: [simples("criadoEm")],
};
export const CHAVES_DE_ORDEM = Object.keys(ORDENS);

const inteiros = (valor, rotulo) => {
  const lista = String(valor ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (lista.length > 100) throw erroHttp(400, `${rotulo}: informe no máximo 100.`);
  return lista.map((x) => {
    const n = Number(x);
    if (!Number.isInteger(n) || n <= 0) throw erroHttp(400, `${rotulo} inválido.`);
    return n;
  });
};

export function filtrosDaLista(q) {
  const and = [];
  const situacao = q.situacao ?? "ativos";
  if (!["ativos", "encerrados", "todos"].includes(situacao)) throw erroHttp(400, "Situação inválida.");
  if (situacao === "ativos") and.push({ status: { notIn: STATUS_ENCERRADOS } });
  if (situacao === "encerrados") and.push({ status: { in: STATUS_ENCERRADOS } });
  if (q.status) {
    if (!STATUS.includes(q.status)) throw erroHttp(400, "Status inválido.");
    and.push({ status: q.status });
  }
  const grupos = [...inteiros(q.grupos, "Pontos de carregamento"), ...(q.grupoId ? inteiros(q.grupoId, "Ponto de carregamento") : [])];
  if (grupos.length) and.push({ grupoId: { in: grupos } });
  const regioes = String(q.regioes ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (regioes.length) {
    const ids = inteiros(regioes.filter((r) => r !== "sem").join(","), "Regiões");
    and.push({ grupo: { OR: [...(ids.length ? [{ regiaoId: { in: ids } }] : []), ...(regioes.includes("sem") ? [{ regiaoId: null }] : [])] } });
  }
  if (q.semQr === "1" || q.semQr === "true") and.push({ etiquetas: { none: { status: "VINCULADA" } } });
  const busca = String(q.busca ?? "").trim().slice(0, 80);
  if (busca) {
    const numero = busca.toUpperCase().replace(/\s/g, "");
    const contem = (campo) => ({ [campo]: { contains: busca, mode: "insensitive" } });
    and.push({
      OR: [
        ...(/^[A-Z0-9]+$/.test(numero) ? [{ numero: { contains: numero } }] : []),
        contem("booking"), contem("placa"), contem("navio"),
        { portoRetirada: contem("nome") }, { localCarregamento: contem("nome") }, { portoEntrega: contem("nome") },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

export function ordemDaLista(q) {
  const chave = q.ordem ?? "semaforo";
  if (!ORDENS[chave]) throw erroHttp(400, `Ordenação inválida. Use: ${CHAVES_DE_ORDEM.join(", ")}.`);
  const dir = q.dir === "desc" ? "desc" : "asc";
  // Desempate estável (mais recente primeiro): a página não "pula" entre uma chamada e outra.
  return [...ORDENS[chave].map((f) => f(dir)), { criadoEm: "desc" }, { id: "desc" }];
}

const ehOrdemPadrao = (q) => (q.ordem ?? "semaforo") === "semaforo" && q.dir !== "desc";

// Em que página está o container pedido, na ordem padrão (crítico primeiro, mais recente primeiro).
async function paginaDoContainer(id, where, limite) {
  const c = await prisma.container.findFirst({ where: { AND: [where, { id }] }, select: { semaforoNivel: true, criadoEm: true } });
  if (!c || c.semaforoNivel === null) return null;
  const antes = await prisma.container.count({
    where: {
      AND: [where, {
        OR: [
          { semaforoNivel: { lt: c.semaforoNivel } },
          { semaforoNivel: c.semaforoNivel, criadoEm: { gt: c.criadoEm } },
          { semaforoNivel: c.semaforoNivel, criadoEm: c.criadoEm, id: { gt: id } },
        ],
      }],
    },
  });
  return Math.floor(antes / limite) + 1;
}

/**
 * Uma página da lista. q = parâmetros da requisição (situacao, status, grupos, regioes, semQr, busca,
 * ordem, dir, pagina, limite, localizar). Devolve { itens, total, pagina, limite, totalPaginas }.
 */
export async function listarContainers(q) {
  const limite = Math.min(LIMITE_MAXIMO, Math.max(1, Number.parseInt(q.limite, 10) || LIMITE_PADRAO));
  const where = filtrosDaLista(q);
  const orderBy = ordemDaLista(q);
  const total = await prisma.container.count({ where });
  const totalPaginas = Math.max(1, Math.ceil(total / limite));
  let pagina = Math.max(1, Number.parseInt(q.pagina, 10) || 1);
  const localizar = Number.parseInt(q.localizar, 10);
  if (Number.isInteger(localizar) && localizar > 0 && ehOrdemPadrao(q)) pagina = (await paginaDoContainer(localizar, where, limite)) ?? pagina;
  pagina = Math.min(pagina, totalPaginas);

  const [cfg, linhas] = await Promise.all([
    lerConfiguracao(),
    prisma.container.findMany({ where, orderBy, skip: (pagina - 1) * limite, take: limite, select: SELECT_LINHA }),
  ]);
  // Sem resumo ainda (container anterior à v3.10 e a varredura da subida não chegou nele): sincroniza
  // agora e relê só estes — a lista nunca mostra situação incompleta.
  const semResumo = linhas.filter((l) => !l.resumo);
  if (semResumo.length) {
    for (const l of semResumo) await sincronizarAlertas(l.id, { config: cfg });
    const relidas = new Map((await prisma.container.findMany({ where: { id: { in: semResumo.map((l) => l.id) } }, select: SELECT_LINHA })).map((l) => [l.id, l]));
    linhas.forEach((l, i) => { if (relidas.has(l.id)) linhas[i] = relidas.get(l.id); });
  }
  const [refs, qr] = await Promise.all([carregarReferencias(), comQrVinculado(linhas.map((l) => l.id))]);
  const agora = new Date();
  const itens = linhas.map((l) => linhaDaLista(montarLinha(l, refs, agora, cfg, qr.has(l.id))));
  return { itens, total, pagina, limite, totalPaginas };
}

export { decimaisParaNumero };
