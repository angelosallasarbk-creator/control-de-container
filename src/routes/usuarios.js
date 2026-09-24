import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { requireRole, PERMISSOES } from "../lib/auth.js";
import { registrarLog } from "../lib/auditoria.js";
import { texto, id as validarId, umDe } from "../lib/validacao.js";

export const usuariosRouter = Router();
usuariosRouter.use(requireRole(...PERMISSOES.administrar));

const PERFIS = ["ADMIN", "SUPERVISOR", "OPERADOR", "VISUALIZACAO"];
const SELECT = { id: true, email: true, nome: true, perfil: true, ativo: true, criadoEm: true };
const SENHA_MIN = 8;

function validarSenha(senha) {
  if (!senha || String(senha).length < SENHA_MIN) throw erroHttp(400, `A senha deve ter pelo menos ${SENHA_MIN} caracteres.`);
  return String(senha);
}

usuariosRouter.get("/", asyncHandler(async (_req, res) => {
  res.json(await prisma.usuario.findMany({ select: SELECT, orderBy: { nome: "asc" } }));
}));

usuariosRouter.post("/", asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const email = texto(b.email, "E-mail", { obrigatorio: true, max: 160 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw erroHttp(400, "E-mail inválido.");
  const dados = {
    email,
    nome: texto(b.nome, "Nome", { obrigatorio: true, max: 120 }),
    perfil: umDe(b.perfil, PERFIS, "Perfil", { obrigatorio: true }),
    senhaHash: await bcrypt.hash(validarSenha(b.senha), 10),
  };
  const criado = await prisma.usuario.create({ data: dados, select: SELECT }).catch((err) => {
    if (err.code === "P2002") throw erroHttp(409, "Já existe um usuário com esse e-mail.");
    throw err;
  });
  await registrarLog({ usuarioEmail: req.usuario.email, acao: "CRIAR", entidade: "Usuario", entidadeId: criado.id, descricao: `Usuário criado: ${email} (${dados.perfil})` });
  res.status(201).json(criado);
}));

usuariosRouter.patch("/:id", asyncHandler(async (req, res) => {
  const usuarioId = validarId(req.params.id);
  const antes = await prisma.usuario.findUnique({ where: { id: usuarioId }, select: SELECT });
  if (!antes) throw erroHttp(404, "Usuário não encontrado.");
  const b = req.body ?? {};
  const dados = {};
  if ("nome" in b) dados.nome = texto(b.nome, "Nome", { obrigatorio: true, max: 120 });
  if ("perfil" in b) dados.perfil = umDe(b.perfil, PERFIS, "Perfil", { obrigatorio: true });
  if ("ativo" in b) dados.ativo = Boolean(b.ativo);
  if (b.senha) dados.senhaHash = await bcrypt.hash(validarSenha(b.senha), 10);

  // Evita o administrador se trancar fora do sistema.
  if (antes.email === req.usuario.email && (dados.ativo === false || (dados.perfil && dados.perfil !== "ADMIN"))) {
    throw erroHttp(400, "Você não pode desativar nem remover o perfil de administrador da sua própria conta.");
  }
  const depois = await prisma.usuario.update({ where: { id: usuarioId }, data: dados, select: SELECT });
  const { senhaHash: _s, ...semSenha } = dados;
  await registrarLog({
    usuarioEmail: req.usuario.email,
    acao: "ALTERAR",
    entidade: "Usuario",
    entidadeId: usuarioId,
    descricao: `Usuário alterado: ${antes.email}${dados.senhaHash ? " (senha redefinida)" : ""}`,
    dadosAntes: antes,
    dadosDepois: { ...antes, ...semSenha },
  });
  res.json(depois);
}));
