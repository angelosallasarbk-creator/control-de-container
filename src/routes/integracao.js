import { Router } from "express";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { requireRole, PERMISSOES } from "../lib/auth.js";
import { registrarLog } from "../lib/auditoria.js";
import { sincronizarAlertas } from "../lib/alertas.js";
import { normalizarNumero } from "../lib/iso6346.js";
import { ehReefer, STATUS_ENCERRADOS } from "../lib/prazos.js";
import { texto, id as validarId } from "../lib/validacao.js";

const MAX_LEITURAS_POR_ENVIO = 500;
const FOLGA_FUTURO_MS = 5 * 60 * 1000;

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

// ---------- Porta automática de temperatura (sem login; autenticada por token) ----------
// Qualquer fonte (sensor IoT, telemetria do armador, planilha convertida) envia leituras aqui.

export const integracaoPublicaRouter = Router();

integracaoPublicaRouter.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: "Limite de requisições excedido. Tente novamente em 1 minuto." },
  })
);

async function autenticarToken(req, _res, next) {
  try {
    const cabecalho = req.get("authorization") ?? "";
    const token = cabecalho.startsWith("Bearer ") ? cabecalho.slice(7).trim() : "";
    if (!token) throw erroHttp(401, "Token de integração ausente (cabeçalho Authorization: Bearer <token>).");
    const registro = await prisma.tokenIntegracao.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!registro?.ativo) throw erroHttp(401, "Token de integração inválido ou revogado.");
    req.tokenIntegracao = registro;
    next();
  } catch (err) {
    next(err);
  }
}

integracaoPublicaRouter.post("/temperaturas", autenticarToken, asyncHandler(async (req, res) => {
  const leituras = req.body?.leituras;
  if (!Array.isArray(leituras) || leituras.length === 0) {
    throw erroHttp(400, 'Envie { "leituras": [ { "container", "temperatura", "lidaEm" } ] }.');
  }
  if (leituras.length > MAX_LEITURAS_POR_ENVIO) throw erroHttp(400, `Máximo de ${MAX_LEITURAS_POR_ENVIO} leituras por envio.`);

  const numeros = [...new Set(leituras.map((l) => normalizarNumero(l?.container)))];
  const ativos = await prisma.container.findMany({
    where: { numero: { in: numeros }, status: { notIn: STATUS_ENCERRADOS } },
    select: { id: true, numero: true, tipo: true },
  });
  const porNumero = new Map(ativos.map((c) => [c.numero, c]));

  const resultados = [];
  const validas = [];
  leituras.forEach((l, indice) => {
    const numero = normalizarNumero(l?.container);
    const container = porNumero.get(numero);
    const temperatura = typeof l?.temperatura === "number" ? l.temperatura : Number(String(l?.temperatura ?? "").replace(",", "."));
    const lidaEm = new Date(l?.lidaEm);
    let motivo = null;
    if (!container) motivo = "Container não encontrado entre os ativos.";
    else if (!ehReefer(container.tipo)) motivo = "Container não é reefer.";
    else if (!Number.isFinite(temperatura) || temperatura < -60 || temperatura > 60) motivo = "Temperatura inválida (esperado entre -60 e 60).";
    else if (Number.isNaN(lidaEm.getTime())) motivo = "lidaEm inválido (use ISO 8601, ex.: 2026-09-24T10:00:00-03:00).";
    else if (lidaEm.getTime() > Date.now() + FOLGA_FUTURO_MS) motivo = "lidaEm está no futuro.";
    if (motivo) {
      resultados.push({ indice, container: numero, status: "rejeitada", motivo });
    } else {
      validas.push({ indice, numero, data: { containerId: container.id, temperatura, lidaEm, origem: "INTEGRACAO", fonte: req.tokenIntegracao.nome } });
    }
  });

  // Uma a uma para saber qual foi duplicada (reenvio da mesma leitura é aceito sem duplicar).
  const tocados = new Set();
  for (const v of validas) {
    try {
      await prisma.leituraTemperatura.create({ data: v.data });
      resultados.push({ indice: v.indice, container: v.numero, status: "gravada" });
      tocados.add(v.data.containerId);
    } catch (err) {
      if (err.code !== "P2002") throw err;
      resultados.push({ indice: v.indice, container: v.numero, status: "duplicada" });
    }
  }

  for (const containerId of tocados) await sincronizarAlertas(containerId);
  await prisma.tokenIntegracao.update({ where: { id: req.tokenIntegracao.id }, data: { ultimoUsoEm: new Date() } });

  const contar = (s) => resultados.filter((r) => r.status === s).length;
  const resumo = { gravadas: contar("gravada"), duplicadas: contar("duplicada"), rejeitadas: contar("rejeitada") };
  if (resumo.rejeitadas) console.warn(`Integração "${req.tokenIntegracao.nome}": ${resumo.rejeitadas} leitura(s) rejeitada(s).`);
  res.json({ ...resumo, resultados: resultados.sort((a, b) => a.indice - b.indice) });
}));

// ---------- Gestão dos tokens (ADMIN, com login) ----------

export const tokensRouter = Router();
tokensRouter.use(requireRole(...PERMISSOES.administrar));

tokensRouter.get("/", asyncHandler(async (_req, res) => {
  const tokens = await prisma.tokenIntegracao.findMany({
    orderBy: { criadoEm: "desc" },
    select: { id: true, nome: true, prefixo: true, ativo: true, criadoEm: true, criadoPor: true, ultimoUsoEm: true },
  });
  res.json(tokens);
}));

tokensRouter.post("/", asyncHandler(async (req, res) => {
  const nome = texto(req.body?.nome, "Nome da integração", { obrigatorio: true, max: 80 });
  const token = `cc_${crypto.randomBytes(24).toString("hex")}`;
  const criado = await prisma.tokenIntegracao.create({
    data: { nome, prefixo: token.slice(0, 10), tokenHash: hashToken(token), criadoPor: req.usuario.email },
  });
  await registrarLog({ usuarioEmail: req.usuario.email, acao: "CRIAR", entidade: "TokenIntegracao", entidadeId: criado.id, descricao: `Token de integração criado: ${nome}` });
  // O token em texto só é devolvido agora; no banco fica apenas o hash.
  res.status(201).json({ id: criado.id, nome, prefixo: criado.prefixo, token });
}));

tokensRouter.post("/:id/revogar", asyncHandler(async (req, res) => {
  const tokenId = validarId(req.params.id);
  const t = await prisma.tokenIntegracao.findUnique({ where: { id: tokenId } });
  if (!t) throw erroHttp(404, "Token não encontrado.");
  await prisma.tokenIntegracao.update({ where: { id: tokenId }, data: { ativo: false } });
  await registrarLog({ usuarioEmail: req.usuario.email, acao: "REVOGAR", entidade: "TokenIntegracao", entidadeId: tokenId, descricao: `Token de integração revogado: ${t.nome}` });
  res.status(204).end();
}));
