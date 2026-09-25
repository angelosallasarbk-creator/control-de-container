import { calcularSituacao, semaforo, ehReefer } from "./prazos.js";
import { estimarCiclo } from "./estimativa.js";
import { configRodagem } from "./previsao.js";
import { LIMITE_ATRASO_MIN } from "./leituras.js";
import { rotulosDasEtapas } from "./tiposLocal.js";

const CAMPOS_DECIMAIS = ["custoEstadiaPorHora", "valorDiaria", "setpoint", "tempMin", "tempMax"];
export const CAMPOS_LOCAL = ["latitude", "longitude", "filaHoras"];

// Prisma devolve Decimal, que vira string no JSON; o front trabalha com número.
export function decimaisParaNumero(obj, campos = CAMPOS_DECIMAIS) {
  const copia = { ...obj };
  for (const campo of campos) {
    if (copia[campo] !== null && copia[campo] !== undefined) copia[campo] = Number(copia[campo]);
  }
  return copia;
}

export function serializarLeitura(l) {
  const atrasoMin = Math.round((new Date(l.registradaEm) - new Date(l.lidaEm)) / 60000);
  return {
    ...decimaisParaNumero(l, ["temperatura", "latitude", "longitude"]),
    // Horário digitado muito antes de o dado chegar ao sistema (ver LIMITE_ATRASO_MIN).
    atrasoMin,
    lancadaComAtraso: atrasoMin > LIMITE_ATRASO_MIN,
  };
}

// leiturasAsc: leituras do container da mais antiga para a mais recente.
// ctxPrevisao: contexto de rota deste container (previsao.montarContextos); sem ele, sem previsão.
export function montarContainer(c, leiturasAsc, agora, config, ctxPrevisao = null) {
  const previsao = ctxPrevisao ? estimarCiclo(c, ctxPrevisao, agora, configRodagem(config)) : null;
  const situacao = calcularSituacao(c, leiturasAsc, agora, config.intervaloLeituraMinutos, previsao, config.atrasoColetaCriticoHoras);
  const { leituras: _l, ...resto } = c;
  return {
    ...decimaisParaNumero(resto),
    reefer: ehReefer(c.tipo),
    grupo: c.grupo ? decimaisParaNumero(c.grupo) : undefined,
    armador: c.armador ? decimaisParaNumero(c.armador) : undefined,
    produto: c.produto ? decimaisParaNumero(c.produto) : c.produto,
    portoRetirada: c.portoRetirada ? decimaisParaNumero(c.portoRetirada, CAMPOS_LOCAL) : c.portoRetirada,
    localCarregamento: c.localCarregamento ? decimaisParaNumero(c.localCarregamento, CAMPOS_LOCAL) : c.localCarregamento,
    portoEntrega: c.portoEntrega ? decimaisParaNumero(c.portoEntrega, CAMPOS_LOCAL) : c.portoEntrega,
    // Nome das etapas conforme o tipo dos locais (ex.: COLETADO → "Coleta ferroviária").
    rotulosEtapa: rotulosDasEtapas(c),
    situacao,
    semaforo: semaforo(situacao),
  };
}
