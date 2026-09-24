import { calcularSituacao, semaforo, ehReefer } from "./prazos.js";

const CAMPOS_DECIMAIS = ["custoEstadiaPorHora", "valorDiaria", "setpoint", "tempMin", "tempMax"];

// Prisma devolve Decimal, que vira string no JSON; o front trabalha com número.
export function decimaisParaNumero(obj, campos = CAMPOS_DECIMAIS) {
  const copia = { ...obj };
  for (const campo of campos) {
    if (copia[campo] !== null && copia[campo] !== undefined) copia[campo] = Number(copia[campo]);
  }
  return copia;
}

export function serializarLeitura(l) {
  return { ...l, temperatura: Number(l.temperatura) };
}

// leiturasAsc: leituras do container da mais antiga para a mais recente.
export function montarContainer(c, leiturasAsc, agora, config) {
  const situacao = calcularSituacao(c, leiturasAsc, agora, config.intervaloLeituraMinutos);
  const { leituras: _l, ...resto } = c;
  return {
    ...decimaisParaNumero(resto),
    reefer: ehReefer(c.tipo),
    grupo: c.grupo ? decimaisParaNumero(c.grupo) : undefined,
    armador: c.armador ? decimaisParaNumero(c.armador) : undefined,
    produto: c.produto ? decimaisParaNumero(c.produto) : c.produto,
    situacao,
    semaforo: semaforo(situacao),
  };
}
