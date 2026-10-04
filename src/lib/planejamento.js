// Plano congelado do container: a primeira previsão completa (coleta, chegada, saída e entrega)
// é gravada uma única vez e nunca mais muda — é o "Planejado" da aba Etapas, comparado com o
// "Realizado" (o que foi registrado) e com o ETA (a previsão atualizada com os dados reais).
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

// Só gera o plano enquanto o container ainda não chegou ao carregamento: depois disso a
// previsão já traria dados reais e não seria mais um plano.
const STATUS_QUE_GERAM_PLANO = ["PROGRAMADO", "COLETADO"];

// Coleta planejada = a coleta programada, quando houver (mesmo que já tenha passado — senão o
// atraso ficaria escondido); sem ela, a coleta da simulação.
const iso = (d) => (d ? new Date(d).toISOString() : null);

export function planoDaPrevisao(previsao, agora = new Date(), c = {}) {
  return {
    geradoEm: agora.toISOString(),
    COLETADO: new Date(c.coletaProgramadaEm ?? previsao.trechos[0].inicio).toISOString(),
    NA_FABRICA: iso(previsao.previsaoChegadaFabrica),
    SAIU_FABRICA: iso(previsao.previsaoSaidaFabrica),
    ENTREGUE_PORTO: iso(previsao.previsaoEntrega),
    // Entrega a definir (v3.7): o plano congela a parte conhecida; a entrega entra quando for definida.
    entregaPendente: Boolean(previsao.parcial),
    // Passagem planejada por cada parada do trajeto (ex.: Ponto Fiscal), por id da parada.
    PARADAS: Object.fromEntries((previsao.paradas ?? []).filter((m) => m.previsao).map((m) => [m.paradaId, new Date(m.previsao).toISOString()])),
  };
}

export const deveGerarPlano = (c, previsao) => !c.planejamento && Boolean(previsao?.disponivel) && STATUS_QUE_GERAM_PLANO.includes(c.status);

// Grava o plano se ainda não existir. A condição "planejamento vazio" vai no WHERE: duas
// verificações simultâneas nunca sobrescrevem um plano já gravado.
export async function congelarPlanoSeFaltar(c, previsao, agora = new Date()) {
  if (!deveGerarPlano(c, previsao)) return false;
  const r = await prisma.container.updateMany({
    where: { id: c.id, planejamento: { equals: Prisma.DbNull } },
    data: { planejamento: planoDaPrevisao(previsao, agora, c) },
  });
  return r.count === 1;
}

/**
 * Entrega definida depois do plano (v3.7): completa SÓ a entrega planejada (e as paradas novas) com
 * a previsão do momento da definição — a parte já congelada não muda. Condição no WHERE: uma vez só.
 */
export async function completarPlanoSeFaltar(c, previsao, agora = new Date()) {
  if (!c.planejamento?.entregaPendente || !previsao?.disponivel || previsao.parcial || !previsao.previsaoEntrega) return false;
  const paradas = Object.fromEntries((previsao.paradas ?? []).filter((m) => m.previsao).map((m) => [m.paradaId, iso(m.previsao)]));
  const plano = {
    ...c.planejamento,
    ENTREGUE_PORTO: iso(previsao.previsaoEntrega),
    PARADAS: { ...paradas, ...(c.planejamento.PARADAS ?? {}) },
    entregaPendente: false,
    entregaPlanejadaEm: agora.toISOString(),
  };
  const r = await prisma.container.updateMany({
    where: { id: c.id, planejamento: { path: ["entregaPendente"], equals: true } },
    data: { planejamento: plano },
  });
  return r.count === 1;
}
