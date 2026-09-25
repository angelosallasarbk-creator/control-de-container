// API da tela de celular aberta pelo QR da etiqueta (/q/:token). Exige login.
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { requirePermissao, tem, ehTransportador, ehPortaria } from "../lib/permissoes.js";
import { registrarLog } from "../lib/auditoria.js";
import { registrarLeitura, sincronizarAlertas } from "../lib/leituras.js";
import { validarNumeroContainer } from "../lib/iso6346.js";
import { ehReefer, STATUS_ENCERRADOS } from "../lib/prazos.js";
import { decimal, dataHora, inteiro, id as validarId } from "../lib/validacao.js";
import { ROTULO_STATUS as ROTULO_ETAPA, TIPOS as TIPOS_CONTAINER, CAMPO_DATA, FLUXO, validarNovoContainer, gravarNovoContainer, validarMomento, prepararRota } from "./containers.js";
import { estadoDaEtiqueta } from "./etiquetas.js";
import { SELECT_LOCAIS_ETAPAS, rotulosDasEtapas } from "../lib/tiposLocal.js";

export const qrRouter = Router();

const TOKEN = /^[A-Za-z0-9_-]{22}$/;

async function buscarEtiqueta(token) {
  if (!TOKEN.test(token)) throw erroHttp(404, "Etiqueta não reconhecida. Confira se o QR é do Controle de Container.");
  const e = await prisma.etiquetaQR.findUnique({ where: { token }, include: { container: { include: { grupo: true, ...SELECT_LOCAIS_ETAPAS } } } });
  if (!e) throw erroHttp(404, "Etiqueta não reconhecida. Confira se o QR é do Controle de Container.");
  return e;
}

async function resumo(e, req) {
  const c = e.container;
  const ultimas = c
    ? await prisma.leituraTemperatura.findMany({ where: { containerId: c.id }, orderBy: { lidaEm: "desc" }, take: 3, select: { temperatura: true, lidaEm: true, fonte: true, origem: true } })
    : [];
  return {
    etiqueta: { codigo: e.codigo, estado: estadoDaEtiqueta(e), vinculadaEm: e.vinculadaEm, vinculadaPor: e.vinculadaPor, motivoCancelamento: e.motivoCancelamento },
    container: c && {
      id: c.id, numero: c.numero, tipo: c.tipo, reefer: ehReefer(c.tipo), status: c.status, rotulosEtapa: rotulosDasEtapas(c),
      cliente: c.grupo.cliente, fabrica: c.grupo.fabrica,
      setpoint: c.setpoint === null ? null : Number(c.setpoint),
      tempMin: c.tempMin === null ? null : Number(c.tempMin),
      tempMax: c.tempMax === null ? null : Number(c.tempMax),
      coletadoEm: c.coletadoEm, entreguePortoEm: c.entreguePortoEm, canceladoEm: c.canceladoEm,
      retirada: c.portoRetirada?.nome ?? null,
      ultimasLeituras: ultimas.map((l) => ({ ...l, temperatura: Number(l.temperatura) })),
    },
    podeRegistrar: tem(req, "qr.registrar"),
    // Transportador: ao ler, registra a coleta (Tipo > Local de retirada) se ainda não houver.
    modoTransportador: ehTransportador(req),
    // Portaria: ao ler, registra entrada ou saída no ponto de carregamento.
    modoPortaria: ehPortaria(req),
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
  res.json(await resumo(await buscarEtiqueta(req.params.token), req));
}));

// 1ª leitura: liga a etiqueta a um container ativo (e já registra a temperatura, se reefer).
qrRouter.post("/:token/vincular", requirePermissao("qr.registrar"), asyncHandler(async (req, res) => {
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
  res.status(201).json({ ...(await resumo(await buscarEtiqueta(req.params.token), req)), resultado: reefer ? avaliar(container, temperatura) : null });
}));

// Leituras seguintes: etiqueta já ligada — só temperatura e data/hora.
qrRouter.post("/:token/leituras", requirePermissao("qr.registrar"), asyncHandler(async (req, res) => {
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
  res.status(201).json({ ...(await resumo(await buscarEtiqueta(req.params.token), req)), resultado: avaliar(e.container, temperatura) });
}));

// ---------- Transportador: coleta pelo QR ----------
// Ao ler a etiqueta, o transportador informa onde retirou o container (Tipo > Local, só locais
// de retirada: porto, terminal ferroviário…) e o sistema registra a etapa de coleta. Se o
// container ainda não existe, ele cadastra na hora. Tudo numa transação: ou grava tudo, ou nada.

// Opções do formulário do celular (só o necessário, sem expor o resto do sistema).
qrRouter.get("/opcoes/coleta", requirePermissao("qr.registrar"), asyncHandler(async (_req, res) => {
  const [tipos, locais, grupos, armadores, produtos] = await Promise.all([
    prisma.tipoLocal.findMany({ where: { ativo: true, funcao: "RETIRADA_ENTREGA" }, orderBy: { nome: "asc" }, select: { id: true, nome: true } }),
    prisma.local.findMany({ where: { ativo: true, tipo: { funcao: "RETIRADA_ENTREGA" } }, orderBy: { nome: "asc" }, select: { id: true, nome: true, cidade: true, uf: true, tipoId: true } }),
    prisma.grupoOperacao.findMany({ where: { ativo: true }, orderBy: [{ cliente: "asc" }, { fabrica: "asc" }], select: { id: true, cliente: true, fabrica: true } }),
    prisma.armador.findMany({ where: { ativo: true }, orderBy: { nome: "asc" }, select: { id: true, nome: true } }),
    prisma.produto.findMany({ where: { ativo: true }, orderBy: { nome: "asc" }, select: { id: true, nome: true } }),
  ]);
  res.json({ tipos, locais, grupos, armadores, produtos, tiposContainer: TIPOS_CONTAINER });
}));

async function localDeRetirada(valor) {
  const id = validarId(valor, "Local de retirada");
  const local = await prisma.local.findUnique({ where: { id }, include: { tipo: true } });
  if (!local || !local.ativo) throw erroHttp(400, "Local de retirada não encontrado ou inativo.");
  if (local.tipo.funcao !== "RETIRADA_ENTREGA") throw erroHttp(400, `"${local.nome}" não é um local de retirada (porto, terminal ferroviário…).`);
  return local;
}

qrRouter.post("/:token/coleta", requirePermissao("qr.registrar"), asyncHandler(async (req, res) => {
  if (!ehTransportador(req)) throw erroHttp(403, "O registro de coleta pelo QR é do perfil Transportador.");
  const b = req.body ?? {};
  const email = req.usuario.email;
  const e = await buscarEtiqueta(req.params.token);
  const estado = estadoDaEtiqueta(e);
  if (estado === "CANCELADA") throw erroHttp(409, `A etiqueta ${e.codigo} está cancelada e não pode ser usada.`);
  if (estado === "ENCERRADA") throw erroHttp(409, `O container ${e.container.numero} já foi encerrado; esta etiqueta não recebe mais registros.`);

  const retirada = await localDeRetirada(b.portoRetiradaId);
  const coletadoEm = dataHora(b.coletadoEm, "Data/hora da coleta") ?? new Date();
  const lidaEm = new Date();
  const posicao = lerLocalizacao(b);

  // Container: o da etiqueta, ou (1ª leitura) o do número digitado; sem cadastro, cria.
  let container = e.container;
  let novo = null;
  let numero = container?.numero;
  if (e.status === "LIVRE") {
    const conferido = validarNumeroContainer(b.numero);
    if (!conferido.formatoValido) throw erroHttp(400, "Número do container inválido. Formato: 4 letras + 7 dígitos (ex.: MSCU1234566).");
    numero = conferido.numero;
    container = await prisma.container.findFirst({ where: { numero, status: { notIn: STATUS_ENCERRADOS } } });
    if (!container) {
      if (!b.novo) {
        throw erroHttp(404, `O container ${numero} ainda não está cadastrado. Preencha os dados abaixo para cadastrá-lo.`, { codigo: "CONTAINER_NAO_CADASTRADO", numero });
      }
      novo = await validarNovoContainer(
        { ...b.novo, numero: b.numero, confirmarDigito: b.confirmarDigito, portoRetiradaId: retirada.id, coletadoEm },
        email
      );
    }
  }
  const reefer = ehReefer(container?.tipo ?? novo.tipo);
  const temperatura = reefer ? decimal(b.temperatura, "Temperatura", { obrigatorio: true, min: -60, max: 60 }) : null;
  const jaColetado = Boolean(container) && container.status !== "PROGRAMADO";
  if (container && !jaColetado) validarMomento(coletadoEm, container);

  // Container já com etiqueta ativa: só substitui com confirmação (mesma regra da 1ª leitura).
  const anterior = container && e.status === "LIVRE" ? await prisma.etiquetaQR.findFirst({ where: { containerId: container.id, status: "VINCULADA" } }) : null;
  if (anterior && !b.substituir) {
    throw erroHttp(409, `O container ${numero} já tem a etiqueta ${anterior.codigo}. Confirme para substituí-la por ${e.codigo}.`, {
      codigo: "ETIQUETA_EXISTENTE", etiquetaAnterior: anterior.codigo,
    });
  }

  const descricaoRetirada = `${retirada.nome} (${retirada.tipo.nome})`;
  const final = await prisma.$transaction(async (tx) => {
    let c = container;
    if (novo) {
      c = await gravarNovoContainer(tx, novo, email, `Container ${numero} cadastrado pelo transportador na coleta em ${descricaoRetirada}`);
    } else if (!jaColetado) {
      // Condição no WHERE: se outra pessoa registrou a coleta no meio tempo, não grava de novo.
      const r = await tx.container.updateMany({ where: { id: c.id, status: "PROGRAMADO" }, data: { status: "COLETADO", coletadoEm, portoRetiradaId: retirada.id } });
      if (r.count !== 1) throw erroHttp(409, "A coleta deste container acabou de ser registrada por outra pessoa. Leia o QR de novo.");
      await tx.eventoContainer.create({
        data: { containerId: c.id, statusDe: "PROGRAMADO", statusPara: "COLETADO", ocorridoEm: coletadoEm, usuarioEmail: email, observacao: `Coleta pelo QR em ${descricaoRetirada}` },
      });
      await registrarLog({
        usuarioEmail: email, acao: "AVANCAR", entidade: "Container", entidadeId: c.id,
        descricao: `Container ${numero}: coleta registrada pelo transportador em ${descricaoRetirada}` +
          (c.portoRetiradaId && c.portoRetiradaId !== retirada.id ? " (substituiu o local de retirada previsto)" : ""),
      }, tx);
      c = { ...c, status: "COLETADO", coletadoEm, portoRetiradaId: retirada.id };
    }
    if (e.status === "LIVRE") {
      const atual = await tx.etiquetaQR.findUnique({ where: { id: e.id } });
      if (atual.status !== "LIVRE") throw erroHttp(409, `A etiqueta ${e.codigo} acabou de ser usada por outra pessoa. Leia o QR de novo.`);
      if (anterior) {
        await tx.etiquetaQR.update({
          where: { id: anterior.id },
          data: { status: "CANCELADA", canceladaEm: new Date(), canceladaPor: email, motivoCancelamento: `Substituída pela etiqueta ${e.codigo}` },
        });
      }
      await tx.etiquetaQR.update({ where: { id: e.id }, data: { status: "VINCULADA", containerId: c.id, vinculadaEm: new Date(), vinculadaPor: email } });
      await registrarLog({
        usuarioEmail: email, acao: "VINCULAR", entidade: "EtiquetaQR", entidadeId: e.id,
        descricao: `Etiqueta ${e.codigo} ligada ao container ${numero} na coleta${anterior ? ` (substituiu ${anterior.codigo})` : ""}`,
      }, tx);
    }
    if (reefer) {
      await registrarLeitura({ container: c, temperatura, lidaEm, origem: "QRCODE", usuarioEmail: email, extras: { etiquetaId: e.id, ...posicao } }, tx);
    }
    return c;
  });

  await prepararRota(final.id);
  await sincronizarAlertas(final.id);
  res.status(201).json({
    ...(await resumo(await buscarEtiqueta(req.params.token), req)),
    resultado: reefer ? avaliar(final, temperatura) : null,
    coleta: jaColetado ? "JA_REGISTRADA" : "REGISTRADA",
    cadastrado: Boolean(novo),
  });
}));

// ---------- Portaria: entrada e saída no ponto de carregamento ----------
// ENTRADA = chegada (NA_FABRICA); SAÍDA = saída (SAIU_FABRICA). Etapas anteriores que a operação
// não registrou são completadas com o mesmo horário e ficam marcadas no histórico — o caminhão
// já passou pelo portão, e a estadia precisa abrir/fechar na hora real.
const ALVO_DO_MOVIMENTO = { ENTRADA: "NA_FABRICA", SAIDA: "SAIU_FABRICA" };

qrRouter.post("/:token/portaria", requirePermissao("qr.registrar"), asyncHandler(async (req, res) => {
  if (!ehPortaria(req)) throw erroHttp(403, "O registro de entrada/saída pelo QR é do perfil Portaria.");
  const b = req.body ?? {};
  const email = req.usuario.email;
  const movimento = String(b.movimento ?? "").toUpperCase();
  if (!ALVO_DO_MOVIMENTO[movimento]) throw erroHttp(400, "Informe se é ENTRADA ou SAÍDA.");
  const alvo = ALVO_DO_MOVIMENTO[movimento];
  const e = await buscarEtiqueta(req.params.token);
  const estado = estadoDaEtiqueta(e);
  if (estado === "CANCELADA") throw erroHttp(409, `A etiqueta ${e.codigo} está cancelada e não pode ser usada.`);
  if (estado === "ENCERRADA") throw erroHttp(409, `O container ${e.container.numero} já foi encerrado; esta etiqueta não recebe mais registros.`);
  const ocorridoEm = dataHora(b.ocorridoEm, "Data/hora") ?? new Date();
  const posicao = lerLocalizacao(b);

  // Container: o da etiqueta ou (etiqueta nova) o do número digitado — precisa estar cadastrado.
  let container = e.container;
  if (e.status === "LIVRE") {
    const conferido = validarNumeroContainer(b.numero);
    if (!conferido.formatoValido) throw erroHttp(400, "Número do container inválido. Formato: 4 letras + 7 dígitos (ex.: MSCU1234566).");
    container = await prisma.container.findFirst({ where: { numero: conferido.numero, status: { notIn: STATUS_ENCERRADOS } }, include: SELECT_LOCAIS_ETAPAS });
    if (!container) throw erroHttp(404, `O container ${conferido.numero} não está cadastrado no sistema. Avise a operação.`);
  }
  const numero = container.numero;
  const posAtual = FLUXO.indexOf(container.status);
  const posAlvo = FLUXO.indexOf(alvo);
  const nome = (s) => rotulosDasEtapas(container)[s] ?? ROTULO_ETAPA[s];
  if (posAtual >= posAlvo) {
    throw erroHttp(409, `${movimento === "ENTRADA" ? "Entrada" : "Saída"} já registrada: o container está em "${nome(container.status)}".`);
  }
  if (movimento === "SAIDA" && posAtual < FLUXO.indexOf("NA_FABRICA")) {
    throw erroHttp(409, "A entrada deste container ainda não foi registrada. Registre a ENTRADA primeiro (pode ajustar o horário) e depois a saída.");
  }
  validarMomento(ocorridoEm, container);
  const reefer = ehReefer(container.tipo);
  const temperatura = reefer ? decimal(b.temperatura, "Temperatura", { obrigatorio: true, min: -60, max: 60 }) : null;

  const anterior = e.status === "LIVRE" ? await prisma.etiquetaQR.findFirst({ where: { containerId: container.id, status: "VINCULADA" } }) : null;
  if (anterior && !b.substituir) {
    throw erroHttp(409, `O container ${numero} já tem a etiqueta ${anterior.codigo}. Confirme para substituí-la por ${e.codigo}.`, {
      codigo: "ETIQUETA_EXISTENTE", etiquetaAnterior: anterior.codigo,
    });
  }

  const etapas = FLUXO.slice(posAtual + 1, posAlvo + 1); // da próxima até o alvo
  const completadas = etapas.slice(0, -1);
  const final = await prisma.$transaction(async (tx) => {
    // Condição no WHERE: se outra pessoa avançou o container no meio tempo, nada é gravado.
    const dados = { status: alvo, ...Object.fromEntries(etapas.map((s) => [CAMPO_DATA[s], ocorridoEm])) };
    const r = await tx.container.updateMany({ where: { id: container.id, status: container.status }, data: dados });
    if (r.count !== 1) throw erroHttp(409, "O container acabou de mudar de etapa. Leia o QR de novo.");
    let de = container.status;
    for (const s of etapas) {
      const completada = s !== alvo;
      await tx.eventoContainer.create({
        data: {
          containerId: container.id, statusDe: de, statusPara: s, ocorridoEm, usuarioEmail: email,
          observacao: completada ? "Etapa completada pela portaria (não registrada pela operação)" : `${movimento === "ENTRADA" ? "Entrada" : "Saída"} registrada pela portaria`,
        },
      });
      de = s;
    }
    await registrarLog({
      usuarioEmail: email, acao: "AVANCAR", entidade: "Container", entidadeId: container.id,
      descricao: `Container ${numero}: ${movimento === "ENTRADA" ? "entrada" : "saída"} pela portaria (${nome(alvo)})` +
        (completadas.length ? `; etapas completadas: ${completadas.map(nome).join(", ")}` : ""),
    }, tx);
    if (e.status === "LIVRE") {
      const atual = await tx.etiquetaQR.findUnique({ where: { id: e.id } });
      if (atual.status !== "LIVRE") throw erroHttp(409, `A etiqueta ${e.codigo} acabou de ser usada por outra pessoa. Leia o QR de novo.`);
      if (anterior) {
        await tx.etiquetaQR.update({
          where: { id: anterior.id },
          data: { status: "CANCELADA", canceladaEm: new Date(), canceladaPor: email, motivoCancelamento: `Substituída pela etiqueta ${e.codigo}` },
        });
      }
      await tx.etiquetaQR.update({ where: { id: e.id }, data: { status: "VINCULADA", containerId: container.id, vinculadaEm: new Date(), vinculadaPor: email } });
      await registrarLog({
        usuarioEmail: email, acao: "VINCULAR", entidade: "EtiquetaQR", entidadeId: e.id,
        descricao: `Etiqueta ${e.codigo} ligada ao container ${numero} na portaria${anterior ? ` (substituiu ${anterior.codigo})` : ""}`,
      }, tx);
    }
    const atualizado = { ...container, ...dados };
    if (reefer) {
      await registrarLeitura({ container: atualizado, temperatura, lidaEm: new Date(), origem: "QRCODE", usuarioEmail: email, extras: { etiquetaId: e.id, ...posicao } }, tx);
    }
    return atualizado;
  });

  await sincronizarAlertas(final.id);
  res.status(201).json({
    ...(await resumo(await buscarEtiqueta(req.params.token), req)),
    resultado: reefer ? avaliar(final, temperatura) : null,
    movimento,
    etapa: nome(alvo),
    completadas: completadas.map(nome),
  });
}));
