// Gestão dos MOTORISTAS (tela Motoristas): o Gestor da transportadora vê e gerencia só os da
// própria transportadora; quem tem "Editar cadastros" (administração/supervisão) vê todos.
// Bloquear derruba o acesso do celular na hora (sessões encerradas). Cadastro manual e por
// planilha deixam o motorista pré-cadastrado: no 1º acesso ele confirma o celular e aceita o termo.
import express, { Router } from "express";
import ExcelJS from "exceljs";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { tem, ehGestorTransportadora } from "../lib/permissoes.js";
import { registrarLog } from "../lib/auditoria.js";
import { id as validarId } from "../lib/validacao.js";
import { celularValido, validarDadosMotorista } from "../lib/acessoMotorista.js";
import { mascararCelular } from "../lib/rastreamento.js";
import { vincularMotorista } from "../lib/organizacoes.js";
import { normalizar } from "../lib/importacaoContainers.js";

export const motoristasRouter = Router();

// Escopo de quem pede: gestor = só a transportadora dele; administração = todas.
motoristasRouter.use((req, _res, next) => {
  if (ehGestorTransportadora(req)) {
    if (!req.usuario.transportadoraId) return next(erroHttp(403, "Seu usuário de gestor não está ligado a nenhuma transportadora. Fale com o administrador."));
    req.escopoTransportadora = req.usuario.transportadoraId;
    return next();
  }
  if (!tem(req, "cadastros.editar")) return next(erroHttp(403, "Seu usuário não pode gerenciar motoristas."));
  req.escopoTransportadora = null;
  // Cliente: só os motoristas vinculados à organização (registraram pelo QR dela ou ela cadastrou).
  req.escopoOrganizacao = req.usuario.organizacaoId;
  next();
});

const INCLUDE = {
  transportadora: { select: { id: true, nome: true, ativo: true } },
  _count: { select: { sessoes: { where: { revogadaEm: null } } } },
};
// Listas e respostas: celular mascarado (4 últimos dígitos). Completo só em GET /:id (editar) e na criação.
const serializar = ({ _count, celular, ...m }, { completo = false } = {}) => ({
  ...m, sessoesAtivas: _count?.sessoes ?? 0,
  celular: completo ? celular : mascararCelular(celular), celularFinal: String(celular ?? "").slice(-4),
});

const visivelParaOrganizacao = (org) => ({ organizacoes: { some: { organizacaoId: org } } });

async function buscarNoEscopo(req, id) {
  const m = await prisma.motorista.findFirst({
    where: { id, ...(req.escopoOrganizacao ? visivelParaOrganizacao(req.escopoOrganizacao) : {}) },
    include: { transportadora: true },
  });
  if (!m || (req.escopoTransportadora && m.transportadoraId !== req.escopoTransportadora)) throw erroHttp(404, "Motorista não encontrado.");
  return m;
}

// Transportadora do cadastro: gestor sempre a dele; administração escolhe.
async function transportadoraDoCadastro(req, valor) {
  const id = req.escopoTransportadora ?? Number(valor);
  if (!Number.isInteger(id) || id <= 0) throw erroHttp(400, "Escolha a transportadora.");
  // Cliente só usa transportadoras visíveis para ele.
  const t = await prisma.transportadora.findFirst({ where: { id, ...(req.escopoOrganizacao ? visivelParaOrganizacao(req.escopoOrganizacao) : {}) } });
  if (!t?.ativo) throw erroHttp(400, "Transportadora não encontrada ou inativa.");
  return t;
}

motoristasRouter.get("/", asyncHandler(async (req, res) => {
  const agora = new Date();
  const where = {};
  if (req.escopoTransportadora) where.transportadoraId = req.escopoTransportadora;
  else {
    Object.assign(where, visivelParaOrganizacao(req.escopoOrganizacao));
    if (req.query.transportadoraId) where.transportadoraId = validarId(req.query.transportadoraId, "Transportadora");
  }
  if (req.query.situacao === "bloqueados") where.bloqueado = true;
  if (req.query.situacao === "ativos") where.bloqueado = false;
  const motoristas = await prisma.motorista.findMany({
    where, orderBy: { nome: "asc" }, take: 5000,
    include: { transportadora: INCLUDE.transportadora, _count: { select: { sessoes: { where: { revogadaEm: null, expiraEm: { gt: agora } } } } } },
  });
  res.json(motoristas.map(serializar));
}));

// Cadastro manual (pré-cadastro): o motorista confirma o celular e aceita o termo no 1º acesso.
motoristasRouter.post("/", asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const celular = celularValido(b.celular);
  const t = await transportadoraDoCadastro(req, b.transportadoraId);
  const dados = validarDadosMotorista({ ...b, transportadoraId: t.id });
  const m = await prisma.motorista.create({ data: { ...dados, celular, criadoPor: req.usuario.email }, include: INCLUDE }).catch((err) => {
    // Não revela quem é (o motorista pode ser de outro cliente).
    if (err.code === "P2002") throw erroHttp(409, "Esse celular já tem cadastro na plataforma. O motorista aparece aqui quando registrar pelo QR uma carga de vocês.");
    throw err;
  });
  await vincularMotorista(m.id, req.usuario.organizacaoId);
  await registrarLog({ usuarioEmail: req.usuario.email, acao: "CRIAR", entidade: "Motorista", entidadeId: m.id, descricao: `Motorista pré-cadastrado: ${m.nome} (${t.nome})` });
  res.status(201).json(serializar(m, { completo: true }));
}));

// Editar: dados do motorista com o celular completo (só aqui e na criação).
motoristasRouter.get("/:id(\\d+)", asyncHandler(async (req, res) => {
  const m = await buscarNoEscopo(req, validarId(req.params.id));
  res.json(serializar(await prisma.motorista.findUnique({ where: { id: m.id }, include: INCLUDE }), { completo: true }));
}));

// Bloquear/desbloquear, corrigir nome, placa e celular.
motoristasRouter.patch("/:id", asyncHandler(async (req, res) => {
  const antes = await buscarNoEscopo(req, validarId(req.params.id));
  const b = req.body ?? {};
  const dados = {};
  if ("nome" in b || "placa" in b) {
    const v = validarDadosMotorista({ nome: b.nome ?? antes.nome, placa: "placa" in b ? b.placa : antes.placa }, { exigirTransportadora: false });
    dados.nome = v.nome;
    dados.placa = v.placa;
  }
  // Celular novo: o acesso pelo número antigo cai (sessões encerradas) e ele entra de novo pelo código SMS.
  if ("celular" in b) {
    const celular = celularValido(b.celular);
    if (celular !== antes.celular) dados.celular = celular;
  }
  const agora = new Date();
  if ("bloqueado" in b) {
    dados.bloqueado = Boolean(b.bloqueado);
    dados.bloqueadoEm = dados.bloqueado ? agora : null;
    dados.bloqueadoPor = dados.bloqueado ? req.usuario.email : null;
  }
  const m = await prisma.$transaction(async (tx) => {
    const m = await tx.motorista.update({ where: { id: antes.id }, data: dados, include: INCLUDE }).catch((err) => {
      if (err.code === "P2002") throw erroHttp(409, "Já existe um motorista com esse celular.");
      throw err;
    });
    // Bloqueio ou troca de celular derrubam o acesso na hora.
    if ((dados.bloqueado && !antes.bloqueado) || dados.celular) {
      await tx.sessaoMotorista.updateMany({ where: { motoristaId: m.id, revogadaEm: null }, data: { revogadaEm: agora, revogadaPor: req.usuario.email } });
    }
    return m;
  });
  const acao = "bloqueado" in b && dados.bloqueado !== antes.bloqueado ? (dados.bloqueado ? "bloqueado" : "desbloqueado") : "alterado";
  await registrarLog({
    usuarioEmail: req.usuario.email, acao: acao === "alterado" ? "ALTERAR" : acao === "bloqueado" ? "BLOQUEAR" : "DESBLOQUEAR", entidade: "Motorista", entidadeId: m.id,
    descricao: `Motorista ${m.nome} (${m.transportadora.nome}) ${acao}${dados.celular ? ` · celular trocado (final ${dados.celular.slice(-4)})` : ""}`,
  });
  res.json(serializar(m));
}));

motoristasRouter.get("/:id/sessoes", asyncHandler(async (req, res) => {
  const m = await buscarNoEscopo(req, validarId(req.params.id));
  const sessoes = await prisma.sessaoMotorista.findMany({
    where: { motoristaId: m.id }, orderBy: { criadaEm: "desc" }, take: 20,
    select: { id: true, criadaEm: true, ultimoUsoEm: true, expiraEm: true, revogadaEm: true, revogadaPor: true, dispositivo: true },
  });
  res.json(sessoes);
}));

// Celular perdido/trocado: encerra todos os acessos (o motorista entra de novo com código SMS).
motoristasRouter.post("/:id/encerrar-sessoes", asyncHandler(async (req, res) => {
  const m = await buscarNoEscopo(req, validarId(req.params.id));
  const r = await prisma.sessaoMotorista.updateMany({ where: { motoristaId: m.id, revogadaEm: null }, data: { revogadaEm: new Date(), revogadaPor: req.usuario.email } });
  await registrarLog({ usuarioEmail: req.usuario.email, acao: "ENCERRAR_SESSOES", entidade: "Motorista", entidadeId: m.id, descricao: `Acessos do motorista ${m.nome} encerrados (${r.count})` });
  res.json({ encerradas: r.count });
}));

// ---------- Planilha (pré-cadastro em lote) ----------

const COLUNAS = [
  { chave: "nome", titulo: "Nome", obrigatorio: true, largura: 32 },
  { chave: "celular", titulo: "Celular", obrigatorio: true, largura: 18 },
  { chave: "placa", titulo: "Placa", largura: 12 },
  { chave: "cpf", titulo: "CPF", largura: 16 },
  { chave: "transportadora", titulo: "Transportadora", largura: 30 },
];

motoristasRouter.get("/modelo", asyncHandler(async (req, res) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Motoristas", { views: [{ state: "frozen", ySplit: 1 }] });
  const cols = req.escopoTransportadora ? COLUNAS.filter((c) => c.chave !== "transportadora") : COLUNAS;
  ws.columns = cols.map((c) => ({ header: c.obrigatorio || (c.chave === "transportadora") ? `${c.titulo} *` : c.titulo, key: c.chave, width: c.largura }));
  ws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F5FA8" } };
  });
  ws.getColumn(2).numFmt = "@";
  ws.getColumn(4).numFmt = "@";
  if (!req.escopoTransportadora) {
    const nomes = (await prisma.transportadora.findMany({ where: { ativo: true, ...visivelParaOrganizacao(req.escopoOrganizacao) }, orderBy: { nome: "asc" }, select: { nome: true } })).map((t) => t.nome);
    const wl = wb.addWorksheet("Listas", { state: "hidden" });
    wl.getColumn(1).values = ["transportadoras", ...nomes];
    if (nomes.length) ws.dataValidations.add("E2:E5001", { type: "list", allowBlank: true, formulae: [`Listas!$A$2:$A$${nomes.length + 1}`] });
  }
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="modelo-motoristas.xlsx"');
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}));

const valor = (cell) => {
  let v = cell.value;
  if (v && typeof v === "object") v = v.result ?? v.text ?? (Array.isArray(v.richText) ? v.richText.map((r) => r.text).join("") : null);
  return v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim();
};

// Corpo = arquivo .xlsx. Sem ?confirmar=1 só confere; com, cadastra as linhas válidas.
motoristasRouter.post("/importar", express.raw({ type: () => true, limit: "5mb" }), asyncHandler(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw erroHttp(400, "Envie a planilha (.xlsx).");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(req.body);
  } catch {
    throw erroHttp(400, "Arquivo inválido. Envie a planilha Excel (.xlsx) baixada em \"Baixar modelo\".");
  }
  const ws = wb.getWorksheet("Motoristas") ?? wb.worksheets[0];
  const colunaDe = {};
  ws.getRow(1).eachCell((cell, i) => {
    const c = COLUNAS.find((x) => normalizar(x.titulo) === normalizar(String(valor(cell) ?? "").replace(/\*/g, "")));
    if (c) colunaDe[c.chave] = i;
  });
  if (!colunaDe.nome || !colunaDe.celular) throw erroHttp(400, "Colunas Nome e Celular não encontradas na linha 1. Use o modelo do sistema.");
  const transportadoras = await prisma.transportadora.findMany({ where: { ativo: true, ...(req.escopoOrganizacao ? visivelParaOrganizacao(req.escopoOrganizacao) : {}) }, select: { id: true, nome: true } });
  const linhas = [];
  const vistos = new Map();
  for (let n = 2; n <= ws.rowCount; n++) {
    const v = Object.fromEntries(COLUNAS.map((c) => [c.chave, colunaDe[c.chave] ? valor(ws.getRow(n).getCell(colunaDe[c.chave])) : null]));
    if (Object.values(v).every((x) => x === null)) continue;
    if (linhas.length >= 5000) throw erroHttp(400, "Máximo de 5.000 motoristas por arquivo.");
    const l = { linha: n, nome: v.nome, celular: v.celular };
    try {
      const celular = celularValido(v.celular);
      l.celular = celular;
      if (vistos.has(celular)) throw erroHttp(400, `Celular repetido na planilha (também na linha ${vistos.get(celular)}).`);
      vistos.set(celular, n);
      let transportadoraId = req.escopoTransportadora;
      if (!transportadoraId) {
        const t = transportadoras.find((x) => normalizar(x.nome) === normalizar(v.transportadora));
        if (!t) throw erroHttp(400, v.transportadora ? `Transportadora "${v.transportadora}" não encontrada.` : "Informe a transportadora.");
        transportadoraId = t.id;
      }
      l.dados = { ...validarDadosMotorista({ nome: v.nome, placa: v.placa, cpf: v.cpf, transportadoraId }), celular };
    } catch (err) {
      if (!err.status) throw err;
      l.erro = err.message;
    }
    linhas.push(l);
  }
  if (!linhas.length) throw erroHttp(400, "Nenhum motorista preenchido na planilha (a partir da linha 2).");
  const existentes = new Set((await prisma.motorista.findMany({ where: { celular: { in: linhas.filter((l) => l.dados).map((l) => l.dados.celular) } }, select: { celular: true } })).map((m) => m.celular));
  for (const l of linhas) if (l.dados && existentes.has(l.dados.celular)) l.erro = "Esse celular já tem cadastro na plataforma. O motorista aparece aqui quando registrar pelo QR uma carga de vocês.";

  let importados = 0;
  if (req.query.confirmar === "1") {
    for (const l of linhas.filter((x) => !x.erro)) {
      try {
        const novo = await prisma.motorista.create({ data: { ...l.dados, criadoPor: req.usuario.email } });
        await vincularMotorista(novo.id, req.usuario.organizacaoId);
        l.importado = true;
        importados++;
      } catch (err) {
        if (err.code !== "P2002") throw err;
        l.erro = "Esse celular já tem cadastro na plataforma. O motorista aparece aqui quando registrar pelo QR uma carga de vocês.";
      }
    }
    await registrarLog({
      usuarioEmail: req.usuario.email, acao: "IMPORTAR", entidade: "Motorista",
      descricao: `Motoristas por planilha: ${importados} pré-cadastrado(s)${linhas.filter((l) => l.erro).length ? `, ${linhas.filter((l) => l.erro).length} recusado(s)` : ""}`,
    });
  }
  res.json({
    confirmado: req.query.confirmar === "1", total: linhas.length, validos: linhas.filter((l) => !l.erro).length,
    comErro: linhas.filter((l) => l.erro).length, importados,
    linhas: linhas.map((l) => ({ linha: l.linha, nome: l.nome, celular: l.celular, erro: l.erro ?? null, importado: Boolean(l.importado) })),
  });
}));
