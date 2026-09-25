import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { Prisma } from "@prisma/client";
import { requirePermissao, CATALOGO_PERMISSOES, CHAVES, PADRAO_POR_PERFIL, permissoesEfetivas, ehPersonalizado } from "../lib/permissoes.js";
import { registrarLog } from "../lib/auditoria.js";
import { texto, id as validarId, umDe } from "../lib/validacao.js";

export const usuariosRouter = Router();
usuariosRouter.use(requirePermissao("administrar"));

const PERFIS = ["ADMIN", "SUPERVISOR", "OPERADOR", "VISUALIZACAO", "TRANSPORTADOR", "PORTARIA"];
const SELECT = { id: true, email: true, nome: true, perfil: true, ativo: true, criadoEm: true };
const SENHA_MIN = 8;

function validarSenha(senha) {
  if (!senha || String(senha).length < SENHA_MIN) throw erroHttp(400, `A senha deve ter pelo menos ${SENHA_MIN} caracteres.`);
  return String(senha);
}

// Usuário + permissões (efetivas, e se foge do padrão do perfil).
const comPermissoes = (u) => {
  const { permissoes, ...resto } = u;
  return { ...resto, permissoes: permissoesEfetivas(u), personalizado: ehPersonalizado(u) };
};

usuariosRouter.get("/", asyncHandler(async (_req, res) => {
  const usuarios = await prisma.usuario.findMany({ select: { ...SELECT, permissoes: true }, orderBy: { nome: "asc" } });
  res.json(usuarios.map(comPermissoes));
}));

// Catálogo de permissões e o padrão de cada perfil (tela Configurações → Perfis e permissões).
usuariosRouter.get("/permissoes/catalogo", (_req, res) => {
  res.json({ catalogo: CATALOGO_PERMISSOES, padroes: PADRAO_POR_PERFIL });
});

// Define as permissões de um usuário. `permissoes: null` = volta ao padrão do perfil.
usuariosRouter.put("/:id/permissoes", asyncHandler(async (req, res) => {
  const usuarioId = validarId(req.params.id);
  const antes = await prisma.usuario.findUnique({ where: { id: usuarioId }, select: { ...SELECT, permissoes: true } });
  if (!antes) throw erroHttp(404, "Usuário não encontrado.");
  if (antes.perfil === "ADMIN") throw erroHttp(400, "Administrador tem acesso total; as permissões dele não são configuráveis.");
  const pedido = req.body?.permissoes;
  let novas = null;
  if (pedido !== null && pedido !== undefined) {
    if (!Array.isArray(pedido)) throw erroHttp(400, "Envie a lista de permissões (ou null para usar o padrão do perfil).");
    const invalidas = pedido.filter((c) => !CHAVES.includes(c));
    if (invalidas.length) throw erroHttp(400, `Permissão desconhecida: ${invalidas.join(", ")}.`);
    novas = CHAVES.filter((c) => pedido.includes(c)); // ordem do catálogo, sem repetição
    // Igual ao padrão do perfil: grava como "padrão" (acompanha mudanças futuras do padrão).
    const padrao = PADRAO_POR_PERFIL[antes.perfil] ?? [];
    if (novas.length === padrao.length && novas.every((c) => padrao.includes(c))) novas = null;
  }
  const depois = await prisma.usuario.update({
    where: { id: usuarioId },
    data: { permissoes: novas === null ? Prisma.DbNull : novas },
    select: { ...SELECT, permissoes: true },
  });
  const nomes = (lista) => lista.map((c) => CATALOGO_PERMISSOES.find((p) => p.chave === c)?.nome ?? c);
  const antesEf = permissoesEfetivas(antes);
  const depoisEf = permissoesEfetivas(depois);
  const ganhou = depoisEf.filter((c) => !antesEf.includes(c));
  const perdeu = antesEf.filter((c) => !depoisEf.includes(c));
  await registrarLog({
    usuarioEmail: req.usuario.email,
    acao: "PERMISSOES",
    entidade: "Usuario",
    entidadeId: usuarioId,
    descricao:
      `Permissões de ${antes.email} ${novas === null ? "voltaram ao padrão do perfil" : "personalizadas"}` +
      (ganhou.length ? ` · liberou: ${nomes(ganhou).join(", ")}` : "") +
      (perdeu.length ? ` · retirou: ${nomes(perdeu).join(", ")}` : ""),
    dadosAntes: { permissoes: antesEf },
    dadosDepois: { permissoes: depoisEf },
  });
  res.json(comPermissoes(depois));
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
  const criado = await prisma.usuario.create({ data: dados, select: { ...SELECT, permissoes: true } }).catch((err) => {
    if (err.code === "P2002") throw erroHttp(409, "Já existe um usuário com esse e-mail.");
    throw err;
  });
  await registrarLog({ usuarioEmail: req.usuario.email, acao: "CRIAR", entidade: "Usuario", entidadeId: criado.id, descricao: `Usuário criado: ${email} (${dados.perfil})` });
  res.status(201).json(comPermissoes(criado));
}));

usuariosRouter.patch("/:id", asyncHandler(async (req, res) => {
  const usuarioId = validarId(req.params.id);
  const antes = await prisma.usuario.findUnique({ where: { id: usuarioId }, select: SELECT });
  if (!antes) throw erroHttp(404, "Usuário não encontrado.");
  const b = req.body ?? {};
  const dados = {};
  if ("nome" in b) dados.nome = texto(b.nome, "Nome", { obrigatorio: true, max: 120 });
  if ("perfil" in b) dados.perfil = umDe(b.perfil, PERFIS, "Perfil", { obrigatorio: true });
  // Trocar de perfil descarta a personalização: passa a valer o padrão do novo perfil.
  const trocouPerfil = dados.perfil && dados.perfil !== antes.perfil;
  if (trocouPerfil) dados.permissoes = Prisma.DbNull;
  if ("ativo" in b) dados.ativo = Boolean(b.ativo);
  if (b.senha) dados.senhaHash = await bcrypt.hash(validarSenha(b.senha), 10);

  // Evita o administrador se trancar fora do sistema.
  if (antes.email === req.usuario.email && (dados.ativo === false || (dados.perfil && dados.perfil !== "ADMIN"))) {
    throw erroHttp(400, "Você não pode desativar nem remover o perfil de administrador da sua própria conta.");
  }
  const depois = await prisma.usuario.update({ where: { id: usuarioId }, data: dados, select: { ...SELECT, permissoes: true } });
  const { senhaHash: _s, permissoes: _p, ...semSenha } = dados;
  await registrarLog({
    usuarioEmail: req.usuario.email,
    acao: "ALTERAR",
    entidade: "Usuario",
    entidadeId: usuarioId,
    descricao:
      `Usuário alterado: ${antes.email}${dados.senhaHash ? " (senha redefinida)" : ""}` +
      (trocouPerfil ? ` (perfil ${antes.perfil} → ${dados.perfil}; permissões voltaram ao padrão do perfil)` : ""),
    dadosAntes: antes,
    dadosDepois: { ...antes, ...semSenha },
  });
  res.json(comPermissoes(depois));
}));
