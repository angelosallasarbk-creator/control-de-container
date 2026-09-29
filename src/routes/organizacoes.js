// Organizações (clientes) — só o administrador da plataforma (perfil PLATAFORMA). Ele cria o
// cliente e o primeiro administrador dele; NÃO enxerga containers nem dados operacionais (as
// contagens abaixo são só números, lidos em modo sistema).
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { registrarLog } from "../lib/auditoria.js";
import { texto, id as validarId } from "../lib/validacao.js";
import { comoSistema } from "../lib/tenant.js";
import { criarOrganizacao } from "../lib/organizacoes.js";

export const organizacoesRouter = Router();

organizacoesRouter.use((req, _res, next) => {
  if (req.usuario?.perfil !== "PLATAFORMA") return next(erroHttp(403, "Só o administrador da plataforma gerencia organizações."));
  next();
});

async function listar() {
  const orgs = await prisma.organizacao.findMany({ orderBy: { nome: "asc" } });
  const contar = (modelo, extra = {}) =>
    comoSistema(() => prisma[modelo].groupBy({ by: ["organizacaoId"], where: extra, _count: true }))
      .then((l) => new Map(l.map((x) => [x.organizacaoId, x._count])));
  const [usuarios, containers, ativos] = await Promise.all([
    contar("usuario"),
    contar("container"),
    contar("container", { status: { notIn: ["ENTREGUE_PORTO", "CANCELADO"] } }),
  ]);
  return orgs.map((o) => ({ ...o, usuarios: usuarios.get(o.id) ?? 0, containers: containers.get(o.id) ?? 0, containersAtivos: ativos.get(o.id) ?? 0 }));
}

organizacoesRouter.get("/", asyncHandler(async (_req, res) => {
  res.json(await listar());
}));

organizacoesRouter.post("/", asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const nome = texto(b.nome, "Nome da organização", { obrigatorio: true, max: 120 });
  const admin = {
    nome: texto(b.adminNome, "Nome do administrador", { obrigatorio: true, max: 120 }),
    email: texto(b.adminEmail, "E-mail do administrador", { obrigatorio: true, max: 160 })?.toLowerCase(),
    senha: String(b.adminSenha ?? ""),
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin.email)) throw erroHttp(400, "E-mail do administrador inválido.");
  if (admin.senha.length < 8) throw erroHttp(400, "A senha do administrador precisa ter pelo menos 8 caracteres.");
  const { org } = await criarOrganizacao({ nome, admin, criadoPor: req.usuario.email });
  await registrarLog({ usuarioEmail: req.usuario.email, acao: "CRIAR", entidade: "Organizacao", entidadeId: org.id, descricao: `Organização criada: ${nome} (administrador ${admin.email})` });
  res.status(201).json((await listar()).find((o) => o.id === org.id));
}));

// Renomear e ativar/desativar (desativada: os usuários dela não entram; nada é apagado).
organizacoesRouter.patch("/:id", asyncHandler(async (req, res) => {
  const id = validarId(req.params.id);
  const antes = await prisma.organizacao.findUnique({ where: { id } });
  if (!antes) throw erroHttp(404, "Organização não encontrada.");
  const b = req.body ?? {};
  const dados = {};
  if ("nome" in b) dados.nome = texto(b.nome, "Nome da organização", { obrigatorio: true, max: 120 });
  if ("ativo" in b) dados.ativo = Boolean(b.ativo);
  const depois = await prisma.organizacao.update({ where: { id }, data: dados }).catch((err) => {
    if (err.code === "P2002") throw erroHttp(409, "Já existe uma organização com esse nome.");
    throw err;
  });
  await registrarLog({
    usuarioEmail: req.usuario.email, acao: "ALTERAR", entidade: "Organizacao", entidadeId: id,
    descricao: `Organização ${antes.nome}${dados.nome && dados.nome !== antes.nome ? ` renomeada para ${dados.nome}` : ""}${"ativo" in dados && dados.ativo !== antes.ativo ? (dados.ativo ? " reativada" : " desativada") : ""}`,
  });
  res.json((await listar()).find((o) => o.id === depois.id));
}));
