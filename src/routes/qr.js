// API da tela de celular aberta pelo QR da etiqueta (/q/:token). Exige login.
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { requireRole, PERMISSOES } from "../lib/auth.js";
import { registrarLog } from "../lib/auditoria.js";
import { registrarLeitura, sincronizarAlertas } from "../lib/leituras.js";
import { validarNumeroContainer } from "../lib/iso6346.js";
import { ehReefer, STATUS_ENCERRADOS } from "../lib/prazos.js";
import { decimal, dataHora, inteiro } from "../lib/validacao.js";
import { estadoDaEtiqueta } from "./etiquetas.js";

export const qrRouter = Router();

const TOKEN = /^[A-Za-z0-9_-]{22}$/;

async function buscarEtiqueta(token) {
  if (!TOKEN.test(token)) throw erroHttp(404, "Etiqueta não reconhecida. Confira se o QR é do Controle de Container.");
  const e = await prisma.etiquetaQR.findUnique({ where: { token }, include: { container: { include: { grupo: true } } } });
  if (!e) throw erroHttp(404, "Etiqueta não reconhecida. Confira se o QR é do Controle de Container.");
  return e;
}

async function resumo(e, usuario) {
  const c = e.container;
  const ultimas = c
    ? await prisma.leituraTemperatura.findMany({ where: { containerId: c.id }, orderBy: { lidaEm: "desc" }, take: 3, select: { temperatura: true, lidaEm: true, fonte: true, origem: true } })
    : [];
  return {
    etiqueta: { codigo: e.codigo, estado: estadoDaEtiqueta(e), vinculadaEm: e.vinculadaEm, vinculadaPor: e.vinculadaPor, motivoCancelamento: e.motivoCancelamento },
    container: c && {
      id: c.id, numero: c.numero, tipo: c.tipo, reefer: ehReefer(c.tipo), status: c.status,
      cliente: c.grupo.cliente, fabrica: c.grupo.fabrica,
      setpoint: c.setpoint === null ? null : Number(c.setpoint),
      tempMin: c.tempMin === null ? null : Number(c.tempMin),
      tempMax: c.tempMax === null ? null : Number(c.tempMax),
      coletadoEm: c.coletadoEm, entreguePortoEm: c.entreguePortoEm, canceladoEm: c.canceladoEm,
      ultimasLeituras: ultimas.map((l) => ({ ...l, temperatura: Number(l.temperatura) })),
    },
    podeRegistrar: PERMISSOES.operar.includes(usuario.perfil),
  };
}

// Localização opcional enviada pelo celular (só funciona em https/localhost e com permissão).
function lerLocalizacao(b) {
  if (b.latitude === undefined || b.latitude === null || b.latitude === "") return {};
  return {
    latitude: decimal(b.latitude, "Latitude", { min: -90, max: 90 }),
    longitude: decimal(b.longitude, "Longitude", { obrigatorio: true, min: -180, max: 180 }),
    precisaoM: b.precisaoM === undefined || b.precisaoM === null ? null : inteiro(Math.round(Number(b.precisaoM)), "Precisão", { min: 0, max: 100000 }),
  };
}

// Resultado da leitura em relação à faixa do container (a tela mostra na hora).
function avaliar(container, temperatura) {
  if (container.tempMin === null || container.tempMax === null) return null;
  const t = Number(temperatura);
  if (t < Number(container.tempMin)) return "ABAIXO";
  if (t > Number(container.tempMax)) return "ACIMA";
  return "OK";
}

// Reserva quando o QR não abre (etiqueta riscada, IP do teste mudou…): a pessoa digita o código
// curto impresso (CC-XXXXXX, com ou sem "CC-") e segue para a mesma tela da etiqueta.
qrRouter.get("/codigo/:codigo", asyncHandler(async (req, res) => {
  const bruto = String(req.params.codigo).toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^CC/, "");
  if (!/^[A-Z0-9]{6}$/.test(bruto)) throw erroHttp(400, "Código inválido. Formato: CC- seguido de 6 letras/números (ex.: CC-7K3F9P).");
  const e = await prisma.etiquetaQR.findUnique({ where: { codigo: `CC-${bruto}` }, select: { token: true, codigo: true } });
  if (!e) throw erroHttp(404, `Etiqueta CC-${bruto} não encontrada. Confira o código impresso.`);
  res.json(e);
}));

qrRouter.get("/:token", asyncHandler(async (req, res) => {
  res.json(await resumo(await buscarEtiqueta(req.params.token), req.usuario));
}));

// 1ª leitura: liga a etiqueta a um container ativo (e já registra a temperatura, se reefer).
qrRouter.post("/:token/vincular", requireRole(...PERMISSOES.operar), asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const e = await buscarEtiqueta(req.params.token);
  if (e.status === "CANCELADA") throw erroHttp(409, `A etiqueta ${e.codigo} está cancelada e não pode ser usada.`);
  if (e.status === "VINCULADA") throw erroHttp(409, `A etiqueta ${e.codigo} já está ligada ao container ${e.container.numero}.`);

  const { numero, formatoValido } = validarNumeroContainer(b.numero);
  if (!formatoValido) throw erroHttp(400, "Número do container inválido. Formato: 4 letras + 7 dígitos (ex.: MSCU1234566).");
  const container = await prisma.container.findFirst({ where: { numero, status: { notIn: STATUS_ENCERRADOS } } });
  if (!container) {
    throw erroHttp(404, `O container ${numero} não está ativo no sistema. Confira o número ou peça para cadastrá-lo antes.`);
  }
  const reefer = ehReefer(container.tipo);
  const temperatura = reefer ? decimal(b.temperatura, "Temperatura", { obrigatorio: true, min: -60, max: 60 }) : null;
  const lidaEm = dataHora(b.lidaEm, "Data/hora") ?? new Date();
  const local = lerLocalizacao(b);

  // Container já com etiqueta ativa: só substitui com confirmação (etiqueta danificada/perdida).
  const anterior = await prisma.etiquetaQR.findFirst({ where: { containerId: container.id, status: "VINCULADA" } });
  if (anterior && !b.substituir) {
    return res.status(409).json({
      erro: `O container ${numero} já tem a etiqueta ${anterior.codigo}. Confirme para substituí-la por ${e.codigo}.`,
      codigo: "ETIQUETA_EXISTENTE",
      etiquetaAnterior: anterior.codigo,
    });
  }

  await prisma.$transaction(async (tx) => {
    // Reconfere dentro da transação: duas pessoas lendo a mesma etiqueta ao mesmo tempo.
    const atual = await tx.etiquetaQR.findUnique({ where: { id: e.id } });
    if (atual.status !== "LIVRE") throw erroHttp(409, `A etiqueta ${e.codigo} acabou de ser usada por outra pessoa. Leia o QR de novo.`);
    if (anterior) {
      await tx.etiquetaQR.update({
        where: { id: anterior.id },
        data: { status: "CANCELADA", canceladaEm: new Date(), canceladaPor: req.usuario.email, motivoCancelamento: `Substituída pela etiqueta ${e.codigo}` },
      });
    }
    await tx.etiquetaQR.update({
      where: { id: e.id },
      data: { status: "VINCULADA", containerId: container.id, vinculadaEm: new Date(), vinculadaPor: req.usuario.email },
    });
    await registrarLog(
      {
        usuarioEmail: req.usuario.email, acao: "VINCULAR", entidade: "EtiquetaQR", entidadeId: e.id,
        descricao: `Etiqueta ${e.codigo} ligada ao container ${numero}${anterior ? ` (substituiu ${anterior.codigo})` : ""}`,
      },
      tx
    );
    if (reefer) {
      await registrarLeitura({ container, temperatura, lidaEm, origem: "QRCODE", usuarioEmail: req.usuario.email, extras: { etiquetaId: e.id, ...local } }, tx);
    }
  });
  if (reefer) await sincronizarAlertas(container.id);
  res.status(201).json({ ...(await resumo(await buscarEtiqueta(req.params.token), req.usuario)), resultado: reefer ? avaliar(container, temperatura) : null });
}));

// Leituras seguintes: etiqueta já ligada — só temperatura e data/hora.
qrRouter.post("/:token/leituras", requireRole(...PERMISSOES.operar), asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const e = await buscarEtiqueta(req.params.token);
  const estado = estadoDaEtiqueta(e);
  if (estado === "LIVRE") throw erroHttp(409, "Esta etiqueta ainda não está ligada a um container.");
  if (estado === "CANCELADA") throw erroHttp(409, `A etiqueta ${e.codigo} está cancelada${e.motivoCancelamento ? ` (${e.motivoCancelamento})` : ""}.`);
  if (estado === "ENCERRADA") throw erroHttp(409, `O container ${e.container.numero} já foi encerrado; esta etiqueta não recebe mais leituras.`);
  const temperatura = decimal(b.temperatura, "Temperatura", { obrigatorio: true, min: -60, max: 60 });
  const lidaEm = dataHora(b.lidaEm, "Data/hora") ?? new Date();
  await registrarLeitura({
    container: e.container, temperatura, lidaEm, origem: "QRCODE", usuarioEmail: req.usuario.email,
    extras: { etiquetaId: e.id, ...lerLocalizacao(b) },
  });
  await sincronizarAlertas(e.container.id);
  res.status(201).json({ ...(await resumo(await buscarEtiqueta(req.params.token), req.usuario)), resultado: avaliar(e.container, temperatura) });
}));
