// Previsão do ciclo do container (funções puras, sem banco/rede):
//   coleta no porto → [rodagem vazio (+ paradas)] → fábrica → [tempo na fábrica] → saída
//   → [rodagem cheio (+ paradas)] → porto de entrega → [fila/gate] → entrega
// Paradas (ex.: Ponto Fiscal): rodagem até a parada + tempo parado; com a passagem registrada, o
// trecho seguinte parte do horário real.
// Regra de rodagem configurável (Configurações): o caminhão só roda dentro da janela diária
// (ex.: 05h–22h, horário de Brasília) e faz no máximo `kmPorDia` por dia; fim de semana e
// feriado rodam normal. Fora da janela ele fica parado e continua no dia seguinte.
import { inicioDoDiaBrasilia } from "./prazos.js";
import { temOperacao, CAMPO_DATA_STATUS } from "./fluxo.js";

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
const OFFSET_BRASILIA = -3 * HORA;

const arred = (v, casas = 1) => (v === null || v === undefined ? null : Math.round(v * 10 ** casas) / 10 ** casas);
const maisTarde = (a, b) => (a.getTime() >= b.getTime() ? a : b);

export function haversineKm(a, b) {
  const R = 6371;
  const rad = (g) => (Number(g) * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function janelaHoras(cfg) {
  return (cfg.rodagemFimMin - cfg.rodagemInicioMin) / 60;
}

// Horas de rodagem (dentro da janela) para percorrer `km`: 1 dia de janela = kmPorDia.
export function horasDeRodagem(km, cfg) {
  return (km / cfg.kmPorDia) * janelaHoras(cfg);
}

// Avança `horas` de rodagem a partir de `partida`, respeitando a janela diária em Brasília.
export function avancarRodagem(partida, horas, cfg) {
  let t = partida.getTime();
  let restanteMs = horas * HORA;
  for (let guarda = 0; restanteMs > 0 && guarda < 400; guarda++) {
    const meiaNoite = inicioDoDiaBrasilia(new Date(t)).getTime();
    const abre = meiaNoite + cfg.rodagemInicioMin * MIN;
    const fecha = meiaNoite + cfg.rodagemFimMin * MIN;
    if (t < abre) t = abre;
    if (t >= fecha) {
      t = meiaNoite + DIA + cfg.rodagemInicioMin * MIN; // abre no dia seguinte
      continue;
    }
    const usar = Math.min(restanteMs, fecha - t);
    t += usar;
    restanteMs -= usar;
  }
  return new Date(t);
}

export function chegadaDoTrecho(partida, km, cfg) {
  return avancarRodagem(partida, horasDeRodagem(km, cfg), cfg);
}

// Percentil (nearest-rank). Usado com 80: valor que 80% das passagens não ultrapassaram.
export function percentil(valores, p) {
  if (!valores.length) return null;
  const ordenados = [...valores].sort((a, b) => a - b);
  const idx = Math.min(ordenados.length - 1, Math.max(0, Math.ceil((p / 100) * ordenados.length) - 1));
  return ordenados[idx];
}

function nivelRisco(folgaHoras, limiteAtencaoHoras) {
  if (folgaHoras === null) return null;
  if (folgaHoras < 0) return "CRITICO";
  if (folgaHoras < limiteAtencaoHoras) return "ATENCAO";
  return "OK";
}

/**
 * Percorre uma perna (ida ou volta) a partir de `inicio`, passando pelas paradas.
 * Devolve o horário de chegada ao destino da perna, os trechos (rodagem e paradas) e os marcos de
 * passagem (previsão ou horário real). `destinoReal` (etapa já registrada) torna as previsões das
 * paradas não registradas sem sentido (null).
 */
function percorrerPerna({ inicio, kmTotal, fonteTotal, paradas = [], trechos = [], nomes, carga, fase, destinoReal, cfg, futuro }) {
  const lista = [];
  const marcos = [];
  const sufixo = carga ? ` (${carga})` : "";
  if (!paradas.length) {
    const fim = destinoReal ?? futuro(chegadaDoTrecho(inicio, kmTotal, cfg));
    lista.push({ etapa: `${nomes.origem} → ${nomes.destino}${sufixo}`, km: kmTotal, fonte: fonteTotal, inicio, fim, real: Boolean(destinoReal) });
    return { fim, trechos: lista, marcos };
  }
  let t = inicio;
  let origem = nomes.origemCurto;
  paradas.forEach((p, i) => {
    const km = trechos[i]?.km ?? null;
    const real = p.passouEm ? new Date(p.passouEm) : null;
    const chegada = km === null ? t : futuro(chegadaDoTrecho(t, km, cfg));
    lista.push({ etapa: `${origem} → ${p.nome}${sufixo}`, km, fonte: trechos[i]?.fonte ?? null, inicio: t, fim: real ?? chegada, real: Boolean(real) });
    const saida = real ?? futuro(new Date(chegada.getTime() + p.tempoHoras * HORA));
    lista.push({ etapa: `Parada: ${p.nome}`, horas: p.tempoHoras, inicio: real ?? chegada, fim: saida, real: Boolean(real), parada: true });
    marcos.push({ paradaId: p.id, nome: p.nome, fase, previsao: real || destinoReal ? null : chegada, realizado: real });
    t = saida;
    origem = p.nome;
  });
  const ultimo = trechos[paradas.length] ?? null;
  const fim = destinoReal ?? futuro(chegadaDoTrecho(t, ultimo?.km ?? 0, cfg));
  lista.push({ etapa: `${origem} → ${nomes.destino}${sufixo}`, km: ultimo?.km ?? null, fonte: ultimo?.fonte ?? null, inicio: t, fim, real: Boolean(destinoReal) });
  return { fim, trechos: lista, marcos };
}

/**
 * c: container (datas, status, freeTimeDias, valorDiaria, moeda, deadline, metaEstadiaHoras)
 * ctx: { kmIda, fonteIda, kmVolta, fonteVolta, filaEntregaHoras, tempoFabricaHoras, fonteTempoFabrica, amostrasFabrica,
 *        paradasIda, trechosIda, paradasVolta, trechosVolta }
 * cfg: { rodagemInicioMin, rodagemFimMin, kmPorDia, riscoFolgaHoras }
 * Container PROGRAMADO é simulado com a coleta na data programada (ou agora, se não houver ou já
 * tiver passado) — hipotetico = true.
 */
export function estimarCiclo(c, ctx, agora, cfg) {
  if (["ENTREGUE_PORTO", "CANCELADO"].includes(c.status)) return null;
  if (!temOperacao(c)) return estimarDireto(c, ctx, agora, cfg);
  // Vazio na ida e cheio na volta só na exportação; nos outros tipos o trecho não diz a carga.
  const exportacao = !c.fluxo || c.fluxo.padrao;
  const faltando = [];
  if (!c.portoRetiradaId) faltando.push("local de retirada");
  if (!c.localCarregamentoId) faltando.push("local de carregamento");
  if (!c.portoEntregaId) faltando.push("local de entrega");
  if (!faltando.length && (ctx?.kmIda === null || ctx?.kmIda === undefined)) faltando.push("distância retirada → carregamento (confira as coordenadas)");
  if (!faltando.length && (ctx?.kmVolta === null || ctx?.kmVolta === undefined)) faltando.push("distância carregamento → entrega (confira as coordenadas)");
  if (faltando.length) return { disponivel: false, faltando };

  const hipotetico = !c.coletadoEm;
  const aconteceu = (d) => (d ? new Date(d) : null);
  // Evento futuro nunca é previsto no passado: se já devia ter acontecido e não aconteceu, é "agora".
  const futuro = (d) => maisTarde(d, agora);

  // Ainda não coletado: simula a coleta na data programada (ou agora, se ela já passou/não existe).
  const coleta = aconteceu(c.coletadoEm) ?? futuro(c.coletaProgramadaEm ? new Date(c.coletaProgramadaEm) : agora);
  const ida = percorrerPerna({
    inicio: coleta, kmTotal: ctx.kmIda, fonteTotal: ctx.fonteIda, paradas: ctx.paradasIda, trechos: ctx.trechosIda,
    nomes: { origem: "Retirada", origemCurto: "Retirada", destino: "carregamento" }, carga: exportacao ? "vazio" : null, fase: "ANTES_CARREGAMENTO",
    destinoReal: aconteceu(c.chegadaFabricaEm), cfg, futuro,
  });
  const chegadaFabrica = ida.fim;
  const saidaFabrica = aconteceu(c.saidaFabricaEm) ?? futuro(new Date(chegadaFabrica.getTime() + ctx.tempoFabricaHoras * HORA));
  const volta = percorrerPerna({
    inicio: saidaFabrica, kmTotal: ctx.kmVolta, fonteTotal: ctx.fonteVolta, paradas: ctx.paradasVolta, trechos: ctx.trechosVolta,
    nomes: { origem: "Carregamento", origemCurto: "Carregamento", destino: "entrega" }, carga: exportacao ? "cheio" : null, fase: "APOS_CARREGAMENTO",
    destinoReal: null, cfg, futuro,
  });
  const chegadaPorto = volta.fim;
  const entrega = futuro(new Date(chegadaPorto.getTime() + ctx.filaEntregaHoras * HORA));
  const trechos = [
    ...ida.trechos.map((t, i) => (i === 0 ? { ...t, hipotetico } : t)),
    { etapa: "No local de carregamento", horas: ctx.tempoFabricaHoras, fonte: ctx.fonteTempoFabrica, amostras: ctx.amostrasFabrica, inicio: chegadaFabrica, fim: saidaFabrica, real: Boolean(c.saidaFabricaEm) },
    ...volta.trechos,
    { etapa: "Fila / gate na entrega", horas: ctx.filaEntregaHoras, inicio: chegadaPorto, fim: entrega, real: false },
  ];
  return resultadoDoCiclo(c, { hipotetico, coleta, chegadaFabrica, saidaFabrica, chegadaPorto, entrega, trechos, marcos: [...ida.marcos, ...volta.marcos] }, cfg);
}

// Tipo de Operação sem local de operação (coleta de cheio, transferência): retirada → paradas →
// entrega, sem tempo de fábrica. Sem estadia; previsões de chegada/saída do carregamento vazias.
function estimarDireto(c, ctx, agora, cfg) {
  const faltando = [];
  if (!c.portoRetiradaId) faltando.push("local de retirada");
  if (!c.portoEntregaId) faltando.push("local de entrega");
  if (!faltando.length && (ctx?.kmDireto === null || ctx?.kmDireto === undefined)) faltando.push("distância retirada → entrega (confira as coordenadas)");
  if (faltando.length) return { disponivel: false, faltando };
  const hipotetico = !c.coletadoEm;
  const futuro = (d) => maisTarde(d, agora);
  const coleta = c.coletadoEm ? new Date(c.coletadoEm) : futuro(c.coletaProgramadaEm ? new Date(c.coletaProgramadaEm) : agora);
  const perna = percorrerPerna({
    inicio: coleta, kmTotal: ctx.kmDireto, fonteTotal: ctx.fonteDireto, paradas: ctx.paradasDireto, trechos: ctx.trechosDireto,
    nomes: { origem: "Retirada", origemCurto: "Retirada", destino: "entrega" }, carga: null, fase: "ANTES_CARREGAMENTO",
    destinoReal: null, cfg, futuro,
  });
  const chegadaPorto = perna.fim;
  const entrega = futuro(new Date(chegadaPorto.getTime() + ctx.filaEntregaHoras * HORA));
  const trechos = [
    ...perna.trechos.map((t, i) => (i === 0 ? { ...t, hipotetico } : t)),
    { etapa: "Fila / gate na entrega", horas: ctx.filaEntregaHoras, inicio: chegadaPorto, fim: entrega, real: false },
  ];
  return resultadoDoCiclo(c, { hipotetico, coleta, chegadaFabrica: null, saidaFabrica: null, chegadaPorto, entrega, trechos, marcos: perna.marcos }, cfg);
}

function resultadoDoCiclo(c, { hipotetico, coleta, chegadaFabrica, saidaFabrica, chegadaPorto, entrega, trechos: lista, marcos }, cfg) {
  // Free time contado como em calcularDemurrage: dia do início = dia 1. Início e fim seguem as
  // etapas do Tipo de Operação (padrão: coleta → entrega), com o horário real ou o previsto.
  const previsto = { COLETADO: coleta, NA_FABRICA: chegadaFabrica, EM_OPERACAO: chegadaFabrica, LIBERADO: saidaFabrica, SAIU_FABRICA: saidaFabrica, ENTREGUE_PORTO: entrega };
  const quando = (status) => (c[CAMPO_DATA_STATUS[status]] ? new Date(c[CAMPO_DATA_STATUS[status]]) : previsto[status] ?? null);
  const inicioFt = quando(c.fluxo?.freeTimeInicio ?? "COLETADO") ?? coleta;
  const fimFt = quando(c.fluxo?.freeTimeFim ?? "ENTREGUE_PORTO") ?? entrega;
  const diaColeta = inicioDoDiaBrasilia(inicioFt).getTime();
  const vencimento = new Date(diaColeta + c.freeTimeDias * DIA - 1);
  const folgaHoras = (vencimento - fimFt) / HORA;
  const diasUsados = Math.floor((inicioDoDiaBrasilia(fimFt).getTime() - diaColeta) / DIA) + 1;
  const diasDemurragePrevistos = Math.max(0, diasUsados - c.freeTimeDias);

  const deadline = c.deadline ? new Date(c.deadline) : null;
  const folgaDeadlineHoras = deadline ? (deadline - entrega) / HORA : null;
  const cicloHoras = (entrega - coleta) / HORA;

  const trechos = lista.map((t) => ({ ...t, km: arred(t.km), horas: arred(t.horas ?? (t.fim - t.inicio) / HORA), duracaoHoras: arred((t.fim - t.inicio) / HORA) }));

  return {
    disponivel: true,
    hipotetico,
    // Coleta usada na simulação (programada ou agora) — só quando ainda não coletado.
    coletaSimulada: hipotetico ? coleta : null,
    trechos,
    // Passagem pelas paradas do trajeto (ex.: Ponto Fiscal): previsão ou horário real.
    paradas: marcos,
    previsaoChegadaFabrica: chegadaFabrica,
    previsaoSaidaFabrica: saidaFabrica,
    previsaoChegadaPorto: chegadaPorto,
    previsaoEntrega: entrega,
    cicloHoras: arred(cicloHoras),
    vencimentoFreeTime: vencimento,
    folgaHoras: arred(folgaHoras),
    diasDemurragePrevistos,
    custoPrevisto: Math.round(diasDemurragePrevistos * Number(c.valorDiaria) * 100) / 100,
    moeda: c.moeda,
    folgaDeadlineHoras: arred(folgaDeadlineHoras),
    // Programado com deadline: coletar até esta hora para entregar a tempo (mantendo o mesmo ciclo).
    limiteColeta: hipotetico && deadline ? new Date(deadline.getTime() - cicloHoras * HORA) : null,
    riscoDemurrage: nivelRisco(folgaHoras, cfg.riscoFolgaHoras),
    riscoDeadline: deadline ? nivelRisco(folgaDeadlineHoras, cfg.riscoFolgaHoras) : null,
  };
}
