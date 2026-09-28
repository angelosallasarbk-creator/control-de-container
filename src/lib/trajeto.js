// Trajeto do container com pontos de parada (ex.: Ponto Fiscal) e registro de passagem.
// Trajeto = lista ordenada de pontos: RETIRADA (primeiro) → paradas → CARREGAMENTO → paradas →
// ENTREGA (último). A posição de cada parada em relação ao carregamento define a fase
// (ANTES_CARREGAMENTO / APOS_CARREGAMENTO). A passagem é um marco: não muda o status do container.
import { prisma } from "./prisma.js";
import { erroHttp } from "./asyncHandler.js";
import { registrarLog } from "./auditoria.js";
import { STATUS_ENCERRADOS } from "./prazos.js";
import { ordenarParadas, tempoParadaDoLocal, SELECT_LOCAL_PARADA } from "./rotas.js";

const PAPEIS = ["RETIRADA", "CARREGAMENTO", "ENTREGA", "PARADA"];
const FUNCAO_DO_PAPEL = { RETIRADA: "RETIRADA_ENTREGA", ENTREGA: "RETIRADA_ENTREGA", CARREGAMENTO: "CARREGAMENTO", PARADA: "PARADA" };
const NOME_DO_PAPEL = { RETIRADA: "Local de retirada", CARREGAMENTO: "Local de carregamento", ENTREGA: "Local de entrega", PARADA: "Ponto de parada" };
const FASES_NA_ETAPA = { COLETADO: "ANTES_CARREGAMENTO", SAIU_FABRICA: "APOS_CARREGAMENTO" };

export const SELECT_PARADA = {
  id: true, localId: true, fase: true, ordem: true, passouEm: true, registradoPor: true, origemRegistro: true,
  local: { select: SELECT_LOCAL_PARADA },
};

export const serializarParadas = (paradas = []) =>
  ordenarParadas(paradas).map((p) => ({
    id: p.id, localId: p.localId, fase: p.fase, ordem: p.ordem, passouEm: p.passouEm, registradoPor: p.registradoPor, origemRegistro: p.origemRegistro,
    nome: p.local?.nome, cidade: p.local?.cidade, uf: p.local?.uf,
    // Ponto de Carregamento usado como parada aparece com esse rótulo (não "Fábrica"/"Armazém").
    tipo: p.local?.tipo?.funcao === "PARADA" ? p.local.tipo.nome : "Ponto de Carregamento",
    tempoParadaHoras: tempoParadaDoLocal(p.local),
  }));

/**
 * Valida a lista de pontos da tela "Editar trajeto" contra o container atual.
 * pontos: [{ papel, localId, paradaId? }] na ordem do trajeto.
 */
export async function validarTrajeto(pontos, container) {
  if (!Array.isArray(pontos) || pontos.length < 3) throw erroHttp(400, "O trajeto precisa de retirada, carregamento e entrega.");
  if (pontos.length > 30) throw erroHttp(400, "Trajeto com pontos demais (máximo 30).");
  const papeis = pontos.map((p) => String(p?.papel ?? "").toUpperCase());
  if (papeis.some((p) => !PAPEIS.includes(p))) throw erroHttp(400, "Ponto do trajeto com papel inválido.");
  if (papeis[0] !== "RETIRADA") throw erroHttp(400, "O trajeto começa pelo local de retirada.");
  if (papeis.at(-1) !== "ENTREGA") throw erroHttp(400, "O trajeto termina no local de entrega.");
  for (const fixo of ["RETIRADA", "CARREGAMENTO", "ENTREGA"]) {
    if (papeis.filter((p) => p === fixo).length !== 1) throw erroHttp(400, `O trajeto precisa de um único ${NOME_DO_PAPEL[fixo].toLowerCase()}.`);
  }
  const idxCarregamento = papeis.indexOf("CARREGAMENTO");

  const ids = pontos.map((p, i) => {
    const n = Number(p?.localId);
    if (!Number.isInteger(n) || n <= 0) throw erroHttp(400, `${NOME_DO_PAPEL[papeis[i]]} (posição ${i + 1}): escolha o local.`);
    return n;
  });
  const locais = new Map((await prisma.local.findMany({ where: { id: { in: ids } }, include: { tipo: true } })).map((l) => [l.id, l]));
  // Pontos de Carregamento marcados como "pode ser ponto de parada" (o local deles vale como parada).
  const locaisDeGrupoParada = new Set((await prisma.grupoOperacao.findMany({
    where: { podeSerParada: true, ativo: true, localId: { in: ids } }, select: { localId: true },
  })).map((g) => g.localId));
  const atuais = new Map((container.paradas ?? []).map((p) => [p.id, p]));
  const usados = new Set([container.portoRetiradaId, container.localCarregamentoId, container.portoEntregaId, ...[...atuais.values()].map((p) => p.localId)]);
  const vistosParada = new Set();
  const resultado = { paradas: [] };
  const ordemNaFase = { ANTES_CARREGAMENTO: 0, APOS_CARREGAMENTO: 0 };

  pontos.forEach((p, i) => {
    const papel = papeis[i];
    const local = locais.get(ids[i]);
    const rotulo = `${NOME_DO_PAPEL[papel]} (posição ${i + 1})`;
    if (!local) throw erroHttp(400, `${rotulo}: local não encontrado.`);
    const serveComoParada = papel === "PARADA" && locaisDeGrupoParada.has(local.id);
    if (local.tipo.funcao !== FUNCAO_DO_PAPEL[papel] && !serveComoParada) {
      throw erroHttp(400, `${rotulo}: "${local.nome}" é do tipo ${local.tipo.nome} — não serve como ${NOME_DO_PAPEL[papel].toLowerCase()}${papel === "PARADA" ? " (marque \"Pode ser ponto de parada\" no Ponto de Carregamento dele)" : ""}.`);
    }
    if (!local.ativo && !usados.has(local.id)) throw erroHttp(400, `${rotulo}: o local "${local.nome}" está inativo.`);
    if (papel === "RETIRADA") resultado.portoRetiradaId = local.id;
    else if (papel === "CARREGAMENTO") resultado.localCarregamentoId = local.id;
    else if (papel === "ENTREGA") resultado.portoEntregaId = local.id;
    else {
      if (vistosParada.has(local.id)) throw erroHttp(400, `O ponto "${local.nome}" aparece mais de uma vez no trajeto.`);
      if (local.id === ids[idxCarregamento]) throw erroHttp(400, `"${local.nome}" já é o local de carregamento deste container — não pode ser também uma parada.`);
      vistosParada.add(local.id);
      const fase = i < idxCarregamento ? "ANTES_CARREGAMENTO" : "APOS_CARREGAMENTO";
      const paradaId = p.paradaId ? Number(p.paradaId) : null;
      const atual = paradaId ? atuais.get(paradaId) : null;
      if (paradaId && !atual) throw erroHttp(400, `${rotulo}: parada não pertence a este container.`);
      if (atual?.passouEm && (atual.localId !== local.id || atual.fase !== fase)) {
        throw erroHttp(409, `"${local.nome}" já tem a passagem registrada: não pode trocar de local nem de lado do carregamento. Desfaça a passagem antes.`);
      }
      resultado.paradas.push({ id: atual?.id ?? null, localId: local.id, fase, ordem: ordemNaFase[fase]++ });
    }
  });
  // Parada com passagem registrada não pode ser tirada do trajeto.
  const mantidas = new Set(resultado.paradas.map((p) => p.id).filter(Boolean));
  const removidaComPassagem = [...atuais.values()].find((p) => p.passouEm && !mantidas.has(p.id));
  if (removidaComPassagem) throw erroHttp(409, "Uma parada removida já tem a passagem registrada. Desfaça a passagem antes de tirá-la do trajeto.");
  return resultado;
}

const descreverTrajeto = (nomes) => nomes.join(" → ");

/** Grava o trajeto validado (dentro da transação de quem chama) e devolve a descrição antes/depois. */
export async function gravarTrajeto(tx, container, t, usuarioEmail) {
  const nomes = async (seq) => {
    const locais = new Map((await tx.local.findMany({ where: { id: { in: seq.filter(Boolean) } }, select: { id: true, nome: true } })).map((l) => [l.id, l.nome]));
    return seq.map((id) => locais.get(id) ?? "—");
  };
  const seqDe = (c, paradas) => {
    const ord = ordenarParadas(paradas);
    return [c.portoRetiradaId, ...ord.filter((p) => p.fase === "ANTES_CARREGAMENTO").map((p) => p.localId), c.localCarregamentoId, ...ord.filter((p) => p.fase === "APOS_CARREGAMENTO").map((p) => p.localId), c.portoEntregaId];
  };
  const antes = descreverTrajeto(await nomes(seqDe(container, container.paradas ?? [])));

  await tx.container.update({
    where: { id: container.id },
    data: { portoRetiradaId: t.portoRetiradaId, localCarregamentoId: t.localCarregamentoId, portoEntregaId: t.portoEntregaId },
  });
  const manter = t.paradas.filter((p) => p.id).map((p) => p.id);
  await tx.paradaContainer.deleteMany({ where: { containerId: container.id, id: { notIn: manter } } });
  for (const p of t.paradas) {
    if (p.id) await tx.paradaContainer.update({ where: { id: p.id }, data: { localId: p.localId, fase: p.fase, ordem: p.ordem } });
    else await tx.paradaContainer.create({ data: { containerId: container.id, localId: p.localId, fase: p.fase, ordem: p.ordem } });
  }
  const depois = descreverTrajeto(await nomes(seqDe(t, t.paradas)));
  await registrarLog({
    usuarioEmail, acao: "TRAJETO", entidade: "Container", entidadeId: container.id,
    descricao: `Container ${container.numero}: trajeto alterado — antes: ${antes} | agora: ${depois}`,
  }, tx);
  return { antes, depois };
}

/** Próxima parada pendente na fase em que o container está (para o QR sugerir a passagem). */
export function proximaParada(container, paradas) {
  const fase = FASES_NA_ETAPA[container.status];
  if (!fase) return null;
  return ordenarParadas(paradas).find((p) => p.fase === fase && !p.passouEm) ?? null;
}

/**
 * Registra a passagem por uma parada. Regras: container ativo; paradas antes do carregamento só
 * depois da coleta (e até a chegada ao carregamento); depois do carregamento, só após a saída.
 */
export async function registrarPassagem({ container, parada, passouEm, quem, origem, posicao = {} }) {
  if (STATUS_ENCERRADOS.includes(container.status)) throw erroHttp(409, `O container ${container.numero} já foi encerrado.`);
  if (parada.passouEm) throw erroHttp(409, `A passagem por "${parada.local.nome}" já foi registrada.`);
  if (passouEm.getTime() > Date.now() + 5 * 60 * 1000) throw erroHttp(400, "A data/hora da passagem não pode estar no futuro.");
  if (parada.fase === "ANTES_CARREGAMENTO") {
    if (!container.coletadoEm) throw erroHttp(409, "Registre a coleta antes da passagem por um ponto antes do carregamento.");
    if (passouEm < container.coletadoEm) throw erroHttp(400, "A passagem não pode ser antes da coleta.");
    if (container.chegadaFabricaEm && passouEm > container.chegadaFabricaEm) throw erroHttp(400, "A passagem (antes do carregamento) não pode ser depois da chegada ao carregamento.");
  } else {
    if (!container.saidaFabricaEm) throw erroHttp(409, "Este ponto fica depois do carregamento: registre a saída do carregamento antes.");
    if (passouEm < container.saidaFabricaEm) throw erroHttp(400, "A passagem não pode ser antes da saída do carregamento.");
  }
  const r = await prisma.paradaContainer.updateMany({
    where: { id: parada.id, passouEm: null },
    data: {
      passouEm, registradoPor: quem, origemRegistro: origem,
      latitude: posicao.latitude ?? null, longitude: posicao.longitude ?? null, precisaoM: posicao.precisaoM ?? null,
    },
  });
  if (r.count !== 1) throw erroHttp(409, `A passagem por "${parada.local.nome}" acabou de ser registrada por outra pessoa.`);
  await registrarLog({
    usuarioEmail: quem, acao: "PASSAGEM", entidade: "Container", entidadeId: container.id,
    descricao: `Container ${container.numero}: passagem por ${parada.local.nome} registrada (${origem === "QR" ? "pelo QR" : "pela ficha"})`,
  });
}
