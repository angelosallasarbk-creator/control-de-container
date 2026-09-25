// Tipos de local (cadastro) e os nomes das etapas do container conforme o tipo do local.
export const FUNCOES = ["RETIRADA_ENTREGA", "CARREGAMENTO"];
export const ROTULO_FUNCAO = { RETIRADA_ENTREGA: "Retirada/entrega do container", CARREGAMENTO: "Carregamento (ovação)" };

// Rótulos exigidos por função (os da outra função ficam vazios).
export const ROTULOS_DA_FUNCAO = {
  RETIRADA_ENTREGA: { rotuloColeta: "Nome da etapa de coleta", rotuloEntrega: "Nome da etapa de entrega" },
  CARREGAMENTO: { rotuloChegada: "Nome da etapa de chegada", rotuloSaida: "Nome da etapa de saída" },
};

export const SELECT_TIPO = {
  select: { id: true, nome: true, funcao: true, rotuloColeta: true, rotuloEntrega: true, rotuloChegada: true, rotuloSaida: true, ativo: true },
};
// Para listas: só o necessário para nomear as etapas.
export const SELECT_LOCAIS_ETAPAS = {
  portoRetirada: { select: { tipo: { select: { rotuloColeta: true } } } },
  localCarregamento: { select: { tipo: { select: { rotuloChegada: true, rotuloSaida: true } } } },
  portoEntrega: { select: { tipo: { select: { rotuloEntrega: true } } } },
};

// Troca os locais parciais (só com o tipo, de SELECT_LOCAIS_ETAPAS) por "rotulosEtapa".
export function comRotulosEtapa({ portoRetirada, localCarregamento, portoEntrega, ...c }) {
  return { ...c, rotulosEtapa: rotulosDasEtapas({ portoRetirada, localCarregamento, portoEntrega }) };
}

/**
 * Nome das etapas que acontecem num local, conforme o tipo dele (ex.: COLETADO → "Coleta
 * ferroviária"). Etapa sem local definido fica de fora: a tela usa o nome genérico.
 */
export function rotulosDasEtapas(c) {
  const r = {
    COLETADO: c.portoRetirada?.tipo?.rotuloColeta,
    NA_FABRICA: c.localCarregamento?.tipo?.rotuloChegada,
    SAIU_FABRICA: c.localCarregamento?.tipo?.rotuloSaida,
    ENTREGUE_PORTO: c.portoEntrega?.tipo?.rotuloEntrega,
  };
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v));
}
