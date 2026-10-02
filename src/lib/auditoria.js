import { prisma } from "./prisma.js";
import { comoSistema, contextoAtual } from "./tenant.js";

export const RETENCAO_DIAS = 365;

// `cliente` permite gravar dentro de uma transação (tx) junto com a alteração auditada.
export async function registrarLog(
  { usuarioEmail, acao, entidade, entidadeId, descricao, dadosAntes, dadosDepois, organizacaoId, motoristaId },
  cliente = prisma
) {
  // Ação de motorista (v3.3, item 20): o id dele vai junto do nome (texto livre digitado por ele).
  // Nas rotas do QR o id vem do contexto da requisição (lib/tenant.js).
  const idMotorista = motoristaId ?? contextoAtual()?.motoristaId ?? null;
  await cliente.logAuditoria.create({
    data: {
      // Numa organização o filtro automático preenche; em modo sistema vale o informado (ou nenhum).
      ...(organizacaoId !== undefined ? { organizacaoId } : {}),
      usuarioEmail,
      motoristaId: idMotorista,
      acao,
      entidade,
      entidadeId: entidadeId === undefined || entidadeId === null ? null : String(entidadeId),
      descricao,
      dadosAntes: dadosAntes ? JSON.stringify(dadosAntes) : null,
      dadosDepois: dadosDepois ? JSON.stringify(dadosDepois) : null,
    },
  });
}

// O sistema não apaga o log diretamente (v3.3, item 8): a função do banco roda com o dono das
// tabelas e recusa retenção menor que 365 dias.
export async function purgarLogsExpirados() {
  const [{ apagados }] = await comoSistema(() => prisma.$queryRaw`SELECT purgar_log_auditoria(${RETENCAO_DIAS}::int) AS apagados`);
  const n = Number(apagados);
  if (n > 0) console.log(`Auditoria: ${n} log(s) com mais de ${RETENCAO_DIAS} dias removido(s).`);
  return n;
}
