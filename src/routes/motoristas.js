// Gestão dos MOTORISTAS (tela Motoristas): o Gestor da transportadora vê e gerencia só os da
// própria transportadora vinculados ao cliente dele; quem tem "Editar cadastros" vê os do cliente.
// Bloqueio (v3.5): do gestor e da administração valem SÓ no cliente de quem bloqueou (o gestor é
// criado por um cliente — não pode afetar os outros). O bloqueio de toda a plataforma
// (Motorista.bloqueado) não é feito por cliente: só pela anonimização (LGPD). Nome, placa e celular só são editáveis aqui
// quando o motorista atende só este cliente — compartilhado, só ele mesmo (celular com SMS).
// Cadastro manual e por planilha deixam o motorista pré-cadastrado: no 1º acesso ele confirma o
// celular e aceita o termo.
import express, { Router } from "express";
import ExcelJS from "exceljs";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { tem, ehGestorTransportadora } from "../lib/permissoes.js";
import { registrarLog } from "../lib/auditoria.js";
import { id as validarId } from "../lib/validacao.js";
import { celularValido, validarDadosMotorista, identidadeMotorista } from "../lib/acessoMotorista.js";
import { mascararCelular } from "../lib/rastreamento.js";
import { vincularMotorista } from "../lib/organizacoes.js";
import { normalizar } from "../lib/importacaoContainers.js";

export const motoristasRouter = Router();

// Escopo de quem pede: gestor = só a transportadora dele; administração = todas.
motoristasRouter.use((req, _res, next) => {
  if (ehGestorTransportadora(req)) {
    if (!req.usuario.transportadoraId) return next(erroHttp(403, "Seu usuário de gestor não está ligado a nenhuma transportadora. Fale com o administrador."));
    req.escopoTransportadora = req.usuario.transportadoraId;
    // Gestor também só enxerga os motoristas vinculados ao cliente dele (v3.2, item 1).
    req.escopoOrganizacao = req.usuario.organizacaoId;
    return next();
  }
  if (!tem(req, "cadastros.editar")) return next(erroHttp(403, "Seu usuário não pode gerenciar motoristas."));
  req.escopoTransportadora = null;
  // Cliente: só os motoristas vinculados à organização (registraram pelo QR dela ou ela cadastrou).
  req.escopoOrganizacao = req.usuario.organizacaoId;
  next();
});

// Situação do motorista NESTE cliente (bloqueio por cliente) + em quantos clientes ele atua.
const incluir = (org) => ({
  transportadora: { select: { id: true, nome: true, ativo: true } },
  organizacoes: { where: { organizacaoId: org }, select: { bloqueado: true, bloqueadoEm: true } },
  _count: { select: { sessoes: { where: { revogadaEm: null } }, organizacoes: true } },
});
// CPF sempre mascarado (LGPD): só os 6 dígitos do meio, como no padrão de publicação do governo.
export const mascararCpf = (cpf) => (cpf ? `***.${String(cpf).slice(3, 6)}.${String(cpf).slice(6, 9)}-**` : null);
// Listas e respostas: celular mascarado (4 últimos dígitos). Completo só em GET /:id (editar) e na
// criação. Sem quem cadastrou/bloqueou (e-mail de pessoas de outros clientes — v3.2, item 1).
const serializar = ({ _count, celular, cpf, criadoPor, bloqueadoPor, organizacoes, ...m }, { completo = false } = {}) => {
  const aqui = organizacoes?.[0];
  return {
    ...m,
    cpf: mascararCpf(cpf),
    bloqueadoPelaTransportadora: m.bloqueado,
    bloqueadoNoCliente: Boolean(aqui?.bloqueado),
    bloqueado: m.bloqueado || Boolean(aqui?.bloqueado), // não registra para este cliente
    bloqueadoEm: aqui?.bloqueado ? aqui.bloqueadoEm : m.bloqueadoEm,
    compartilhado: (_count?.organizacoes ?? 1) > 1,
    sessoesAtivas: _count?.sessoes ?? 0,
    celular: completo ? celular : mascararCelular(celular), celularFinal: String(celular ?? "").slice(-4),
  };
};

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
  const where = visivelParaOrganizacao(req.escopoOrganizacao);
  if (req.escopoTransportadora) where.transportadoraId = req.escopoTransportadora;
  else if (req.query.transportadoraId) where.transportadoraId = validarId(req.query.transportadoraId, "Transportadora");
  const inc = incluir(req.escopoOrganizacao);
  const motoristas = await prisma.motorista.findMany({
    where, orderBy: { nome: "asc" }, take: 5000,
    include: { ...inc, _count: { select: { sessoes: { where: { revogadaEm: null, expiraEm: { gt: agora } } }, organizacoes: true } } },
  });
  let lista = motoristas.map((m) => serializar(m));
  if (req.query.situacao === "bloqueados") lista = lista.filter((m) => m.bloqueado);
  if (req.query.situacao === "ativos") lista = lista.filter((m) => !m.bloqueado);
  res.json(lista);
}));

// Cadastro manual (pré-cadastro): o motorista confirma o celular e aceita o termo no 1º acesso.
motoristasRouter.post("/", asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const celular = celularValido(b.celular);
  const t = await transportadoraDoCadastro(req, b.transportadoraId);
  const dados = validarDadosMotorista({ ...b, transportadoraId: t.id });
  const m = await prisma.motorista.create({ data: { ...dados, celular, criadoPor: req.usuario.email } }).catch((err) => {
    // Não revela quem é (o motorista pode ser de outro cliente).
    if (err.code === "P2002") throw erroHttp(409, "Esse celular já tem cadastro na plataforma. O motorista aparece aqui quando registrar pelo QR uma carga de vocês.");
    throw err;
  });
  await vincularMotorista(m.id, req.usuario.organizacaoId);
  await registrarLog({ usuarioEmail: req.usuario.email, acao: "CRIAR", entidade: "Motorista", entidadeId: m.id, descricao: `Motorista pré-cadastrado: ${m.nome} (${t.nome})` });
  res.status(201).json(serializar(await prisma.motorista.findUnique({ where: { id: m.id }, include: incluir(req.escopoOrganizacao) }), { completo: true }));
}));

// Editar: dados do motorista com o celular completo (só aqui e na criação).
motoristasRouter.get("/:id(\\d+)", asyncHandler(async (req, res) => {
  const m = await buscarNoEscopo(req, validarId(req.params.id));
  res.json(serializar(await prisma.motorista.findUnique({ where: { id: m.id }, include: incluir(req.escopoOrganizacao) }), { completo: true }));
}));

// Bloquear/desbloquear, corrigir nome, placa e celular.
motoristasRouter.patch("/:id", asyncHandler(async (req, res) => {
  const antes = await buscarNoEscopo(req, validarId(req.params.id));
  const org = req.escopoOrganizacao;
  const b = req.body ?? {};
  const dados = {};
  if ("nome" in b || "placa" in b) {
    const v = validarDadosMotorista({ nome: b.nome ?? antes.nome, placa: "placa" in b ? b.placa : antes.placa }, { exigirTransportadora: false });
    if (v.nome !== antes.nome) dados.nome = v.nome;
    if (v.placa !== antes.placa) dados.placa = v.placa;
  }
  // Celular novo: o acesso pelo número antigo cai (sessões encerradas) e ele entra de novo pelo código SMS.
  if ("celular" in b) {
    const celular = celularValido(b.celular);
    if (celular !== antes.celular) dados.celular = celular;
  }
  // Motorista que atende outros clientes: nome, placa e celular valem para todos — só ele mesmo
  // altera, pelo celular (o celular, confirmando o número novo por SMS). v3.2, item 2.
  if (Object.keys(dados).length) {
    const clientes = await prisma.motoristaOrganizacao.count({ where: { motoristaId: antes.id, organizacaoId: { not: org } } });
    if (clientes > 0) {
      throw erroHttp(409, "Este motorista também atende outros clientes: nome, placa e celular só podem ser alterados por ele mesmo, pelo celular, na tela do QR (Trocar placa / Trocar celular).");
    }
  }
  const agora = new Date();
  // Bloqueio (gestor ou administração) = só neste cliente (v3.5, revisão do item 2).
  const bloquear = "bloqueado" in b ? Boolean(b.bloqueado) : null;
  const vinculo = await prisma.motoristaOrganizacao.findUnique({ where: { motoristaId_organizacaoId: { motoristaId: antes.id, organizacaoId: org } } });
  const bloqueadoAntes = Boolean(vinculo?.bloqueado);
  await prisma.$transaction(async (tx) => {
    if (Object.keys(dados).length) {
      await tx.motorista.update({ where: { id: antes.id }, data: dados }).catch((err) => {
        if (err.code === "P2002") throw erroHttp(409, "Esse celular já tem cadastro na plataforma.");
        throw err;
      });
    }
    if (bloquear !== null) {
      await tx.motoristaOrganizacao.update({
        where: { motoristaId_organizacaoId: { motoristaId: antes.id, organizacaoId: org } },
        data: { bloqueado: bloquear, bloqueadoEm: bloquear ? agora : null, bloqueadoPor: bloquear ? req.usuario.email : null },
      });
    }
    // Troca de celular derruba o acesso na hora. O bloqueio do cliente é conferido a cada leitura
    // de QR e a cada pedido de código desse cliente (os acessos aos outros clientes seguem).
    if (dados.celular) {
      await tx.sessaoMotorista.updateMany({ where: { motoristaId: antes.id, revogadaEm: null }, data: { revogadaEm: agora, revogadaPor: req.usuario.email } });
    }
  });
  const m = await prisma.motorista.findUnique({ where: { id: antes.id }, include: incluir(org) });
  const mudouBloqueio = bloquear !== null && bloquear !== bloqueadoAntes;
  const acao = mudouBloqueio ? (bloquear ? "bloqueado" : "desbloqueado") : "alterado";
  await registrarLog({
    usuarioEmail: req.usuario.email, acao: acao === "alterado" ? "ALTERAR" : acao === "bloqueado" ? "BLOQUEAR" : "DESBLOQUEAR", entidade: "Motorista", entidadeId: m.id,
    descricao: `Motorista ${m.nome} (${m.transportadora.nome}) ${acao}${mudouBloqueio ? (req.escopoTransportadora ? " pelo gestor da transportadora, para este cliente" : " para este cliente") : ""}${dados.celular ? ` · celular trocado (final ${dados.celular.slice(-4)})` : ""}`,
  });
  res.json(serializar(m));
}));

// Direito de exclusão (LGPD, v3.3 item 15): anonimiza o motorista — nome, celular, CPF e placa
// somem do cadastro, o acesso é bloqueado e encerrado, e saem o telefone dos SMS e o nome gravado
// nos containers deste cliente. Ficam as posições/etapas dos containers (registro da operação) e o
// log de auditoria (imutável, retenção legal de 365 dias). Só a administração do cliente e só com
// motorista exclusivo dele (compartilhado: pedido à plataforma, que fala com todos os clientes).
// Rastros do motorista neste cliente (v3.5, revisão do item 15). Containers: só os ligados a ELE
// pelo id (rastreio, posições, pedidos/SMS, log) ou pela identidade completa nas etapas — e o nome
// só é trocado onde é exatamente o dele (homônimo de outro motorista não é tocado). Autoria: troca
// a identidade completa "Nome (motorista · Transportadora)" — nunca só o nome (texto livre).
// Fica de fora o log de auditoria (imutável, retenção legal de 365 dias).
async function anonimizarRastros(m, anonimo) {
  const identidade = identidadeMotorista(m);
  const novaIdentidade = identidadeMotorista({ ...m, nome: anonimo });
  const ids = new Set();
  const juntar = (lista) => lista.forEach((x) => x.containerId && ids.add(x.containerId));
  const [rastreio, pos, ped, msgs, eventos, logs] = await Promise.all([
    prisma.container.findMany({ where: { rastreioMotoristaId: m.id }, select: { id: true } }),
    prisma.posicaoContainer.findMany({ where: { motoristaId: m.id }, select: { containerId: true }, distinct: ["containerId"] }),
    prisma.solicitacaoPosicao.findMany({ where: { motoristaId: m.id }, select: { containerId: true }, distinct: ["containerId"] }),
    prisma.mensagemSms.findMany({ where: { motoristaId: m.id }, select: { containerId: true }, distinct: ["containerId"] }),
    prisma.eventoContainer.findMany({ where: { usuarioEmail: identidade }, select: { containerId: true }, distinct: ["containerId"] }),
    prisma.logAuditoria.findMany({ where: { motoristaId: m.id, entidade: "Container" }, select: { entidadeId: true } }),
  ]);
  rastreio.forEach((c) => ids.add(c.id));
  [pos, ped, msgs, eventos].forEach(juntar);
  logs.forEach((l) => Number(l.entidadeId) && ids.add(Number(l.entidadeId)));
  return prisma.$transaction(async (tx) => {
    const containers = await tx.container.updateMany({ where: { id: { in: [...ids] }, motorista: m.nome }, data: { motorista: anonimo, placa: null } });
    // Em sequência: a transação usa uma conexão só.
    let autoria = 0;
    autoria += (await tx.container.updateMany({ where: { criadoPor: identidade }, data: { criadoPor: novaIdentidade } })).count;
    autoria += (await tx.eventoContainer.updateMany({ where: { usuarioEmail: identidade }, data: { usuarioEmail: novaIdentidade } })).count;
    autoria += (await tx.etiquetaQR.updateMany({ where: { vinculadaPor: identidade }, data: { vinculadaPor: novaIdentidade } })).count;
    autoria += (await tx.etiquetaQR.updateMany({ where: { canceladaPor: identidade }, data: { canceladaPor: novaIdentidade } })).count;
    autoria += (await tx.leituraTemperatura.updateMany({ where: { fonte: identidade }, data: { fonte: novaIdentidade } })).count;
    autoria += (await tx.paradaContainer.updateMany({ where: { registradoPor: identidade }, data: { registradoPor: novaIdentidade } })).count;
    autoria += (await tx.mudancaTrajeto.updateMany({ where: { usuarioEmail: identidade }, data: { usuarioEmail: novaIdentidade } })).count;
    return { containers: containers.count, autoria };
  });
}

motoristasRouter.post("/:id/anonimizar", asyncHandler(async (req, res) => {
  if (req.escopoTransportadora) throw erroHttp(403, "Só a administração do cliente pode anonimizar um motorista.");
  const m = await buscarNoEscopo(req, validarId(req.params.id));
  const outros = await prisma.motoristaOrganizacao.count({ where: { motoristaId: m.id, organizacaoId: { not: req.escopoOrganizacao } } });
  if (outros > 0) throw erroHttp(409, "Este motorista também atende outros clientes: o pedido de exclusão precisa ser feito ao suporte da plataforma.");
  if (m.celular.startsWith("anonimizado-")) throw erroHttp(409, "Este motorista já foi anonimizado.");
  const agora = new Date();
  const anonimo = `Motorista anonimizado #${m.id}`;
  await prisma.$transaction(async (tx) => {
    await tx.motorista.update({
      where: { id: m.id },
      data: { nome: anonimo, celular: `anonimizado-${m.id}`, cpf: null, placa: null, bloqueado: true, bloqueadoEm: agora, bloqueadoPor: "anonimização (LGPD)", consentimentoEm: null },
    });
    await tx.sessaoMotorista.deleteMany({ where: { motoristaId: m.id } });
    await tx.codigoAcessoMotorista.deleteMany({ where: { celular: m.celular } });
  });
  const sms = await prisma.mensagemSms.updateMany({ where: { motoristaId: m.id }, data: { telefone: null } });
  const { containers, autoria } = await anonimizarRastros(m, anonimo);
  await registrarLog({
    usuarioEmail: req.usuario.email, acao: "ANONIMIZAR", entidade: "Motorista", entidadeId: m.id,
    descricao: `Motorista #${m.id} anonimizado (LGPD): cadastro, ${sms.count} telefone(s) de SMS, ${containers} container(s) e ${autoria} registro(s) de autoria`,
  });
  res.json(serializar(await prisma.motorista.findUnique({ where: { id: m.id }, include: incluir(req.escopoOrganizacao) })));
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
motoristasRouter.post("/importar", express.raw({ type: () => true, limit: "1mb" }), asyncHandler(async (req, res) => {
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
  const transportadoras = await prisma.transportadora.findMany({ where: { ativo: true, ...visivelParaOrganizacao(req.escopoOrganizacao) }, select: { id: true, nome: true } });
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
