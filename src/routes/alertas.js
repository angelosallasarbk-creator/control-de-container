import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { requireRole, PERMISSOES } from "../lib/auth.js";
import { registrarLog } from "../lib/auditoria.js";
import { texto, id as validarId, umDe } from "../lib/validacao.js";

export const alertasRouter = Router();

const INCLUDE_CONTAINER = {
  container: { select: { id: true, numero: true, status: true, grupo: { select: { cliente: true, fabrica: true } } } },
};

alertasRouter.get("/", asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.estado === "historico") where.chaveAberta = null;
  else where.chaveAberta = { not: null };
  if (req.query.tipo) where.tipo = umDe(req.query.tipo, ["ESTADIA", "DEMURRAGE", "DEADLINE", "TEMPERATURA", "SEM_LEITURA"], "Tipo");
  if (req.query.grupoId) where.container = { grupoId: validarId(req.query.grupoId, "Grupo") };
  const alertas = await prisma.alerta.findMany({
    where,
    include: INCLUDE_CONTAINER,
    orderBy: [{ nivel: "desc" }, { abertoEm: "desc" }],
    take: req.query.estado === "historico" ? 300 : undefined,
  });
  res.json(alertas);
}));

// Consultado pela tela a cada poucos segundos para o sino e o aviso de novos alertas críticos.
alertasRouter.get("/resumo", asyncHandler(async (_req, res) => {
  const abertos = await prisma.alerta.findMany({
    where: { chaveAberta: { not: null } },
    include: INCLUDE_CONTAINER,
    orderBy: { abertoEm: "desc" },
  });
  res.json({
    total: abertos.length,
    criticos: abertos.filter((a) => a.nivel === "CRITICO").length,
    naoReconhecidos: abertos.filter((a) => !a.reconhecidoEm).length,
    criticosNaoReconhecidos: abertos.filter((a) => a.nivel === "CRITICO" && !a.reconhecidoEm),
  });
}));

alertasRouter.post("/:id/reconhecer", requireRole(...PERMISSOES.operar), asyncHandler(async (req, res) => {
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
  res.json(atualizado);
}));
