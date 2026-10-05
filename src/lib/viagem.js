// Viagem (v3.8): o mesmo caminhão levando mais de um container. Cada container continua com o seu
// QR e o seu trajeto (podem ter sido coletados em lugares diferentes e ficar em pontos diferentes);
// a viagem só agrupa o rastreamento: um SMS de posição por viagem e a posição recebida gravada em
// todos. Quem monta é o motorista/transportador, confirmando na leitura do 2º QR ("vai no mesmo
// caminhão?"). O container sai da viagem ao chegar a um ponto (carregamento ou entrega), ao ser
// encerrado ou se outra pessoa assumir o rastreamento; com menos de 2 containers, ela termina.
import { prisma } from "./prisma.js";
import { erroHttp } from "./asyncHandler.js";
import { registrarLog } from "./auditoria.js";
import { STATUS_ENCERRADOS } from "./prazos.js";

// Em movimento (entre pontos): onde faz sentido estar numa viagem.
export const STATUS_EM_TRANSITO = ["COLETADO", "SAIU_FABRICA"];
// Chegou a um ponto (ou terminou): sai da viagem.
const STATUS_FORA_DA_VIAGEM = ["PROGRAMADO", "NA_FABRICA", "EM_OPERACAO", "LIBERADO", ...STATUS_ENCERRADOS];

const mesmoResponsavel = (a, b) =>
  (a.rastreioMotoristaId ?? null) === (b.rastreioMotoristaId ?? null) && (a.rastreioResponsavelId ?? null) === (b.rastreioResponsavelId ?? null);

/** Participação ativa do container numa viagem (ou null). */
export function participacaoAtiva(containerId, cliente = prisma) {
  return cliente.viagemContainer.findFirst({
    where: { containerId, saiuEm: null, viagem: { encerradaEm: null } },
    include: { viagem: true },
  });
}

/** Participações ativas de vários containers numa consulta só (varredura em lote): Map containerId → participação. */
export async function participacoesAtivas(containerIds, cliente = prisma) {
  const lista = containerIds.length
    ? await cliente.viagemContainer.findMany({ where: { containerId: { in: containerIds }, saiuEm: null, viagem: { encerradaEm: null } }, include: { viagem: true } })
    : [];
  return new Map(lista.map((p) => [p.containerId, p]));
}

/** Ids dos outros containers da viagem ativa deste (mesmo responsável pelo rastreamento). */
export async function companheirosDeViagem(containerId) {
  const p = await participacaoAtiva(containerId);
  if (!p) return [];
  const outros = await prisma.viagemContainer.findMany({
    where: { viagemId: p.viagemId, saiuEm: null, containerId: { not: containerId } },
    select: { containerId: true },
  });
  return outros.map((o) => o.containerId);
}

/** Viagem ativa do container para a ficha/QR: { id, criadaEm, placa, containers: [{ id, numero, status }] } ou null. */
export async function viagemDoContainer(containerId) {
  const p = await participacaoAtiva(containerId);
  if (!p) return null;
  const membros = await prisma.viagemContainer.findMany({
    where: { viagemId: p.viagemId, saiuEm: null },
    include: { container: { select: { id: true, numero: true, status: true } } },
    orderBy: { entrouEm: "asc" },
  });
  return { id: p.viagemId, criadaEm: p.viagem.criadaEm, placa: p.viagem.placa, containers: membros.map((m) => m.container) };
}

const quem = (req) => (req.usuario?.motoristaId ? { rastreioMotoristaId: req.usuario.motoristaId } : { rastreioResponsavelId: req.usuario?.id ?? null, rastreioMotoristaId: null });

/**
 * Sugestões da pergunta "vai no mesmo caminhão?": outros containers em trânsito sob o rastreamento
 * de quem está lendo o QR, que ainda não estão na mesma viagem deste.
 */
export async function sugestoesDeViagem(container, req) {
  if (!container || !STATUS_EM_TRANSITO.includes(container.status)) return [];
  const eu = quem(req);
  if (!eu.rastreioMotoristaId && !eu.rastreioResponsavelId) return [];
  if (!mesmoResponsavel(container, { rastreioResponsavelId: null, ...eu })) return [];
  const juntos = new Set(await companheirosDeViagem(container.id));
  const outros = await prisma.container.findMany({
    where: { ...eu, id: { not: container.id }, status: { in: STATUS_EM_TRANSITO } },
    select: { id: true, numero: true, status: true },
    orderBy: { id: "asc" },
    take: 10,
  });
  return outros.filter((o) => !juntos.has(o.id));
}

/**
 * Junta os containers na mesma viagem (cria, ou entra na viagem ativa de algum deles). Todos
 * precisam estar em trânsito e sob o rastreamento de quem confirma.
 */
export async function juntarNaViagem({ containerIds, req, agora = new Date() }) {
  const ids = [...new Set(containerIds.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length < 2) throw erroHttp(400, "Informe os containers que vão no mesmo caminhão.");
  const eu = quem(req);
  const containers = await prisma.container.findMany({
    where: { id: { in: ids } },
    select: { id: true, numero: true, status: true, placa: true, rastreioMotoristaId: true, rastreioResponsavelId: true },
  });
  if (containers.length !== ids.length) throw erroHttp(404, "Container não encontrado.");
  for (const c of containers) {
    if (!STATUS_EM_TRANSITO.includes(c.status)) throw erroHttp(409, `O container ${c.numero} não está em trânsito (registre a coleta antes).`);
    if (!mesmoResponsavel(c, { rastreioResponsavelId: null, ...eu })) throw erroHttp(409, `O container ${c.numero} não está registrado por você — leia o QR dele primeiro.`);
  }
  return prisma.$transaction(async (tx) => {
    const ativas = await tx.viagemContainer.findMany({ where: { containerId: { in: ids }, saiuEm: null, viagem: { encerradaEm: null } }, select: { viagemId: true, containerId: true } });
    let viagemId = ativas[0]?.viagemId;
    if (!viagemId) {
      const v = await tx.viagem.create({
        data: { motoristaId: eu.rastreioMotoristaId ?? null, usuarioId: eu.rastreioResponsavelId ?? null, placa: containers.find((c) => c.placa)?.placa ?? null, criadaEm: agora, criadaPor: req.usuario.email },
      });
      viagemId = v.id;
    }
    // Quem estava em outra viagem sai dela (passa para esta).
    const emOutra = ativas.filter((a) => a.viagemId !== viagemId).map((a) => a.containerId);
    if (emOutra.length) await tx.viagemContainer.updateMany({ where: { containerId: { in: emOutra }, saiuEm: null }, data: { saiuEm: agora, motivoSaida: "passou para outra viagem" } });
    const ja = new Set(ativas.filter((a) => a.viagemId === viagemId).map((a) => a.containerId));
    const novos = ids.filter((id) => !ja.has(id));
    if (novos.length) await tx.viagemContainer.createMany({ data: novos.map((containerId) => ({ viagemId, containerId, entrouEm: agora })) });
    const numeros = containers.map((c) => c.numero).join(", ");
    for (const c of containers) {
      await registrarLog({ usuarioEmail: req.usuario.email, acao: "VIAGEM", entidade: "Container", entidadeId: c.id, descricao: `Container ${c.numero} na mesma viagem (caminhão) que: ${numeros}` }, tx);
    }
    return viagemId;
  });
}

/**
 * Mantém a viagem coerente com o container (chamado a cada sincronização): sai quem chegou a um
 * ponto, foi encerrado ou mudou de responsável; viagem com menos de 2 containers termina.
 */
export async function sincronizarViagem(container, agora = new Date(), { participacao } = {}) {
  // participacao: já carregada pela varredura em lote (null = não está em viagem) — sem consulta por container.
  const p = participacao === undefined ? await participacaoAtiva(container.id) : participacao;
  if (!p) return;
  const v = p.viagem;
  const trocouResponsavel = (v.motoristaId ?? null) !== (container.rastreioMotoristaId ?? null) || (v.usuarioId ?? null) !== (container.rastreioResponsavelId ?? null);
  const motivo = STATUS_FORA_DA_VIAGEM.includes(container.status) ? `chegou/encerrou (${container.status})` : trocouResponsavel ? "outra pessoa assumiu o rastreamento" : null;
  if (!motivo) return;
  await prisma.viagemContainer.updateMany({ where: { id: p.id, saiuEm: null }, data: { saiuEm: agora, motivoSaida: motivo } });
  const restantes = await prisma.viagemContainer.count({ where: { viagemId: v.id, saiuEm: null } });
  if (restantes < 2) {
    await prisma.viagemContainer.updateMany({ where: { viagemId: v.id, saiuEm: null }, data: { saiuEm: agora, motivoSaida: "viagem terminou (sobrou um container)" } });
    await prisma.viagem.updateMany({ where: { id: v.id, encerradaEm: null }, data: { encerradaEm: agora } });
  }
}
