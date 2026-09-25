import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { requirePermissao, tem } from "../lib/permissoes.js";
import { registrarLog } from "../lib/auditoria.js";
import { lerConfiguracao } from "../lib/configuracao.js";
import { sincronizarAlertas } from "../lib/alertas.js";
import { montarContainer, serializarLeitura } from "../lib/containerView.js";
import { validarNumeroContainer } from "../lib/iso6346.js";
import { ehReefer, STATUS_ENCERRADOS } from "../lib/prazos.js";
import { texto, inteiro, decimal, dataHora, id as validarId, umDe } from "../lib/validacao.js";
import { montarContextos } from "../lib/previsao.js";
import { registrarLeitura } from "../lib/leituras.js";
import { garantirDistancias, paresDoContainer } from "../lib/rotas.js";

export const containersRouter = Router();

const TIPOS = ["DRY_20", "DRY_40", "HC_40", "REEFER_20", "REEFER_40"];

// Sequência do processo de exportação e o campo de data que cada etapa preenche.
export const FLUXO = ["PROGRAMADO", "COLETADO", "NA_FABRICA", "EM_OPERACAO", "LIBERADO", "SAIU_FABRICA", "ENTREGUE_PORTO"];
const CAMPO_DATA = {
  COLETADO: "coletadoEm",
  NA_FABRICA: "chegadaFabricaEm",
  EM_OPERACAO: "inicioOperacaoEm",
  LIBERADO: "liberadoEm",
  SAIU_FABRICA: "saidaFabricaEm",
  ENTREGUE_PORTO: "entreguePortoEm",
  CANCELADO: "canceladoEm",
};
const ROTULO_STATUS = {
  PROGRAMADO: "Programado",
  COLETADO: "Coletado no porto",
  NA_FABRICA: "Chegou na fábrica",
  EM_OPERACAO: "Em ovação",
  LIBERADO: "Liberado",
  SAIU_FABRICA: "Saiu da fábrica",
  ENTREGUE_PORTO: "Entregue no porto",
  CANCELADO: "Cancelado",
};

// Tolerância para relógio do celular/computador levemente adiantado.
const FOLGA_FUTURO_MS = 5 * 60 * 1000;

const SELECT_LOCAL = { select: { id: true, nome: true, tipo: true, cidade: true, uf: true, latitude: true, longitude: true, filaHoras: true } };
const INCLUDE_BASICO = {
  grupo: true, armador: true, produto: true,
  portoRetirada: SELECT_LOCAL, localCarregamento: SELECT_LOCAL, portoEntrega: SELECT_LOCAL,
};

// Valida um local do trajeto: existe, está ativo (ou já era o atual) e é do tipo certo.
const TIPOS_DO_CAMPO = {
  portoRetiradaId: { tipos: ["PORTO"], rotulo: "Porto de retirada" },
  localCarregamentoId: { tipos: ["FABRICA", "ARMAZEM"], rotulo: "Local de carregamento" },
  portoEntregaId: { tipos: ["PORTO"], rotulo: "Porto de entrega" },
};
async function validarLocais(corpo, atual = {}) {
  const dados = {};
  for (const [campo, { tipos, rotulo }] of Object.entries(TIPOS_DO_CAMPO)) {
    if (!(campo in corpo)) continue;
    if (corpo[campo] === null || corpo[campo] === "") {
      dados[campo] = null;
      continue;
    }
    const localId = validarId(corpo[campo], rotulo);
    const local = await prisma.local.findUnique({ where: { id: localId } });
    if (!local) throw erroHttp(400, `${rotulo}: local não encontrado.`);
    if (!tipos.includes(local.tipo)) throw erroHttp(400, `${rotulo} precisa ser um local do tipo ${tipos.map((t) => t.toLowerCase()).join(" ou ")}.`);
    if (!local.ativo && atual[campo] !== localId) throw erroHttp(400, `${rotulo}: o local "${local.nome}" está inativo.`);
    dados[campo] = localId;
  }
  return dados;
}

// Depois de gravar: calcula/guarda as distâncias do trajeto (pode chamar o serviço de rota).
async function prepararRota(containerId) {
  const c = await prisma.container.findUnique({ where: { id: containerId }, select: { portoRetiradaId: true, localCarregamentoId: true, portoEntregaId: true } });
  if (c) await garantirDistancias(paresDoContainer(c));
}

async function buscarContainer(containerId) {
  const c = await prisma.container.findUnique({ where: { id: containerId }, include: INCLUDE_BASICO });
  if (!c) throw erroHttp(404, "Container não encontrado.");
  return c;
}

async function detalhe(containerId) {
  const [c, config] = await Promise.all([
    prisma.container.findUnique({
      where: { id: containerId },
      include: {
        ...INCLUDE_BASICO,
        // Ordem de registro = ordem do processo (a sequência é garantida no avanço). Ordenar por
        // ocorridoEm embaralharia etapas registradas no mesmo minuto da criação.
        eventos: { orderBy: { id: "asc" } },
        alertas: { orderBy: { abertoEm: "desc" } },
        etiquetas: { select: { id: true, codigo: true, status: true, vinculadaEm: true, vinculadaPor: true, canceladaEm: true, motivoCancelamento: true }, orderBy: { id: "asc" } },
      },
    }),
    lerConfiguracao(),
  ]);
  if (!c) throw erroHttp(404, "Container não encontrado.");
  const [leituras, contextos] = await Promise.all([
    prisma.leituraTemperatura.findMany({ where: { containerId }, orderBy: { lidaEm: "asc" }, include: { etiqueta: { select: { codigo: true } } } }),
    montarContextos([c], config),
  ]);
  return { ...montarContainer(c, leituras, new Date(), config, contextos.get(c.id)), leituras: leituras.map(serializarLeitura) };
}

function ultimaDataDoProcesso(c) {
  const datas = Object.values(CAMPO_DATA).map((campo) => c[campo]).filter(Boolean).map((d) => new Date(d).getTime());
  return datas.length ? Math.max(...datas) : null;
}

function validarMomento(ocorridoEm, c) {
  if (ocorridoEm.getTime() > Date.now() + FOLGA_FUTURO_MS) throw erroHttp(400, "A data/hora não pode estar no futuro.");
  const anterior = ultimaDataDoProcesso(c);
  if (anterior && ocorridoEm.getTime() < anterior) {
    throw erroHttp(400, `A data/hora não pode ser anterior à etapa anterior (${new Date(anterior).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}).`);
  }
}

// ---------- Listagem ----------

containersRouter.get("/", asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.situacao === "ativos" || !req.query.situacao) where.status = { notIn: STATUS_ENCERRADOS };
  else if (req.query.situacao === "encerrados") where.status = { in: STATUS_ENCERRADOS };
  if (req.query.status) where.status = umDe(req.query.status, [...FLUXO, "CANCELADO"], "Status");
  if (req.query.grupoId) where.grupoId = validarId(req.query.grupoId, "Grupo");
  if (req.query.busca) {
    const b = String(req.query.busca).trim();
    where.OR = [
      { numero: { contains: b.toUpperCase().replace(/\s/g, "") } },
      { booking: { contains: b, mode: "insensitive" } },
      { placa: { contains: b, mode: "insensitive" } },
    ];
  }
  const limite = req.query.situacao === "ativos" || !req.query.situacao ? undefined : 500;

  const [containers, config] = await Promise.all([
    prisma.container.findMany({
      where,
      include: { ...INCLUDE_BASICO, leituras: { orderBy: { lidaEm: "desc" }, take: 50 } },
      orderBy: { criadoEm: "desc" },
      take: limite,
    }),
    lerConfiguracao(),
  ]);
  const agora = new Date();
  const contextos = await montarContextos(containers, config);
  res.json(containers.map((c) => montarContainer(c, [...c.leituras].reverse(), agora, config, contextos.get(c.id))));
}));

containersRouter.get("/:id", asyncHandler(async (req, res) => {
  res.json(await detalhe(validarId(req.params.id)));
}));

// ---------- Cadastro ----------

containersRouter.post("/", requirePermissao("containers.operar"), asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const { numero, formatoValido, digitoValido } = validarNumeroContainer(b.numero);
  if (!formatoValido) {
    throw erroHttp(400, "Número do container inválido. Formato esperado: 4 letras + 7 dígitos (ex.: MSKU1234565).");
  }
  if (!digitoValido && !b.confirmarDigito) {
    // O front pergunta ao usuário e reenvia com confirmarDigito = true se ele confirmar.
    return res.status(422).json({ erro: "O dígito verificador não confere. Confira o número digitado.", codigo: "DIGITO_INVALIDO" });
  }
  const tipo = umDe(b.tipo, TIPOS, "Tipo de container", { obrigatorio: true });
  const grupoId = validarId(b.grupoId, "Cliente / Fábrica");
  const armadorId = validarId(b.armadorId, "Armador");
  const produtoId = b.produtoId ? validarId(b.produtoId, "Produto") : null;

  const [grupo, armador, produto] = await Promise.all([
    prisma.grupoOperacao.findUnique({ where: { id: grupoId } }),
    prisma.armador.findUnique({ where: { id: armadorId } }),
    produtoId ? prisma.produto.findUnique({ where: { id: produtoId } }) : null,
  ]);
  if (!grupo?.ativo) throw erroHttp(400, "Cliente / Fábrica inexistente ou inativo.");
  if (!armador?.ativo) throw erroHttp(400, "Armador inexistente ou inativo.");
  if (produtoId && !produto?.ativo) throw erroHttp(400, "Produto inexistente ou inativo.");
  if (ehReefer(tipo) && !produto) throw erroHttp(400, "Container reefer precisa de um produto (define a faixa de temperatura).");

  const coletadoEm = dataHora(b.coletadoEm, "Data/hora da coleta");
  if (coletadoEm && coletadoEm.getTime() > Date.now() + FOLGA_FUTURO_MS) throw erroHttp(400, "A coleta não pode estar no futuro.");
  // Local de carregamento não informado → o local padrão do Cliente/Fábrica.
  const locais = await validarLocais({ localCarregamentoId: grupo.localId, ...b });

  const dados = {
    numero,
    tipo,
    grupoId,
    armadorId,
    produtoId,
    ...locais,
    booking: texto(b.booking, "Booking", { max: 60 }),
    lacre: texto(b.lacre, "Lacre", { max: 60 }),
    navio: texto(b.navio, "Navio", { max: 120 }),
    deadline: dataHora(b.deadline, "Deadline"),
    placa: texto(b.placa, "Placa", { max: 20 })?.toUpperCase() ?? null,
    motorista: texto(b.motorista, "Motorista", { max: 120 }),
    posicaoPatio: texto(b.posicaoPatio, "Posição no pátio", { max: 40 }),
    observacao: texto(b.observacao, "Observação", { max: 1000 }),
    metaEstadiaHoras: grupo.metaEstadiaHoras,
    alertaEstadiaHoras: grupo.alertaEstadiaHoras,
    custoEstadiaPorHora: grupo.custoEstadiaPorHora,
    freeTimeDias: armador.freeTimeDias,
    valorDiaria: armador.valorDiaria,
    moeda: armador.moeda,
    alertaDemurrageDias: armador.alertaDemurrageDias,
    setpoint: ehReefer(tipo) ? produto.setpoint : null,
    tempMin: ehReefer(tipo) ? produto.tempMin : null,
    tempMax: ehReefer(tipo) ? produto.tempMax : null,
    toleranciaMinutos: ehReefer(tipo) ? produto.toleranciaMinutos : null,
    status: coletadoEm ? "COLETADO" : "PROGRAMADO",
    coletadoEm,
    criadoPor: req.usuario.email,
  };

  const criado = await prisma.$transaction(async (tx) => {
    // Só pode existir uma passagem ativa por número (evita cadastro duplicado).
    const ativo = await tx.container.findFirst({ where: { numero, status: { notIn: STATUS_ENCERRADOS } } });
    if (ativo) throw erroHttp(409, `O container ${numero} já está ativo no sistema (status: ${ROTULO_STATUS[ativo.status]}).`);
    const c = await tx.container.create({ data: dados });
    await tx.eventoContainer.create({
      data: { containerId: c.id, statusDe: null, statusPara: "PROGRAMADO", ocorridoEm: c.criadoEm, usuarioEmail: req.usuario.email },
    });
    if (coletadoEm) {
      await tx.eventoContainer.create({
        data: { containerId: c.id, statusDe: "PROGRAMADO", statusPara: "COLETADO", ocorridoEm: coletadoEm, usuarioEmail: req.usuario.email },
      });
    }
    await registrarLog(
      { usuarioEmail: req.usuario.email, acao: "CRIAR", entidade: "Container", entidadeId: c.id, descricao: `Container ${numero} cadastrado`, dadosDepois: c },
      tx
    );
    return c;
  });

  await prepararRota(criado.id);
  await sincronizarAlertas(criado.id);
  res.status(201).json(await detalhe(criado.id));
}));

// Edição de dados cadastrais e, por supervisor, dos prazos negociados (free time, meta, faixa).
containersRouter.patch("/:id", requirePermissao("containers.operar"), asyncHandler(async (req, res) => {
  const containerId = validarId(req.params.id);
  const antes = await buscarContainer(containerId);
  const b = req.body ?? {};
  const dados = {};
  for (const [campo, rotulo, max] of [
    ["booking", "Booking", 60], ["lacre", "Lacre", 60], ["navio", "Navio", 120], ["placa", "Placa", 20],
    ["motorista", "Motorista", 120], ["posicaoPatio", "Posição no pátio", 40], ["observacao", "Observação", 1000],
  ]) {
    if (campo in b) dados[campo] = texto(b[campo], rotulo, { max });
  }
  if (dados.placa) dados.placa = dados.placa.toUpperCase();
  if ("deadline" in b) dados.deadline = dataHora(b.deadline, "Deadline");
  Object.assign(dados, await validarLocais(b, antes));

  const camposPrazo = ["metaEstadiaHoras", "custoEstadiaPorHora", "freeTimeDias", "setpoint", "tempMin", "tempMax", "toleranciaMinutos"];
  if (camposPrazo.some((c) => c in b)) {
    if (!tem(req, "containers.prazos")) {
      throw erroHttp(403, "Seu usuário não tem a permissão \"Alterar prazos do container\". Peça a um administrador.");
    }
    if ("metaEstadiaHoras" in b) dados.metaEstadiaHoras = inteiro(b.metaEstadiaHoras, "Meta de estadia (h)", { obrigatorio: true, min: 1, max: 2000 });
    if ("custoEstadiaPorHora" in b) dados.custoEstadiaPorHora = decimal(b.custoEstadiaPorHora, "Custo por hora excedida", { min: 0 });
    if ("freeTimeDias" in b) dados.freeTimeDias = inteiro(b.freeTimeDias, "Free time (dias)", { obrigatorio: true, min: 0, max: 365 });
    if (ehReefer(antes.tipo)) {
      for (const [campo, rotulo] of [["setpoint", "Setpoint"], ["tempMin", "Temperatura mínima"], ["tempMax", "Temperatura máxima"]]) {
        if (campo in b) dados[campo] = decimal(b[campo], rotulo, { obrigatorio: true, min: -60, max: 60 });
      }
      if ("toleranciaMinutos" in b) dados.toleranciaMinutos = inteiro(b.toleranciaMinutos, "Tolerância (min)", { obrigatorio: true, min: 0, max: 1440 });
      const min = Number(dados.tempMin ?? antes.tempMin);
      const max = Number(dados.tempMax ?? antes.tempMax);
      if (min > max) throw erroHttp(400, "A temperatura mínima não pode ser maior que a máxima.");
    }
  }

  const depois = await prisma.container.update({ where: { id: containerId }, data: dados });
  await registrarLog({
    usuarioEmail: req.usuario.email,
    acao: "ALTERAR",
    entidade: "Container",
    entidadeId: containerId,
    descricao: `Container ${antes.numero} alterado (${Object.keys(dados).join(", ") || "sem mudanças"})`,
    dadosAntes: antes,
    dadosDepois: depois,
  });
  if (Object.keys(TIPOS_DO_CAMPO).some((c) => c in dados)) await prepararRota(containerId);
  await sincronizarAlertas(containerId);
  res.json(await detalhe(containerId));
}));

// ---------- Etapas ----------

containersRouter.post("/:id/avancar", requirePermissao("containers.operar"), asyncHandler(async (req, res) => {
  const containerId = validarId(req.params.id);
  const b = req.body ?? {};
  const ocorridoEm = dataHora(b.ocorridoEm, "Data/hora") ?? new Date();
  const observacao = texto(b.observacao, "Observação", { max: 1000 });

  await prisma.$transaction(async (tx) => {
    const c = await tx.container.findUnique({ where: { id: containerId } });
    if (!c) throw erroHttp(404, "Container não encontrado.");
    const posicao = FLUXO.indexOf(c.status);
    if (posicao === -1 || posicao === FLUXO.length - 1) throw erroHttp(409, "Este container já está encerrado.");
    const proximo = FLUXO[posicao + 1];
    // O front envia a etapa esperada: se outra pessoa avançou antes, evita pular uma etapa sem querer.
    if (b.statusPara && b.statusPara !== proximo) {
      throw erroHttp(409, `O container já mudou de etapa (agora: ${ROTULO_STATUS[c.status]}). Atualize a tela.`);
    }
    validarMomento(ocorridoEm, c);
    await tx.container.update({ where: { id: containerId }, data: { status: proximo, [CAMPO_DATA[proximo]]: ocorridoEm } });
    await tx.eventoContainer.create({
      data: { containerId, statusDe: c.status, statusPara: proximo, ocorridoEm, observacao, usuarioEmail: req.usuario.email },
    });
    await registrarLog(
      {
        usuarioEmail: req.usuario.email,
        acao: "AVANCAR",
        entidade: "Container",
        entidadeId: containerId,
        descricao: `Container ${c.numero}: ${ROTULO_STATUS[c.status]} → ${ROTULO_STATUS[proximo]}`,
      },
      tx
    );
  });

  await sincronizarAlertas(containerId);
  res.json(await detalhe(containerId));
}));

// Desfaz a última etapa registrada (erro de digitação/clique). O evento some da linha do tempo,
// mas fica registrado no log de auditoria.
containersRouter.post("/:id/desfazer", requirePermissao("containers.corrigir"), asyncHandler(async (req, res) => {
  const containerId = validarId(req.params.id);
  await prisma.$transaction(async (tx) => {
    const c = await tx.container.findUnique({ where: { id: containerId } });
    if (!c) throw erroHttp(404, "Container não encontrado.");
    const ultimo = await tx.eventoContainer.findFirst({ where: { containerId }, orderBy: [{ registradoEm: "desc" }, { id: "desc" }] });
    if (!ultimo || !ultimo.statusDe || ultimo.statusPara !== c.status) throw erroHttp(409, "Não há etapa para desfazer.");
    await tx.container.update({ where: { id: containerId }, data: { status: ultimo.statusDe, [CAMPO_DATA[c.status]]: null } });
    await tx.eventoContainer.delete({ where: { id: ultimo.id } });
    await registrarLog(
      {
        usuarioEmail: req.usuario.email,
        acao: "DESFAZER",
        entidade: "Container",
        entidadeId: containerId,
        descricao: `Container ${c.numero}: etapa "${ROTULO_STATUS[c.status]}" desfeita (volta para ${ROTULO_STATUS[ultimo.statusDe]})`,
        dadosAntes: ultimo,
      },
      tx
    );
  });
  await sincronizarAlertas(containerId);
  res.json(await detalhe(containerId));
}));

containersRouter.post("/:id/cancelar", requirePermissao("containers.corrigir"), asyncHandler(async (req, res) => {
  const containerId = validarId(req.params.id);
  const motivo = texto(req.body?.motivo, "Motivo do cancelamento", { obrigatorio: true, max: 1000 });
  await prisma.$transaction(async (tx) => {
    const c = await tx.container.findUnique({ where: { id: containerId } });
    if (!c) throw erroHttp(404, "Container não encontrado.");
    if (STATUS_ENCERRADOS.includes(c.status)) throw erroHttp(409, "Este container já está encerrado.");
    const agora = new Date();
    await tx.container.update({ where: { id: containerId }, data: { status: "CANCELADO", canceladoEm: agora } });
    await tx.eventoContainer.create({
      data: { containerId, statusDe: c.status, statusPara: "CANCELADO", ocorridoEm: agora, observacao: motivo, usuarioEmail: req.usuario.email },
    });
    await registrarLog(
      { usuarioEmail: req.usuario.email, acao: "CANCELAR", entidade: "Container", entidadeId: containerId, descricao: `Container ${c.numero} cancelado: ${motivo}` },
      tx
    );
  });
  await sincronizarAlertas(containerId);
  res.json(await detalhe(containerId));
}));

// ---------- Temperatura (leitura manual) ----------

containersRouter.post("/:id/leituras", requirePermissao("containers.operar"), asyncHandler(async (req, res) => {
  const containerId = validarId(req.params.id);
  const c = await buscarContainer(containerId);
  const temperatura = decimal(req.body?.temperatura, "Temperatura", { obrigatorio: true, min: -60, max: 60 });
  const lidaEm = dataHora(req.body?.lidaEm, "Horário da leitura") ?? new Date();
  await registrarLeitura({ container: c, temperatura, lidaEm, origem: "MANUAL", usuarioEmail: req.usuario.email });
  await sincronizarAlertas(containerId);
  res.status(201).json(await detalhe(containerId));
}));

export { ROTULO_STATUS };
