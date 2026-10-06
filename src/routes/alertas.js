import { Router } from "express";
import { TipoAlerta } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { requirePermissao } from "../lib/permissoes.js";
import { registrarLog } from "../lib/auditoria.js";
import { texto, id as validarId, umDe } from "../lib/validacao.js";
import { SELECT_LOCAIS_ETAPAS, comRotulosEtapa } from "../lib/tiposLocal.js";

export const alertasRouter = Router();

const INCLUDE_CONTAINER = {
  container: { select: { id: true, numero: true, status: true, fluxo: true, grupo: { select: { cliente: true, fabrica: true } }, ...SELECT_LOCAIS_ETAPAS } },
};
const serializarAlerta = (a) => ({ ...a, container: comRotulosEtapa(a.container) });

// Ordenação aceita na lista paginada (chaves fixas, nunca texto livre). "asc" é o que a tela chama de
// crescente: crítico primeiro, mais antigo primeiro, pendentes (não reconhecidos) primeiro.
const ORDENS = {
  nivel: (d) => [{ nivel: d === "asc" ? "desc" : "asc" }],
  tipo: (d) => [{ tipo: d }],
  container: (d) => [{ container: { numero: d } }],
  grupo: (d) => [{ container: { grupo: { cliente: d } } }, { container: { grupo: { fabrica: d } } }],
  mensagem: (d) => [{ mensagem: d }],
  aberto: (d) => [{ abertoEm: d }],
  tratamento: (d) => [{ reconhecidoEm: { sort: d, nulls: d === "asc" ? "first" : "last" } }],
};
const LIMITE_PADRAO = 20;
const LIMITE_MAXIMO = 100;

// Sem `pagina`/`limite`: lista inteira (compatível com quem consome a API; encerrados: últimos 300).
// Com `pagina` ou `limite` (v3.11, usado pela tela): { itens, total, pagina, limite, totalPaginas }, com
// ordenação (`ordem`, `dir`) e página feitas no banco: com ~3.000 alertas abertos a lista inteira
// levava ~750 ms e 2 MB por chamada.
alertasRouter.get("/", asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.estado === "historico") where.chaveAberta = null;
  else where.chaveAberta = { not: null };
  // Todos os tipos do banco (lista fixa esquecia os novos: ENTREGA_A_DEFINIR, da v3.7, dava 400).
  if (req.query.tipo) where.tipo = umDe(req.query.tipo, Object.values(TipoAlerta), "Tipo");
  if (req.query.grupoId) where.container = { grupoId: validarId(req.query.grupoId, "Grupo") };

  if (req.query.pagina === undefined && req.query.limite === undefined) {
    const alertas = await prisma.alerta.findMany({
      where,
      include: INCLUDE_CONTAINER,
      orderBy: [{ nivel: "desc" }, { abertoEm: "desc" }],
      take: req.query.estado === "historico" ? 300 : undefined,
    });
    return res.json(alertas.map(serializarAlerta));
  }

  const chave = req.query.ordem ?? "nivel";
  if (!ORDENS[chave]) throw erroHttp(400, `Ordenação inválida. Use: ${Object.keys(ORDENS).join(", ")}.`);
  const dir = req.query.dir === "desc" ? "desc" : "asc";
  const limite = Math.min(LIMITE_MAXIMO, Math.max(1, Number.parseInt(req.query.limite, 10) || LIMITE_PADRAO));
  const total = await prisma.alerta.count({ where });
  const totalPaginas = Math.max(1, Math.ceil(total / limite));
  const pagina = Math.min(totalPaginas, Math.max(1, Number.parseInt(req.query.pagina, 10) || 1));
  const alertas = await prisma.alerta.findMany({
    where,
    include: INCLUDE_CONTAINER,
    // Desempate estável: a página não "pula" entre uma chamada e outra.
    orderBy: [...ORDENS[chave](dir), { abertoEm: "desc" }, { id: "desc" }],
    skip: (pagina - 1) * limite,
    take: limite,
  });
  res.json({ itens: alertas.map(serializarAlerta), total, pagina, limite, totalPaginas });
}));

// Consultado pela tela a cada poucos segundos para o sino e o aviso de novos alertas críticos.
// v3.9: só o que o sino precisa, sem carregar o container de cada alerta.
// v3.11: contagens no banco em vez de ler todos os alertas abertos (com ~3.000 por organização eram
// 176 KB e uma leitura de todas as linhas a cada poucos segundos de cada navegador). A lista dos
// críticos não reconhecidos vem limitada aos 50 mais novos; `ultimoCriticoNaoReconhecidoId` (o maior id)
// é o que a tela usa para saber se apareceu um crítico novo (ids só crescem).
const ABERTOS = { chaveAberta: { not: null } };
alertasRouter.get("/resumo", asyncHandler(async (_req, res) => {
  const [total, criticos, naoReconhecidos, criticosNaoReconhecidos] = await Promise.all([
    prisma.alerta.count({ where: ABERTOS }),
    prisma.alerta.count({ where: { ...ABERTOS, nivel: "CRITICO" } }),
    prisma.alerta.count({ where: { ...ABERTOS, reconhecidoEm: null } }),
    prisma.alerta.findMany({
      where: { ...ABERTOS, nivel: "CRITICO", reconhecidoEm: null },
      select: { id: true, containerId: true, tipo: true, nivel: true },
      orderBy: { id: "desc" },
      take: 50,
    }),
  ]);
  res.json({
    total,
    criticos,
    naoReconhecidos,
    ultimoCriticoNaoReconhecidoId: criticosNaoReconhecidos[0]?.id ?? 0,
    criticosNaoReconhecidos,
  });
}));

alertasRouter.post("/:id/reconhecer", requirePermissao("containers.operar"), asyncHandler(async (req, res) => {
  const alertaId = validarId(req.params.id);
  const acaoTomada = texto(req.body?.acaoTomada, "Ação tomada", { obrigatorio: true, max: 1000 });
  const alerta = await prisma.alerta.findUnique({ where: { id: alertaId }, include: INCLUDE_CONTAINER });
  if (!alerta) throw erroHttp(404, "Alerta não encontrado.");
  if (alerta.reconhecidoEm) throw erroHttp(409, `Este alerta já foi reconhecido por ${alerta.reconhecidoPor}.`);
  const atualizado = await prisma.alerta.update({
    where: { id: alertaId },
    data: { reconhecidoEm: new Date(), reconhecidoPor: req.usuario.email, acaoTomada },
    include: INCLUDE_CONTAINER,
  });
  await registrarLog({
    usuarioEmail: req.usuario.email,
    acao: "RECONHECER_ALERTA",
    entidade: "Alerta",
    entidadeId: alertaId,
    descricao: `Alerta ${alerta.tipo}/${alerta.nivel} do container ${alerta.container.numero} reconhecido: ${acaoTomada}`,
  });
  res.json(serializarAlerta(atualizado));
}));
