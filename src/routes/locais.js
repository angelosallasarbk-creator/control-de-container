import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { requireRole, PERMISSOES } from "../lib/auth.js";
import { registrarLog } from "../lib/auditoria.js";
import { lerConfiguracao } from "../lib/configuracao.js";
import { sincronizarAlertas } from "../lib/alertas.js";
import { decimaisParaNumero, CAMPOS_LOCAL } from "../lib/containerView.js";
import { geocodificar, invalidarDistancias, obterDistancia, orsConfigurado } from "../lib/rotas.js";
import { estimarCiclo } from "../lib/estimativa.js";
import { configRodagem, montarContextos } from "../lib/previsao.js";
import { STATUS_ENCERRADOS } from "../lib/prazos.js";
import { texto, decimal, dataHora, id as validarId, umDe } from "../lib/validacao.js";

const TIPOS = ["FABRICA", "ARMAZEM", "PORTO"];
const ROTULO_TIPO = { FABRICA: "Fábrica", ARMAZEM: "Armazém", PORTO: "Porto/Terminal" };
const USO = { grupos: true, retiradas: true, carregamentos: true, entregas: true };

function validar(b, parcial) {
  const d = {};
  if (!parcial || "nome" in b) d.nome = texto(b.nome, "Nome", { obrigatorio: true, max: 120 });
  if (!parcial || "tipo" in b) d.tipo = umDe(b.tipo, TIPOS, "Tipo", { obrigatorio: true });
  if ("endereco" in b) d.endereco = texto(b.endereco, "Endereço", { max: 250 });
  if ("cidade" in b) d.cidade = texto(b.cidade, "Cidade", { max: 120 });
  if ("uf" in b) d.uf = texto(b.uf, "UF", { max: 2 })?.toUpperCase() ?? null;
  if ("latitude" in b) d.latitude = decimal(b.latitude, "Latitude", { min: -90, max: 90 });
  if ("longitude" in b) d.longitude = decimal(b.longitude, "Longitude", { min: -180, max: 180 });
  if ("filaHoras" in b) d.filaHoras = decimal(b.filaHoras, "Fila/gate (h)", { min: 0, max: 240 });
  if ("ativo" in b) d.ativo = Boolean(b.ativo);
  return d;
}

function validarCoordenadas(l) {
  const temLat = l.latitude !== null && l.latitude !== undefined;
  const temLon = l.longitude !== null && l.longitude !== undefined;
  if (temLat !== temLon) throw erroHttp(400, "Informe latitude e longitude juntas (ou nenhuma).");
  // Brasil fica aproximadamente entre as latitudes +6 e -34 e longitudes -74 e -34.
  if (temLat && (Number(l.latitude) > 6 || Number(l.latitude) < -34 || Number(l.longitude) > -34 || Number(l.longitude) < -74)) {
    throw erroHttp(400, "As coordenadas estão fora do Brasil. Confira se latitude e longitude não estão trocadas (ex.: latitude -23,95 e longitude -46,33).");
  }
}

const serializar = ({ _count, ...l }) => ({
  ...decimaisParaNumero(l, CAMPOS_LOCAL),
  emUso: _count ? Object.values(_count).reduce((s, n) => s + n, 0) : 0,
  temCoordenadas: l.latitude !== null && l.longitude !== null,
});

export const locaisRouter = Router();

locaisRouter.get("/", asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.ativos === "1") where.ativo = true;
  if (req.query.tipo) where.tipo = { in: String(req.query.tipo).split(",").map((t) => umDe(t, TIPOS, "Tipo")) };
  const locais = await prisma.local.findMany({ where, orderBy: [{ tipo: "asc" }, { nome: "asc" }], include: { _count: { select: USO } } });
  res.json(locais.map(serializar));
}));

// Busca de endereço (ORS). Não grava nada: a tela usa o resultado para preencher o formulário.
locaisRouter.get("/geocodificar", requireRole(...PERMISSOES.cadastros), asyncHandler(async (req, res) => {
  const q = texto(req.query.q, "Texto da busca", { obrigatorio: true, max: 200 });
  try {
    res.json(await geocodificar(q));
  } catch (err) {
    if (err.status === 503) throw err;
    console.error("Geocodificação falhou:", err.message);
    throw erroHttp(502, "O serviço de busca de endereço não respondeu. Tente de novo ou informe latitude/longitude manualmente.");
  }
}));

locaisRouter.post("/", requireRole(...PERMISSOES.cadastros), asyncHandler(async (req, res) => {
  const dados = validar(req.body ?? {}, false);
  validarCoordenadas(dados);
  const criado = await prisma.local.create({ data: dados, include: { _count: { select: USO } } }).catch((err) => {
    if (err.code === "P2002") throw erroHttp(409, "Já existe um local com esse nome.");
    throw err;
  });
  await registrarLog({ usuarioEmail: req.usuario.email, acao: "CRIAR", entidade: "Local", entidadeId: criado.id, descricao: `Local criado: ${criado.nome} (${ROTULO_TIPO[criado.tipo]})`, dadosDepois: criado });
  res.status(201).json(serializar(criado));
}));

locaisRouter.patch("/:id", requireRole(...PERMISSOES.cadastros), asyncHandler(async (req, res) => {
  const localId = validarId(req.params.id);
  const antes = await prisma.local.findUnique({ where: { id: localId }, include: { _count: { select: USO } } });
  if (!antes) throw erroHttp(404, "Local não encontrado.");
  const dados = validar(req.body ?? {}, true);
  validarCoordenadas({ latitude: "latitude" in dados ? dados.latitude : antes.latitude, longitude: "longitude" in dados ? dados.longitude : antes.longitude });
  if (dados.tipo && dados.tipo !== antes.tipo && antes._count.retiradas + antes._count.carregamentos + antes._count.entregas > 0) {
    throw erroHttp(409, "Este local já foi usado em containers; não é possível mudar o tipo dele.");
  }
  const mudouCoordenada =
    ("latitude" in dados && String(dados.latitude) !== String(antes.latitude === null ? null : Number(antes.latitude))) ||
    ("longitude" in dados && String(dados.longitude) !== String(antes.longitude === null ? null : Number(antes.longitude)));
  const mudouFila = "filaHoras" in dados && String(dados.filaHoras) !== String(antes.filaHoras === null ? null : Number(antes.filaHoras));

  const depois = await prisma.local.update({ where: { id: localId }, data: dados, include: { _count: { select: USO } } }).catch((err) => {
    if (err.code === "P2002") throw erroHttp(409, "Já existe um local com esse nome.");
    throw err;
  });
  if (mudouCoordenada) await invalidarDistancias(localId);
  await registrarLog({
    usuarioEmail: req.usuario.email, acao: "ALTERAR", entidade: "Local", entidadeId: localId,
    descricao: `Local alterado: ${depois.nome}${mudouCoordenada ? " (coordenadas mudaram: distâncias serão recalculadas)" : ""}`,
    dadosAntes: antes, dadosDepois: depois,
  });

  // Previsão dos containers ativos que passam por aqui muda com a coordenada ou a fila.
  if (mudouCoordenada || mudouFila) {
    const afetados = await prisma.container.findMany({
      where: { status: { notIn: STATUS_ENCERRADOS }, OR: [{ portoRetiradaId: localId }, { localCarregamentoId: localId }, { portoEntregaId: localId }] },
      select: { id: true, portoRetiradaId: true, localCarregamentoId: true, portoEntregaId: true },
    });
    for (const c of afetados) {
      if (mudouCoordenada) {
        await obterDistancia(c.portoRetiradaId, c.localCarregamentoId).catch(() => null);
        await obterDistancia(c.localCarregamentoId, c.portoEntregaId).catch(() => null);
      }
      await sincronizarAlertas(c.id);
    }
  }
  res.json(serializar(depois));
}));

locaisRouter.delete("/:id", requireRole(...PERMISSOES.cadastros), asyncHandler(async (req, res) => {
  const localId = validarId(req.params.id);
  const antes = await prisma.local.findUnique({ where: { id: localId }, include: { _count: { select: USO } } });
  if (!antes) throw erroHttp(404, "Local não encontrado.");
  if (serializar(antes).emUso > 0) throw erroHttp(409, "Este local está vinculado a Cliente/Fábrica ou a containers. Desative-o em vez de excluir.");
  await prisma.local.delete({ where: { id: localId } });
  await registrarLog({ usuarioEmail: req.usuario.email, acao: "EXCLUIR", entidade: "Local", entidadeId: localId, descricao: `Local excluído: ${antes.nome}`, dadosAntes: antes });
  res.status(204).end();
}));

// ---------- Simulação de ciclo (tela de novo container) ----------
// "Se coletar agora": distâncias do trajeto, tempo estimado e comparação com o free time.
export const rotasRouter = Router();

rotasRouter.get("/estimar", asyncHandler(async (req, res) => {
  const q = req.query;
  const portoRetiradaId = validarId(q.portoRetiradaId, "Porto de retirada");
  const localCarregamentoId = validarId(q.localCarregamentoId, "Local de carregamento");
  const portoEntregaId = validarId(q.portoEntregaId, "Porto de entrega");
  const [grupo, armador, config] = await Promise.all([
    q.grupoId ? prisma.grupoOperacao.findUnique({ where: { id: validarId(q.grupoId, "Cliente / Fábrica") } }) : null,
    q.armadorId ? prisma.armador.findUnique({ where: { id: validarId(q.armadorId, "Armador") } }) : null,
    lerConfiguracao(),
  ]);
  // Calcula/guarda as distâncias (pode chamar o serviço de rota) e usa o mesmo contexto da
  // previsão real — inclusive o tempo histórico no local de carregamento, quando houver.
  await obterDistancia(portoRetiradaId, localCarregamentoId);
  await obterDistancia(localCarregamentoId, portoEntregaId);
  const simulado = {
    id: 0, status: "PROGRAMADO", portoRetiradaId, localCarregamentoId, portoEntregaId,
    metaEstadiaHoras: grupo?.metaEstadiaHoras ?? 24,
    freeTimeDias: armador?.freeTimeDias ?? 0, valorDiaria: armador?.valorDiaria ?? 0, moeda: armador?.moeda ?? "USD",
    deadline: dataHora(q.deadline, "Deadline"),
  };
  const contexto = (await montarContextos([simulado], config)).get(0);
  res.json({ ...estimarCiclo(simulado, contexto, new Date(), configRodagem(config)), servicoRota: orsConfigurado() ? "ORS" : "ESTIMADA" });
}));
