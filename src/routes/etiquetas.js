import { Router } from "express";
import os from "node:os";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { requireRole, PERMISSOES } from "../lib/auth.js";
import { registrarLog } from "../lib/auditoria.js";
import { lerConfiguracao } from "../lib/configuracao.js";
import { gerarCodigo, gerarToken, urlDaEtiqueta, zplDoLote, MODELOS_ETIQUETA, DPI_SUPORTADOS } from "../lib/etiquetas.js";
import { STATUS_ENCERRADOS } from "../lib/prazos.js";
import { texto, inteiro, decimal, id as validarId, umDe } from "../lib/validacao.js";

const MAX_POR_LOTE = 500;

// Estado mostrado ao usuário: "ENCERRADA" é deduzido (container entregue/cancelado).
export function estadoDaEtiqueta(e) {
  if (e.status === "VINCULADA" && e.container && STATUS_ENCERRADOS.includes(e.container.status)) return "ENCERRADA";
  return e.status;
}

const SELECT_CONTAINER = { select: { id: true, numero: true, status: true, tipo: true } };

function serializar(e) {
  return {
    id: e.id, codigo: e.codigo, token: e.token, loteId: e.loteId, status: e.status, estado: estadoDaEtiqueta(e),
    container: e.container ?? null, vinculadaEm: e.vinculadaEm, vinculadaPor: e.vinculadaPor,
    canceladaEm: e.canceladaEm, canceladaPor: e.canceladaPor, motivoCancelamento: e.motivoCancelamento,
    criadoEm: e.criadoEm, leituras: e._count?.leituras ?? 0,
  };
}

// Endereços IPv4 desta máquina na rede local: sugestão para testar o QR no celular sem publicar.
// Adaptadores virtuais (WSL, Hyper-V, Docker, VMs) vão por último: o celular não os alcança.
const ADAPTADOR_VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback/i;
function enderecosDaRede() {
  const ips = [];
  for (const [nome, lista] of Object.entries(os.networkInterfaces())) {
    for (const a of lista ?? []) {
      if (a.family === "IPv4" && !a.internal && !/^169\.254\./.test(a.address)) {
        ips.push({ interface: nome, ip: a.address, virtual: ADAPTADOR_VIRTUAL.test(nome) });
      }
    }
  }
  return ips.sort((a, b) => a.virtual - b.virtual);
}

export const etiquetasRouter = Router();

etiquetasRouter.get("/", asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.ids) {
    where.id = { in: String(req.query.ids).split(",").slice(0, MAX_POR_LOTE).map((i) => validarId(i, "Etiqueta")) };
  }
  if (req.query.loteId) where.loteId = validarId(req.query.loteId, "Lote");
  if (req.query.busca) {
    const b = String(req.query.busca).trim().toUpperCase();
    where.OR = [{ codigo: { contains: b } }, { container: { numero: { contains: b.replace(/\s/g, "") } } }];
  }
  const etiquetas = await prisma.etiquetaQR.findMany({
    where,
    include: { container: SELECT_CONTAINER, _count: { select: { leituras: true } } },
    orderBy: { id: "desc" },
    take: 1000,
  });
  let lista = etiquetas.map(serializar);
  if (req.query.estado) {
    const estado = umDe(req.query.estado, ["LIVRE", "VINCULADA", "ENCERRADA", "CANCELADA"], "Situação");
    lista = lista.filter((e) => e.estado === estado);
  }
  res.json(lista);
}));

etiquetasRouter.get("/lotes", asyncHandler(async (_req, res) => {
  const lotes = await prisma.loteEtiquetas.findMany({ orderBy: { id: "desc" }, take: 100, include: { _count: { select: { etiquetas: true } } } });
  res.json(lotes.map(({ _count, ...l }) => ({ ...l, total: _count.etiquetas })));
}));

// Dados para a tela de impressão: modelos de etiqueta, DPIs, endereço configurado e sugestões.
etiquetasRouter.get("/impressao", asyncHandler(async (_req, res) => {
  const config = await lerConfiguracao();
  const porta = process.env.PORT || 3000;
  res.json({
    modelos: MODELOS_ETIQUETA,
    dpis: DPI_SUPORTADOS,
    urlPublica: config.urlPublica,
    // Em desenvolvimento a tela roda no Vite (5174); no build, o próprio servidor serve tudo.
    sugestoes: enderecosDaRede().flatMap(({ interface: nome, ip, virtual }) => {
      const obs = virtual ? " — adaptador virtual, o celular não alcança" : "";
      return [
        { rotulo: `${ip} · porta 5174 (tela em desenvolvimento) · ${nome}${obs}`, url: `http://${ip}:5174`, virtual },
        { rotulo: `${ip} · porta ${porta} (servidor) · ${nome}${obs}`, url: `http://${ip}:${porta}`, virtual },
      ];
    }),
  });
}));

etiquetasRouter.post("/lotes", requireRole(...PERMISSOES.cadastros), asyncHandler(async (req, res) => {
  const quantidade = inteiro(req.body?.quantidade, "Quantidade", { obrigatorio: true, min: 1, max: MAX_POR_LOTE });
  const lote = await prisma.$transaction(async (tx) => {
    const l = await tx.loteEtiquetas.create({ data: { quantidade, criadoPor: req.usuario.email } });
    const codigos = new Set();
    while (codigos.size < quantidade) codigos.add(gerarCodigo());
    // Colisão com etiqueta antiga é improvável (31^6 combinações), mas o índice único garante.
    const existentes = new Set((await tx.etiquetaQR.findMany({ where: { codigo: { in: [...codigos] } }, select: { codigo: true } })).map((e) => e.codigo));
    for (const c of existentes) {
      codigos.delete(c);
      let novo;
      do novo = gerarCodigo(); while (codigos.has(novo) || existentes.has(novo));
      codigos.add(novo);
    }
    await tx.etiquetaQR.createMany({ data: [...codigos].map((codigo) => ({ codigo, token: gerarToken(), loteId: l.id })) });
    await registrarLog({ usuarioEmail: req.usuario.email, acao: "CRIAR", entidade: "LoteEtiquetas", entidadeId: l.id, descricao: `Lote de ${quantidade} etiqueta(s) QR gerado` }, tx);
    return l;
  });
  const etiquetas = await prisma.etiquetaQR.findMany({ where: { loteId: lote.id }, include: { container: SELECT_CONTAINER }, orderBy: { id: "asc" } });
  res.status(201).json({ lote, etiquetas: etiquetas.map(serializar) });
}));

etiquetasRouter.post("/:id/cancelar", requireRole(...PERMISSOES.cadastros), asyncHandler(async (req, res) => {
  const etiquetaId = validarId(req.params.id, "Etiqueta");
  const motivo = texto(req.body?.motivo, "Motivo", { obrigatorio: true, max: 300 });
  const e = await prisma.etiquetaQR.findUnique({ where: { id: etiquetaId }, include: { container: SELECT_CONTAINER } });
  if (!e) throw erroHttp(404, "Etiqueta não encontrada.");
  if (e.status === "CANCELADA") throw erroHttp(409, "Esta etiqueta já está cancelada.");
  const depois = await prisma.etiquetaQR.update({
    where: { id: etiquetaId },
    data: { status: "CANCELADA", canceladaEm: new Date(), canceladaPor: req.usuario.email, motivoCancelamento: motivo },
    include: { container: SELECT_CONTAINER },
  });
  await registrarLog({
    usuarioEmail: req.usuario.email, acao: "CANCELAR", entidade: "EtiquetaQR", entidadeId: etiquetaId,
    descricao: `Etiqueta ${e.codigo} cancelada${e.container ? ` (container ${e.container.numero})` : ""}: ${motivo}`,
  });
  res.json(serializar(depois));
}));

// Arquivo ZPL (linguagem da Zebra) para imprimir direto na impressora de etiquetas.
etiquetasRouter.post("/zpl", asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const ids = (Array.isArray(b.ids) ? b.ids : []).slice(0, MAX_POR_LOTE).map((i) => validarId(i, "Etiqueta"));
  if (!ids.length) throw erroHttp(400, "Selecione ao menos uma etiqueta.");
  const larguraMm = decimal(b.larguraMm, "Largura (mm)", { obrigatorio: true, min: 20, max: 200 });
  const alturaMm = decimal(b.alturaMm, "Altura (mm)", { obrigatorio: true, min: 15, max: 300 });
  const dpi = Number(umDe(String(b.dpi ?? 203), DPI_SUPORTADOS.map(String), "Resolução (dpi)"));
  const baseUrl = texto(b.baseUrl, "Endereço do sistema", { obrigatorio: true, max: 200 });
  if (!/^https?:\/\/[^\s/]+(:\d+)?\/?$/i.test(baseUrl)) throw erroHttp(400, "Endereço do sistema inválido (ex.: http://192.168.0.10:5174).");
  const etiquetas = await prisma.etiquetaQR.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
  const zpl = zplDoLote(etiquetas.map((e) => ({ codigo: e.codigo, url: urlDaEtiqueta(baseUrl, e.token) })), { larguraMm, alturaMm, dpi });
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="etiquetas-${larguraMm}x${alturaMm}mm-${dpi}dpi.zpl"`);
  res.send(zpl);
}));
