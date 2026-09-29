import { prisma } from "./prisma.js";
import { comoSistema } from "./tenant.js";

export const RETENCAO_DIAS = 365;

// `cliente` permite gravar dentro de uma transação (tx) junto com a alteração auditada.
export async function registrarLog(
  { usuarioEmail, acao, entidade, entidadeId, descricao, dadosAntes, dadosDepois, organizacaoId },
  cliente = prisma
) {
  await cliente.logAuditoria.create({
    data: {
      // Numa organização o filtro automático preenche; em modo sistema vale o informado (ou nenhum).
      ...(organizacaoId !== undefined ? { organizacaoId } : {}),
      usuarioEmail,
      acao,
      entidade,
      entidadeId: entidadeId === undefined || entidadeId === null ? null : String(entidadeId),
      descricao,
      dadosAntes: dadosAntes ? JSON.stringify(dadosAntes) : null,
      dadosDepois: dadosDepois ? JSON.stringify(dadosDepois) : null,
    },
  });
}

export async function purgarLogsExpirados() {
  const limite = new Date(Date.now() - RETENCAO_DIAS * 24 * 60 * 60 * 1000);
  const resultado = await comoSistema(() => prisma.logAuditoria.deleteMany({ where: { criadoEm: { lt: limite } } }));
  if (resultado.count > 0) {
    console.log(`Auditoria: ${resultado.count} log(s) com mais de ${RETENCAO_DIAS} dias removido(s).`);
  }
  return resultado.count;
}
