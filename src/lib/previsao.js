// Monta o contexto da previsão de ciclo (estimativa.js) para vários containers de uma vez,
// lendo SÓ o cache de distâncias — nunca chama o serviço de rota (isso é feito por
// rotas.garantirDistancias, na gravação do container e no verificador periódico).
import { prisma } from "./prisma.js";
import { percentil } from "./estimativa.js";
import { ordenarParadas, tempoParadaDoLocal, SELECT_LOCAL_PARADA } from "./rotas.js";
import { temOperacao } from "./fluxo.js";

const HORA = 60 * 60 * 1000;
const JANELA_HISTORICO_DIAS = 180;
const MIN_AMOSTRAS = 3; // abaixo disso, usa a meta de estadia no lugar do histórico

const chavePar = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;

export function configRodagem(config) {
  return {
    rodagemInicioMin: config.rodagemInicioMin,
    rodagemFimMin: config.rodagemFimMin,
    kmPorDia: config.kmPorDia,
    riscoFolgaHoras: config.riscoFolgaHoras,
  };
}

// Tempo real no local de carregamento (chegada → saída) dos últimos 180 dias, P80 por local.
async function tempoNaFabricaPorLocal(localIds) {
  if (!localIds.length) return new Map();
  const desde = new Date(Date.now() - JANELA_HISTORICO_DIAS * 24 * HORA);
  const passagens = await prisma.container.findMany({
    where: { localCarregamentoId: { in: localIds }, chegadaFabricaEm: { not: null }, saidaFabricaEm: { gte: desde } },
    select: { localCarregamentoId: true, chegadaFabricaEm: true, saidaFabricaEm: true },
  });
  const porLocal = new Map();
  for (const p of passagens) {
    const horas = (p.saidaFabricaEm - p.chegadaFabricaEm) / HORA;
    if (horas <= 0) continue;
    if (!porLocal.has(p.localCarregamentoId)) porLocal.set(p.localCarregamentoId, []);
    porLocal.get(p.localCarregamentoId).push(horas);
  }
  const resultado = new Map();
  for (const [id, horas] of porLocal) {
    if (horas.length >= MIN_AMOSTRAS) resultado.set(id, { horas: percentil(horas, 80), amostras: horas.length });
  }
  return resultado;
}

// Paradas (ex.: Ponto Fiscal) dos containers, com nome e tempo de parada do local. Uma consulta só.
async function paradasPorContainer(containerIds) {
  if (!containerIds.length) return new Map();
  const paradas = await prisma.paradaContainer.findMany({
    where: { containerId: { in: containerIds } },
    select: { id: true, containerId: true, localId: true, fase: true, ordem: true, passouEm: true, local: { select: SELECT_LOCAL_PARADA } },
  });
  const mapa = new Map();
  for (const p of paradas) {
    if (!mapa.has(p.containerId)) mapa.set(p.containerId, []);
    mapa.get(p.containerId).push(p);
  }
  for (const [id, lista] of mapa) mapa.set(id, ordenarParadas(lista));
  return mapa;
}

// Trechos de uma perna (ida ou volta) passando pelas paradas: km de cada trecho + total.
function perna(origemId, destinoId, paradas, km) {
  const seq = [origemId, ...paradas.map((p) => p.localId), destinoId];
  const trechos = seq.slice(1).map((d, i) => km.get(chavePar(seq[i], d)) ?? null);
  const completo = trechos.every(Boolean);
  return {
    km: completo ? trechos.reduce((s, x) => s + x.km, 0) : null,
    fonte: completo ? (trechos.some((x) => x.fonte === "ESTIMADA") ? "ESTIMADA" : trechos[0]?.fonte ?? null) : null,
    trechos: trechos.map((x) => (x ? { km: x.km, fonte: x.fonte } : null)),
    paradas: paradas.map((p) => ({
      id: p.id, localId: p.localId, nome: p.local.nome, passouEm: p.passouEm,
      tempoHoras: tempoParadaDoLocal(p.local),
    })),
  };
}

// containers: precisam de id, portoRetiradaId, localCarregamentoId, portoEntregaId, metaEstadiaHoras.
// As paradas do trajeto (ParadaContainer) são lidas aqui mesmo.
export async function montarContextos(containers, config) {
  // Entrega a definir (v3.7): o contexto sai mesmo sem a entrega (previsão parcial da ida).
  const comTrajeto = containers.filter((c) => c.portoRetiradaId && (c.localCarregamentoId || !temOperacao(c)));
  const paradas = await paradasPorContainer(comTrajeto.map((c) => c.id));
  const ids = new Set();
  for (const c of comTrajeto) {
    [c.portoRetiradaId, c.localCarregamentoId, c.portoEntregaId].filter(Boolean).forEach((i) => ids.add(i));
    (paradas.get(c.id) ?? []).forEach((p) => ids.add(p.localId));
  }
  const listaIds = [...ids];

  const [distancias, portos, tempos] = await Promise.all([
    listaIds.length
      ? prisma.distanciaRota.findMany({ where: { origemId: { in: listaIds }, destinoId: { in: listaIds } }, orderBy: { calculadoEm: "asc" } })
      : [],
    listaIds.length ? prisma.local.findMany({ where: { id: { in: listaIds } }, select: { id: true, filaHoras: true } }) : [],
    tempoNaFabricaPorLocal([...new Set(comTrajeto.map((c) => c.localCarregamentoId).filter(Boolean))]),
  ]);
  // Ordenado por data: o mais recente de cada par (em qualquer sentido) prevalece.
  const km = new Map(distancias.map((d) => [chavePar(d.origemId, d.destinoId), { km: Number(d.distanciaKm), fonte: d.fonte }]));
  const fila = new Map(portos.map((p) => [p.id, p.filaHoras === null ? null : Number(p.filaHoras)]));

  const contextos = new Map();
  for (const c of containers) {
    const lista = paradas.get(c.id) ?? [];
    // Fluxo sem local de operação: uma perna só, retirada → paradas → entrega.
    const direto = !temOperacao(c) && c.portoRetiradaId && c.portoEntregaId ? perna(c.portoRetiradaId, c.portoEntregaId, lista, km) : null;
    const ida = c.portoRetiradaId && c.localCarregamentoId
      ? perna(c.portoRetiradaId, c.localCarregamentoId, lista.filter((p) => p.fase === "ANTES_CARREGAMENTO"), km) : null;
    const volta = c.localCarregamentoId && c.portoEntregaId
      ? perna(c.localCarregamentoId, c.portoEntregaId, lista.filter((p) => p.fase === "APOS_CARREGAMENTO"), km) : null;
    const historico = tempos.get(c.localCarregamentoId);
    contextos.set(c.id, {
      kmIda: ida?.km ?? null,
      fonteIda: ida?.fonte ?? null,
      kmVolta: volta?.km ?? null,
      fonteVolta: volta?.fonte ?? null,
      // Paradas (ex.: Ponto Fiscal) e o km de cada trecho entre elas (vazio = sem paradas).
      paradasIda: ida?.paradas ?? [],
      trechosIda: ida?.trechos ?? [],
      paradasVolta: volta?.paradas ?? [],
      trechosVolta: volta?.trechos ?? [],
      kmDireto: direto?.km ?? null,
      fonteDireto: direto?.fonte ?? null,
      paradasDireto: direto?.paradas ?? [],
      trechosDireto: direto?.trechos ?? [],
      filaEntregaHoras: fila.get(c.portoEntregaId) ?? config.filaPortoHorasPadrao,
      tempoFabricaHoras: historico?.horas ?? c.metaEstadiaHoras,
      fonteTempoFabrica: historico ? "HISTORICO" : "META",
      amostrasFabrica: historico?.amostras ?? 0,
    });
  }
  return contextos;
}
