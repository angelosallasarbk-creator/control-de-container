// Monta o contexto da previsão de ciclo (estimativa.js) para vários containers de uma vez,
// lendo SÓ o cache de distâncias — nunca chama o serviço de rota (isso é feito por
// rotas.garantirDistancias, na gravação do container e no verificador periódico).
import { prisma } from "./prisma.js";
import { percentil } from "./estimativa.js";

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

// containers: precisam de id, portoRetiradaId, localCarregamentoId, portoEntregaId, metaEstadiaHoras.
export async function montarContextos(containers, config) {
  const comTrajeto = containers.filter((c) => c.portoRetiradaId && c.localCarregamentoId && c.portoEntregaId);
  const ids = new Set();
  for (const c of comTrajeto) [c.portoRetiradaId, c.localCarregamentoId, c.portoEntregaId].forEach((i) => ids.add(i));
  const listaIds = [...ids];

  const [distancias, portos, tempos] = await Promise.all([
    listaIds.length
      ? prisma.distanciaRota.findMany({ where: { origemId: { in: listaIds }, destinoId: { in: listaIds } }, orderBy: { calculadoEm: "asc" } })
      : [],
    listaIds.length ? prisma.local.findMany({ where: { id: { in: listaIds } }, select: { id: true, filaHoras: true } }) : [],
    tempoNaFabricaPorLocal([...new Set(comTrajeto.map((c) => c.localCarregamentoId))]),
  ]);
  // Ordenado por data: o mais recente de cada par (em qualquer sentido) prevalece.
  const km = new Map(distancias.map((d) => [chavePar(d.origemId, d.destinoId), { km: Number(d.distanciaKm), fonte: d.fonte }]));
  const fila = new Map(portos.map((p) => [p.id, p.filaHoras === null ? null : Number(p.filaHoras)]));

  const contextos = new Map();
  for (const c of containers) {
    const ida = c.portoRetiradaId && c.localCarregamentoId ? km.get(chavePar(c.portoRetiradaId, c.localCarregamentoId)) : null;
    const volta = c.localCarregamentoId && c.portoEntregaId ? km.get(chavePar(c.localCarregamentoId, c.portoEntregaId)) : null;
    const historico = tempos.get(c.localCarregamentoId);
    contextos.set(c.id, {
      kmIda: ida?.km ?? null,
      fonteIda: ida?.fonte ?? null,
      kmVolta: volta?.km ?? null,
      fonteVolta: volta?.fonte ?? null,
      filaEntregaHoras: fila.get(c.portoEntregaId) ?? config.filaPortoHorasPadrao,
      tempoFabricaHoras: historico?.horas ?? c.metaEstadiaHoras,
      fonteTempoFabrica: historico ? "HISTORICO" : "META",
      amostrasFabrica: historico?.amostras ?? 0,
    });
  }
  return contextos;
}
