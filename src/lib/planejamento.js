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
export function planoDaPrevisao(previsao, agora = new Date(), c = {}) {
  return {
    geradoEm: agora.toISOString(),
    COLETADO: new Date(c.coletaProgramadaEm ?? previsao.trechos[0].inicio).toISOString(),
    NA_FABRICA: new Date(previsao.previsaoChegadaFabrica).toISOString(),
    SAIU_FABRICA: new Date(previsao.previsaoSaidaFabrica).toISOString(),
    ENTREGUE_PORTO: new Date(previsao.previsaoEntrega).toISOString(),
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
