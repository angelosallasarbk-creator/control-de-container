// Tipo de Operação e fluxo de etapas do container (v2.0).
// O motor de etapas continua o mesmo (status PROGRAMADO → COLETADO → NA_FABRICA → EM_OPERACAO →
// LIBERADO → SAIU_FABRICA → ENTREGUE_PORTO); cada Tipo de Operação escolhe QUAIS etapas usa, com
// que NOME, em que TIPO DE LOCAL e com quais PASSAGENS (paradas). Ao criar o container, o fluxo do
// tipo é copiado para Container.fluxo (como os prazos copiados dos cadastros): editar o tipo depois
// não muda containers já criados. Container.fluxo vazio = fluxo de exportação de sempre.
import { erroHttp } from "./asyncHandler.js";

export const FLUXO_PADRAO = ["PROGRAMADO", "COLETADO", "NA_FABRICA", "EM_OPERACAO", "LIBERADO", "SAIU_FABRICA", "ENTREGUE_PORTO"];
export const CAMPO_DATA_STATUS = {
  COLETADO: "coletadoEm", NA_FABRICA: "chegadaFabricaEm", EM_OPERACAO: "inicioOperacaoEm",
  LIBERADO: "liberadoEm", SAIU_FABRICA: "saidaFabricaEm", ENTREGUE_PORTO: "entreguePortoEm",
};
export const ACOES = ["COLETA", "CHEGADA", "INICIO_OPERACAO", "LIBERACAO", "SAIDA", "PASSAGEM", "ENTREGA"];
export const STATUS_DA_ACAO = {
  COLETA: "COLETADO", CHEGADA: "NA_FABRICA", INICIO_OPERACAO: "EM_OPERACAO", LIBERACAO: "LIBERADO", SAIDA: "SAIU_FABRICA", ENTREGA: "ENTREGUE_PORTO",
};
export const ROTULO_ACAO = {
  COLETA: "Coleta", CHEGADA: "Chegada ao local de operação", INICIO_OPERACAO: "Início da operação (ovação/desova)",
  LIBERACAO: "Liberação", SAIDA: "Saída do local de operação", PASSAGEM: "Passagem (ponto de parada)", ENTREGA: "Entrega",
};
const OPERACAO = ["CHEGADA", "INICIO_OPERACAO", "LIBERACAO", "SAIDA"];
const FUNCOES_LOCAL = ["RETIRADA_ENTREGA", "CARREGAMENTO", "PARADA"];

// ---------- Container ----------

/** Etapas (status) do container, na ordem, começando em PROGRAMADO. */
export const etapasDoContainer = (c) => (Array.isArray(c?.fluxo?.etapas) ? ["PROGRAMADO", ...c.fluxo.etapas] : FLUXO_PADRAO);
/** O fluxo tem local de operação (chegada/ovação/desova/saída)? Sem isso não há estadia. */
export const temOperacao = (c) => etapasDoContainer(c).includes("NA_FABRICA");
/** Datas que abrem e fecham o free time (demurrage) conforme o tipo de operação. */
export function camposFreeTime(c) {
  return {
    inicio: CAMPO_DATA_STATUS[c?.fluxo?.freeTimeInicio ?? "COLETADO"],
    fim: CAMPO_DATA_STATUS[c?.fluxo?.freeTimeFim ?? "ENTREGUE_PORTO"],
  };
}

// Regras de local por campo do container (tipo de local exigido): do fluxo, ou as de sempre.
const REGRA_PADRAO = {
  portoRetiradaId: { funcao: "RETIRADA_ENTREGA", tipoLocalId: null },
  localCarregamentoId: { funcao: "CARREGAMENTO", tipoLocalId: null },
  portoEntregaId: { funcao: "RETIRADA_ENTREGA", tipoLocalId: null },
};
export function regrasDeLocal(c) {
  if (!c?.fluxo?.regras) return REGRA_PADRAO;
  return { ...c.fluxo.regras, ...(temOperacao(c) ? {} : { localCarregamentoId: null }) };
}

/**
 * Confere se o local atende à regra do campo no fluxo. Devolve null (ok) ou o motivo.
 * regra null = o fluxo não usa esse local; { funcao } = qualquer tipo com essa função;
 * { tipoLocalId } = só esse tipo de local; ambos vazios = qualquer local.
 */
export function motivoLocalForaDaRegra(local, regra, nomeTipoExigido = null) {
  if (regra === null) return "este tipo de operação não usa esse local";
  if (!regra) return null;
  if (regra.tipoLocalId && local.tipoId !== regra.tipoLocalId) return `"${local.nome}" é do tipo ${local.tipo.nome}; este tipo de operação pede um local do tipo ${nomeTipoExigido ?? "definido no fluxo"}`;
  if (!regra.tipoLocalId && regra.funcao && local.tipo.funcao !== regra.funcao) return `"${local.nome}" é do tipo ${local.tipo.nome}`;
  return null;
}

// ---------- Tipo de Operação: validação do fluxo e cópia para o container ----------

/**
 * Valida as etapas de um Tipo de Operação (lista ordenada). Regras: começa na Coleta e termina na
 * Entrega (uma de cada); Chegada/Início/Liberação/Saída no máximo uma vez, na ordem, e Chegada e
 * Saída sempre em par; sem Passagem dentro do local de operação.
 */
export function validarEtapasFluxo(etapas) {
  if (!Array.isArray(etapas) || etapas.length < 2) throw erroHttp(400, "O fluxo precisa de pelo menos Coleta e Entrega.");
  if (etapas.length > 30) throw erroHttp(400, "Fluxo com etapas demais (máximo 30).");
  const lista = etapas.map((e, i) => {
    const acao = String(e?.acao ?? "").toUpperCase();
    if (!ACOES.includes(acao)) throw erroHttp(400, `Etapa ${i + 1}: ação inválida.`);
    const funcaoLocal = e?.funcaoLocal ? String(e.funcaoLocal) : null;
    if (funcaoLocal && !FUNCOES_LOCAL.includes(funcaoLocal)) throw erroHttp(400, `Etapa ${i + 1}: tipo de local inválido.`);
    const nome = e?.nome ? String(e.nome).trim().slice(0, 60) || null : null;
    const num = (v, rotulo) => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw erroHttp(400, `Etapa ${i + 1}: ${rotulo} inválido.`);
      return n;
    };
    return { acao, nome, funcaoLocal, tipoLocalId: num(e?.tipoLocalId, "tipo de local"), localSugeridoId: num(e?.localSugeridoId, "local sugerido") };
  });
  if (lista[0].acao !== "COLETA") throw erroHttp(400, "O fluxo começa pela Coleta.");
  if (lista.at(-1).acao !== "ENTREGA") throw erroHttp(400, "O fluxo termina na Entrega.");
  const principais = lista.filter((e) => e.acao !== "PASSAGEM");
  for (const acao of ["COLETA", "CHEGADA", "INICIO_OPERACAO", "LIBERACAO", "SAIDA", "ENTREGA"]) {
    if (principais.filter((e) => e.acao === acao).length > 1) throw erroHttp(400, `"${ROTULO_ACAO[acao]}" aparece mais de uma vez.`);
  }
  const ordem = principais.map((e) => FLUXO_PADRAO.indexOf(STATUS_DA_ACAO[e.acao]));
  if (ordem.some((v, i) => i && v <= ordem[i - 1])) throw erroHttp(400, "Etapas fora de ordem: Coleta → Chegada → Início da operação → Liberação → Saída → Entrega.");
  const tem = (a) => principais.some((e) => e.acao === a);
  if (OPERACAO.some(tem) && !(tem("CHEGADA") && tem("SAIDA"))) throw erroHttp(400, "Com etapas no local de operação, Chegada e Saída são obrigatórias.");
  const iCheg = lista.findIndex((e) => e.acao === "CHEGADA");
  const iSai = lista.findIndex((e) => e.acao === "SAIDA");
  if (iCheg >= 0 && lista.slice(iCheg, iSai).some((e) => e.acao === "PASSAGEM")) throw erroHttp(400, "Não há passagem dentro do local de operação (entre Chegada e Saída).");
  return lista;
}

/** Copia o fluxo do tipo para o container (Container.fluxo). tipo inclui `etapas` ordenadas. */
export function fluxoDoTipo(tipo) {
  const etapas = [...tipo.etapas].sort((a, b) => a.ordem - b.ordem);
  const principais = etapas.filter((e) => e.acao !== "PASSAGEM");
  const regra = (e) => (e ? { funcao: e.funcaoLocal ?? null, tipoLocalId: e.tipoLocalId ?? null } : null);
  const coleta = principais.find((e) => e.acao === "COLETA");
  const chegada = principais.find((e) => e.acao === "CHEGADA");
  const entrega = principais.find((e) => e.acao === "ENTREGA");
  const iCheg = etapas.findIndex((e) => e.acao === "CHEGADA");
  return {
    tipoId: tipo.id,
    tipo: tipo.nome,
    padrao: Boolean(tipo.padrao),
    etapas: principais.map((e) => STATUS_DA_ACAO[e.acao]),
    nomes: Object.fromEntries(principais.filter((e) => e.nome).map((e) => [STATUS_DA_ACAO[e.acao], e.nome])),
    freeTimeInicio: tipo.freeTimeInicio,
    freeTimeFim: tipo.freeTimeFim,
    regras: { portoRetiradaId: regra(coleta), localCarregamentoId: regra(chegada), portoEntregaId: regra(entrega) },
    sugeridos: { portoRetiradaId: coleta?.localSugeridoId ?? null, localCarregamentoId: chegada?.localSugeridoId ?? null, portoEntregaId: entrega?.localSugeridoId ?? null },
    // Passagens do fluxo (viram paradas do trajeto quando têm local sugerido).
    passagens: etapas
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.acao === "PASSAGEM")
      .map(({ e, i }) => ({ localId: e.localSugeridoId ?? null, fase: iCheg >= 0 && i > iCheg ? "APOS_CARREGAMENTO" : "ANTES_CARREGAMENTO" })),
  };
}

export const SELECT_TIPO_OPERACAO = { include: { etapas: { orderBy: { ordem: "asc" } } } };
