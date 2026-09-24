import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireRole, PERMISSOES } from "../lib/auth.js";
import { registrarLog } from "../lib/auditoria.js";
import { lerConfiguracao, salvarConfiguracao } from "../lib/configuracao.js";
import { executarVerificacao } from "../lib/verificador.js";
import { inteiro } from "../lib/validacao.js";

export const configuracaoRouter = Router();

configuracaoRouter.get("/", asyncHandler(async (_req, res) => {
  res.json(await lerConfiguracao());
}));

configuracaoRouter.put("/", requireRole(...PERMISSOES.administrar), asyncHandler(async (req, res) => {
  const antes = await lerConfiguracao();
  const intervaloLeituraMinutos = inteiro(req.body?.intervaloLeituraMinutos, "Intervalo máximo entre leituras (min)", {
    obrigatorio: true,
    min: 0,
    max: 10080,
  });
  const depois = await salvarConfiguracao({ intervaloLeituraMinutos });
  await registrarLog({ usuarioEmail: req.usuario.email, acao: "ALTERAR", entidade: "Configuracao", descricao: "Configurações alteradas", dadosAntes: antes, dadosDepois: depois });
  // Aplica a nova regra de "sem leitura" já, sem esperar o próximo ciclo do verificador.
  await executarVerificacao();
  res.json(depois);
}));

export const logsRouter = Router();
logsRouter.use(requireRole(...PERMISSOES.cadastros));

logsRouter.get("/", asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.entidade) where.entidade = String(req.query.entidade);
  if (req.query.entidadeId) where.entidadeId = String(req.query.entidadeId);
  const logs = await prisma.logAuditoria.findMany({
    where,
    orderBy: { criadoEm: "desc" },
    take: 300,
    select: { id: true, usuarioEmail: true, acao: true, entidade: true, entidadeId: true, descricao: true, criadoEm: true },
  });
  res.json(logs);
}));
