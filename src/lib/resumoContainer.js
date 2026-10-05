// Resumo do container (read model das listas, v3.10).
//
// Problema: montar a lista/painel exigia, para CADA container, as últimas 50 leituras e o contexto de
// rota (distâncias, filas, histórico) só para recalcular situação e previsão. O custo crescia com o
// número de containers e com o histórico, e a resposta carregava tudo de uma vez.
//
// Ideia: separar o que é CARO de calcular do que depende só do relógio.
//  - Cheio de dados (histórico de leituras, previsão de rota): calculado UMA vez pela sincronização
//    (lib/alertas.js, a cada mudança do container e na varredura) e gravado em Container.resumo, só
//    quando muda.
//  - Depende do relógio (horas restantes, diárias, custos, "sem leitura há…"): calculado na leitura,
//    a partir de datas absolutas (colunas do próprio container + o resumo). Nunca fica "velho".
// Resultado: a lista e o painel leem só colunas (sem leituras, sem contexto de rota) e a situação
// mostrada é a mesma da ficha, exceto a previsão de rota, que vale no momento da última sincronização.
import {
  calcularEntregaADefinir, calcularAtrasoColeta, calcularEstadia, calcularDemurrage, calcularDeadline,
  resumirLeituras, avaliarTemperaturaResumida, semaforo,
} from "./prazos.js";

export const VERSAO_RESUMO = 1;

// Campos da previsão que as listas usam (sem trechos/paradas, que só a ficha mostra): o resumo fica pequeno.
const CAMPOS_PREVISAO = [
  "disponivel", "parcial", "entregaADefinir", "hipotetico", "faltando", "previsaoEntrega", "previsaoChegadaFabrica",
  "previsaoSaidaFabrica", "cicloHoras", "folgaHoras", "folgaDeadlineHoras", "diasDemurragePrevistos", "custoPrevisto", "moeda",
  "riscoDemurrage", "riscoDeadline",
];
const podarPrevisao = (p) => (p ? Object.fromEntries(CAMPOS_PREVISAO.filter((k) => k in p).map((k) => [k, p[k]])) : null);

const NIVEL = { VERMELHO: 0, AMARELO: 1, VERDE: 2 };
export const NIVEL_DO_SEMAFORO = NIVEL;

/**
 * Situação do container para as listas: igual a calcularSituacao (prazos.js), mas a temperatura vem do
 * resumo (sem carregar leituras) e a previsão é a gravada na última sincronização.
 * cfg: configuração da organização (intervaloLeituraMinutos, atrasoColetaCriticoHoras).
 */
export function situacaoDoResumo(c, resumo, agora, cfg) {
  return {
    entregaADefinir: calcularEntregaADefinir(c),
    atrasoColeta: calcularAtrasoColeta(c, agora, cfg.atrasoColetaCriticoHoras),
    estadia: calcularEstadia(c, agora),
    demurrage: calcularDemurrage(c, agora),
    deadline: calcularDeadline(c, agora),
    temperatura: resumo?.temperatura ? avaliarTemperaturaResumida(c, resumo.temperatura, agora, cfg.intervaloLeituraMinutos) : null,
    previsao: resumo?.previsao ?? null,
  };
}

/**
 * O que a sincronização grava: o resumo (JSON) e as colunas de ordenação/filtro.
 * leiturasAsc: leituras recentes do container (da mais antiga para a mais recente); previsao: resultado
 * de estimarCiclo (ou null).
 */
export function construirResumo(c, leiturasAsc, previsao, agora, cfg) {
  const resumo = { v: VERSAO_RESUMO, temperatura: resumirLeituras(c, leiturasAsc), previsao: podarPrevisao(previsao) };
  const situacao = situacaoDoResumo(c, resumo, agora, cfg);
  const estadia = situacao.estadia;
  const demurrage = situacao.demurrage;
  const p = resumo.previsao;
  return {
    resumo,
    semaforoNivel: NIVEL[semaforo(situacao)] ?? NIVEL.VERDE,
    // Ordenar por "tempo que falta" = ordenar pela data em que vence (e só quando ainda corre).
    estadiaLimiteEm: estadia && !estadia.encerrada ? estadia.limite : null,
    demurrageVenceEm: demurrage && !demurrage.encerrada ? demurrage.vencimento : null,
    // Arredondadas como as colunas (1 casa): senão o "mudou?" acharia diferença a cada varredura.
    ultimaTemperatura: resumo.temperatura?.ultima ? uma(resumo.temperatura.ultima.temperatura) : null,
    previsaoFolgaHoras: p?.disponivel && !p.parcial && p.folgaHoras !== undefined && p.folgaHoras !== null ? uma(p.folgaHoras) : null,
  };
}
const uma = (n) => Math.round(Number(n) * 10) / 10;

// JSON com chaves em ordem fixa: o jsonb do banco reordena as chaves, então comparar texto cru não serve.
function canonico(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`).join(",")}}`;
}
const dec = (x) => (x === null || x === undefined ? null : Number(x));
const dt = (x) => (x ? new Date(x).getTime() : null);

/** O resumo gravado já é igual ao calculado? (evita gravar à toa a cada varredura) */
export function resumoMudou(atual, novo) {
  return (
    !atual.resumo ||
    canonico(atual.resumo) !== canonico(novo.resumo) ||
    atual.semaforoNivel !== novo.semaforoNivel ||
    dt(atual.estadiaLimiteEm) !== dt(novo.estadiaLimiteEm) ||
    dt(atual.demurrageVenceEm) !== dt(novo.demurrageVenceEm) ||
    dec(atual.ultimaTemperatura) !== dec(novo.ultimaTemperatura) ||
    dec(atual.previsaoFolgaHoras) !== dec(novo.previsaoFolgaHoras)
  );
}
