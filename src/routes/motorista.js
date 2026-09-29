// API do MOTORISTA (sem usuário/senha): entrar pelo celular com código SMS e registrar pelo QR.
// Públicas: /codigo, /verificar, /cadastro. Com sessão de motorista: /eu, /sair e /qr/* — estas
// são as MESMAS rotas do QR da equipe (qrRouter), com o motorista no papel de Transportador.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import {
  pedirCodigo, verificarCodigo, concluirCadastro, abrirSessao, carregarMotorista, encerrarSessao,
  dadosPublicosMotorista, validarDadosMotorista, identidadeMotorista,
} from "../lib/acessoMotorista.js";
import { prisma } from "../lib/prisma.js";
import { registrarLog } from "../lib/auditoria.js";
import { qrRouter } from "./qr.js";
import { comOrganizacao, comoPlataforma, comoSistema } from "../lib/tenant.js";

export const motoristaRouter = Router();
// O motorista é da plataforma (sem organização). No QR, a organização vem da etiqueta lida.
motoristaRouter.use((_req, _res, next) => comoPlataforma(next));

const TOKEN_ETIQUETA = /^[A-Za-z0-9_-]{22}$/;
async function organizacaoDaEtiqueta(req) {
  const [, primeiro, segundo] = req.path.split("/");
  if (primeiro === "codigo" && segundo) {
    const codigo = `CC-${String(segundo).toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^CC/, "")}`;
    return (await comoSistema(() => prisma.etiquetaQR.findUnique({ where: { codigo }, select: { organizacaoId: true } })))?.organizacaoId ?? null;
  }
  const token = TOKEN_ETIQUETA.test(primeiro ?? "") ? primeiro : req.query.etiqueta;
  if (!token || !TOKEN_ETIQUETA.test(String(token))) return null;
  return (await comoSistema(() => prisma.etiquetaQR.findUnique({ where: { token: String(token) }, select: { organizacaoId: true } })))?.organizacaoId ?? null;
}
function naOrganizacaoDaEtiqueta(req, _res, next) {
  organizacaoDaEtiqueta(req).then((org) => (org ? comOrganizacao(org, next) : next())).catch(next);
}

const limitador = (limit, mensagem) => rateLimit({ windowMs: 15 * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false, message: { erro: mensagem } });
const limiteCodigo = limitador(10, "Muitos pedidos de código deste aparelho. Aguarde alguns minutos.");
const limiteVerificar = limitador(30, "Muitas tentativas. Aguarde alguns minutos.");

motoristaRouter.post("/codigo", limiteCodigo, asyncHandler(async (req, res) => {
  const r = await pedirCodigo({ celular: req.body?.celular, ip: req.ip });
  res.json({ mensagem: "Enviamos um código por SMS para o seu celular.", expiraEm: r.expiraEm, simulado: r.simulado });
}));

motoristaRouter.post("/verificar", limiteVerificar, asyncHandler(async (req, res) => {
  const r = await verificarCodigo({ celular: req.body?.celular, codigo: req.body?.codigo });
  if (r.motorista) {
    await abrirSessao(res, r.motorista, req);
    return res.json({ motorista: dadosPublicosMotorista(r.motorista) });
  }
  res.json(r); // precisaCadastro + comprovante + transportadoras (+ dados já importados pelo gestor)
}));

motoristaRouter.post("/cadastro", limiteVerificar, asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const motorista = await concluirCadastro({ comprovante: b.comprovante, dados: b });
  await abrirSessao(res, motorista, req);
  res.status(201).json({ motorista: dadosPublicosMotorista(motorista) });
}));

// ---------- Com sessão de motorista ----------
const comSessao = Router();
comSessao.use(carregarMotorista);

comSessao.get("/eu", (req, res) => res.json({ motorista: dadosPublicosMotorista(req.motorista) }));

// O motorista pode corrigir o nome e trocar a placa (troca de caminhão).
comSessao.patch("/eu", asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const { nome, placa } = validarDadosMotorista({ nome: b.nome ?? req.motorista.nome, placa: b.placa }, { exigirTransportadora: false });
  const m = await prisma.motorista.update({ where: { id: req.motorista.id }, data: { nome, placa }, include: { transportadora: true } });
  await registrarLog({ usuarioEmail: identidadeMotorista(m), acao: "ALTERAR", entidade: "Motorista", entidadeId: m.id, descricao: `Motorista ${m.nome} atualizou os próprios dados (placa ${placa ?? "—"})` });
  res.json({ motorista: dadosPublicosMotorista(m) });
}));

comSessao.post("/sair", asyncHandler(async (req, res) => {
  await encerrarSessao(req, res);
  res.status(204).end();
}));

comSessao.use("/qr", naOrganizacaoDaEtiqueta, qrRouter);

motoristaRouter.use(comSessao);
motoristaRouter.use((_req, _res, next) => next(erroHttp(404, "Rota não encontrada.")));
