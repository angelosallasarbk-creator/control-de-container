import express, { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { requirePermissao, tem } from "../lib/permissoes.js";
import { registrarLog } from "../lib/auditoria.js";
import { lerConfiguracao } from "../lib/configuracao.js";
import { sincronizarAlertas } from "../lib/alertas.js";
import { montarContainer, serializarLeitura, CONTAGEM_QR } from "../lib/containerView.js";
import { validarNumeroContainer } from "../lib/iso6346.js";
import { ehReefer, controlaTemperatura, STATUS_ENCERRADOS, PRODUTO_COM_TEMPERATURA } from "../lib/prazos.js";
import { texto, inteiro, decimal, dataHora, id as validarId, umDe } from "../lib/validacao.js";
import { montarContextos } from "../lib/previsao.js";
import { registrarLeitura } from "../lib/leituras.js";
import { garantirDistancias, paresDoContainer } from "../lib/rotas.js";
import { resumoRastreamento, solicitarPosicaoManual } from "../lib/rastreamento.js";
import { gerarModelo, lerPlanilha } from "../lib/importacaoContainers.js";
import { ROTULO_FUNCAO, SELECT_LOCAIS_ETAPAS, SELECT_TIPO, rotulosDasEtapas } from "../lib/tiposLocal.js";
import { SELECT_PARADA, serializarParadas, validarTrajeto, gravarTrajeto, registrarPassagem, registrarMudancaTrajeto } from "../lib/trajeto.js";
import { etapasDoContainer, regrasDeLocal, fluxoDoTipo, motivoLocalForaDaRegra, SELECT_TIPO_OPERACAO } from "../lib/fluxo.js";
import { Prisma } from "@prisma/client";

export const containersRouter = Router();

export const TIPOS = ["DRY_20", "DRY_40", "HC_40", "REEFER_20", "REEFER_40"];

// Sequência do processo de exportação e o campo de data que cada etapa preenche. Cada container
// segue o fluxo do seu Tipo de Operação (lib/fluxo.js), que usa estas etapas (ou parte delas).
export const FLUXO = ["PROGRAMADO", "COLETADO", "NA_FABRICA", "EM_OPERACAO", "LIBERADO", "SAIU_FABRICA", "ENTREGUE_PORTO"];
export const CAMPO_DATA = {
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

const SELECT_LOCAL = { select: { id: true, nome: true, tipo: SELECT_TIPO, cidade: true, uf: true, latitude: true, longitude: true, filaHoras: true } };
const INCLUDE_BASICO = {
  grupo: true, armador: true, produto: true,
  portoRetirada: SELECT_LOCAL, localCarregamento: SELECT_LOCAL, portoEntrega: SELECT_LOCAL,
  tipoOperacao: { select: { id: true, nome: true } },
  ...CONTAGEM_QR,
};

// Valida um local do trajeto: existe, está ativo (ou já era o atual) e o tipo tem a função certa.
const FUNCAO_DO_CAMPO = {
  portoRetiradaId: { funcao: "RETIRADA_ENTREGA", rotulo: "Local de retirada", exemplo: "porto ou terminal ferroviário" },
  localCarregamentoId: { funcao: "CARREGAMENTO", rotulo: "Local de carregamento", exemplo: "fábrica ou armazém" },
  portoEntregaId: { funcao: "RETIRADA_ENTREGA", rotulo: "Local de entrega", exemplo: "porto ou terminal ferroviário" },
};

// Nome da etapa conforme o tipo do local (ex.: "Coleta ferroviária"); sem local, o genérico.
const nomeEtapa = (c, status) => rotulosDasEtapas(c)[status] ?? ROTULO_STATUS[status];
// Local sempre com o tipo (mesma forma em todo o cache: a chave não distingue os argumentos).
const COM_TIPO = { include: { tipo: true } };
// Consulta de cadastro com cache opcional: na importação em lote cada cadastro é lido uma vez só.
function buscarCadastro(cache, modelo, id, args = {}) {
  if (!cache) return prisma[modelo].findUnique({ where: { id }, ...args });
  const chave = `${modelo}:${id}`;
  if (!cache.has(chave)) cache.set(chave, prisma[modelo].findUnique({ where: { id }, ...args }));
  return cache.get(chave);
}

// regras: tipo de local exigido em cada campo pelo fluxo do Tipo de Operação (padrão: o do container).
export async function validarLocais(corpo, atual = {}, cache = null, regras = regrasDeLocal(atual)) {
  const dados = {};
  for (const [campo, { rotulo, exemplo }] of Object.entries(FUNCAO_DO_CAMPO)) {
    if (!(campo in corpo)) continue;
    if (corpo[campo] === null || corpo[campo] === "") {
      dados[campo] = null;
      continue;
    }
    const localId = validarId(corpo[campo], rotulo);
    const local = await buscarCadastro(cache, "local", localId, COM_TIPO);
    if (!local) throw erroHttp(400, `${rotulo}: local não encontrado.`);
    const regra = regras[campo];
    const tipoExigido = regra?.tipoLocalId ? await buscarCadastro(cache, "tipoLocal", regra.tipoLocalId) : null;
    const motivo = motivoLocalForaDaRegra(local, regra, tipoExigido?.nome);
    if (motivo) {
      const dica = regra?.funcao && !regra.tipoLocalId ? `; escolha um local de ${ROTULO_FUNCAO[regra.funcao].toLowerCase()}${regra.funcao === FUNCAO_DO_CAMPO[campo].funcao ? ` (ex.: ${exemplo})` : ""}` : "";
      throw erroHttp(400, `${rotulo}: ${motivo}${dica}.`);
    }
    if (!local.ativo && atual[campo] !== localId) throw erroHttp(400, `${rotulo}: o local "${local.nome}" está inativo.`);
    dados[campo] = localId;
  }
  return dados;
}

// Depois de gravar: calcula/guarda as distâncias do trajeto (pode chamar o serviço de rota).
export async function prepararRota(containerId) {
  const c = await prisma.container.findUnique({
    where: { id: containerId },
    select: { portoRetiradaId: true, localCarregamentoId: true, portoEntregaId: true, paradas: { select: { id: true, localId: true, fase: true, ordem: true } } },
  });
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
        paradas: { select: SELECT_PARADA },
        mudancasTrajeto: { orderBy: { id: "asc" } },
      },
    }),
    lerConfiguracao(),
  ]);
  if (!c) throw erroHttp(404, "Container não encontrado.");
  const [leituras, contextos] = await Promise.all([
    prisma.leituraTemperatura.findMany({ where: { containerId }, orderBy: { lidaEm: "asc" }, include: { etiqueta: { select: { codigo: true } } } }),
    montarContextos([c], config),
  ]);
  return { ...montarContainer(c, leituras, new Date(), config, contextos.get(c.id)), leituras: leituras.map(serializarLeitura), paradas: serializarParadas(c.paradas) };
}

function ultimaDataDoProcesso(c) {
  const datas = Object.values(CAMPO_DATA).map((campo) => c[campo]).filter(Boolean).map((d) => new Date(d).getTime());
  return datas.length ? Math.max(...datas) : null;
}

export function validarMomento(ocorridoEm, c) {
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

// ---------- Cadastro em lote por planilha (Baixar modelo / Upload) ----------

containersRouter.get("/modelo", requirePermissao("containers.operar"), asyncHandler(async (_req, res) => {
  const arquivo = await gerarModelo();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="modelo-containers.xlsx"');
  res.send(Buffer.from(arquivo));
}));

// Confere cada linha com a MESMA validação do cadastro na tela (sem gravar).
async function conferirLinhas(linhas, email) {
  const cache = new Map();
  const ativos = new Set(
    (await prisma.container.findMany({
      where: { numero: { in: linhas.map((l) => l.numero).filter(Boolean) }, status: { notIn: STATUS_ENCERRADOS } },
      select: { numero: true },
    })).map((c) => c.numero)
  );
  for (const l of linhas) {
    if (l.erro) continue;
    try {
      if (ativos.has(l.numero)) throw erroHttp(409, "Já está ativo no sistema (não é sobrescrito).");
      l.dados = await validarNovoContainer(l.corpo, email, { cache });
    } catch (err) {
      if (!err.status) throw err;
      l.erro = err.extras?.codigo === "DIGITO_INVALIDO"
        ? "O dígito verificador não confere. Se o número estiver certo, escreva SIM na coluna \"Dígito conferido\"."
        : err.message;
    }
  }
}

// Corpo = o arquivo .xlsx (application/octet-stream) — UMA requisição por etapa. Sem ?confirmar=1
// só devolve a prévia; com ?confirmar=1 grava as linhas válidas de uma vez (uma transação, inserção
// em lote) e ignora as com erro. Cadastros são lidos uma vez só (cache) e as distâncias do
// trajeto são calculadas para o lote inteiro (pares repetidos uma vez só).
containersRouter.post(
  "/importar",
  requirePermissao("containers.operar"),
  express.raw({ type: () => true, limit: "5mb" }),
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw erroHttp(400, "Envie o arquivo da planilha (.xlsx).");
    const email = req.usuario.email;
    const confirmar = req.query.confirmar === "1";
    const { linhas } = await lerPlanilha(req.body);
    await conferirLinhas(linhas, email);

    const criados = [];
    if (confirmar) {
      const validas = linhas.filter((x) => !x.erro);
      const linhaDe = new Map(validas.map((l) => [l.numero, l]));
      const r = validas.length
        ? await prisma.$transaction(
          (tx) => gravarContainersEmLote(tx, validas.map((l) => l.dados), email, (c) => `Container ${c.numero} cadastrado por planilha (linha ${linhaDe.get(c.numero).linha})`),
          { timeout: 120_000, maxWait: 10_000 }
        )
        : { criados: [], recusados: [] };
      for (const c of r.criados) {
        linhaDe.get(c.numero).importado = true;
        criados.push(c.id);
      }
      // Cadastrado por outra pessoa entre a conferência e a confirmação.
      for (const numero of r.recusados) linhaDe.get(numero).erro = "Já está ativo no sistema (cadastrado enquanto a planilha era conferida).";
      // Distâncias do lote de uma vez (pares repetidos só uma vez) e alertas com a mesma configuração.
      await garantirDistancias(r.criados.flatMap(paresDoContainer)).catch((err) => console.error("Importação: distâncias do lote:", err.message));
      const config = await lerConfiguracao();
      for (const id of criados) {
        await sincronizarAlertas(id, { config }).catch((err) => console.error(`Importação: alertas do container ${id}:`, err.message));
      }
      const comErro = linhas.filter((x) => x.erro).length;
      await registrarLog({
        usuarioEmail: email, acao: "IMPORTAR", entidade: "Container",
        descricao: `Cadastro por planilha: ${criados.length} container(s) cadastrado(s)${comErro ? `, ${comErro} linha(s) recusada(s)` : ""}`,
      });
    }
    res.json({
      confirmado: confirmar,
      total: linhas.length,
      validos: linhas.filter((l) => !l.erro).length,
      comErro: linhas.filter((l) => l.erro).length,
      importados: criados.length,
      linhas: linhas.map((l) => ({
        linha: l.linha, numero: l.numero, erro: l.erro ?? null, importado: Boolean(l.importado),
        tipo: l.dados?.tipo ?? l.corpo?.tipo ?? null,
      })),
    });
  })
);

containersRouter.get("/:id", asyncHandler(async (req, res) => {
  res.json(await detalhe(validarId(req.params.id)));
}));

// Botão "Solicitar posição" da aba Rastreamento: SMS agora para o responsável atual.
containersRouter.post("/:id/solicitar-posicao", requirePermissao("containers.operar"), asyncHandler(async (req, res) => {
  const r = await solicitarPosicaoManual({ containerId: validarId(req.params.id), solicitante: req.usuario });
  res.status(201).json({ ...r, mensagem: r.status === "SIMULADA" ? `Pedido registrado para ${r.para} (SMS simulado — chave do Brevo não configurada).` : `SMS enviado para ${r.para}.` });
}));

// Aba "Rastreamento" da ficha: responsável pelos SMS, posições GPS e SMS enviados.
containersRouter.get("/:id/rastreamento", asyncHandler(async (req, res) => {
  const r = await resumoRastreamento(validarId(req.params.id));
  if (!r) throw erroHttp(404, "Container não encontrado.");
  res.json(r);
}));

// ---------- Cadastro ----------

// Valida um container novo (cadastro na tela ou pelo QR do transportador) e devolve os dados
// prontos para gravar, com os prazos copiados dos cadastros.
export async function validarNovoContainer(b, usuarioEmail, { cache = null } = {}) {
  const { numero, formatoValido, digitoValido } = validarNumeroContainer(b.numero);
  if (!formatoValido) {
    throw erroHttp(400, "Número do container inválido. Formato esperado: 4 letras + 7 dígitos (ex.: MSKU1234565).");
  }
  if (!digitoValido && !b.confirmarDigito) {
    // O front pergunta ao usuário e reenvia com confirmarDigito = true se ele confirmar.
    throw erroHttp(422, "O dígito verificador não confere. Confira o número digitado.", { codigo: "DIGITO_INVALIDO" });
  }
  const tipo = umDe(b.tipo, TIPOS, "Tipo de container", { obrigatorio: true });
  const grupoId = validarId(b.grupoId, "Ponto de Carregamento");
  const armadorId = validarId(b.armadorId, "Armador");
  const produtoId = b.produtoId ? validarId(b.produtoId, "Produto") : null;

  const [grupo, armador, produto] = await Promise.all([
    buscarCadastro(cache, "grupoOperacao", grupoId),
    buscarCadastro(cache, "armador", armadorId),
    produtoId ? buscarCadastro(cache, "produto", produtoId) : null,
  ]);
  if (!grupo?.ativo) throw erroHttp(400, "Ponto de Carregamento inexistente ou inativo.");
  if (!armador?.ativo) throw erroHttp(400, "Armador inexistente ou inativo.");
  if (produtoId && !produto?.ativo) throw erroHttp(400, "Produto inexistente ou inativo.");
  if (ehReefer(tipo) && !produto) throw erroHttp(400, "Container reefer precisa de um produto (define a faixa de temperatura).");
  // Faixa de temperatura só para reefer com produto Congelado/Refrigerado (Carga Seca não tem).
  const comFaixa = ehReefer(tipo) && Boolean(produto) && PRODUTO_COM_TEMPERATURA.includes(produto.categoria);

  const coletadoEm = dataHora(b.coletadoEm, "Data/hora da coleta");
  if (coletadoEm && coletadoEm.getTime() > Date.now() + FOLGA_FUTURO_MS) throw erroHttp(400, "A coleta não pode estar no futuro.");

  // Tipo de Operação (sem informar: o padrão) — o fluxo dele é copiado para o container.
  const tipoOperacao = await tipoOperacaoDoCadastro(b.tipoOperacaoId, cache);
  const fluxo = tipoOperacao ? fluxoDoTipo(tipoOperacao) : null;
  const regras = regrasDeLocal({ fluxo });
  // Locais não informados: os sugeridos no fluxo; carregamento = o sugerido ou o local do Ponto de
  // Carregamento, só se o fluxo tiver local de operação.
  const sugeridos = Object.fromEntries(Object.entries(fluxo?.sugeridos ?? {}).filter(([, v]) => v));
  // O local do Ponto de Carregamento só entra se atender ao tipo de local exigido pelo fluxo.
  const localDoGrupo = grupo.localId ? await buscarCadastro(cache, "local", grupo.localId, COM_TIPO) : null;
  const grupoServe = localDoGrupo && !motivoLocalForaDaRegra(localDoGrupo, regras.localCarregamentoId);
  const padraoCarregamento = regras.localCarregamentoId === null ? {} : { localCarregamentoId: sugeridos.localCarregamentoId ?? (grupoServe ? grupo.localId : null) };
  const locais = await validarLocais({ ...sugeridos, ...padraoCarregamento, ...b }, {}, cache, regras);
  // Passagens do fluxo com local sugerido (ativo) viram paradas do trajeto.
  if (fluxo) {
    const passagens = [];
    for (const p of fluxo.passagens) {
      const local = p.localId ? await buscarCadastro(cache, "local", p.localId, COM_TIPO) : null;
      if (local?.ativo) passagens.push(p);
    }
    fluxo.passagens = passagens;
  }

  const dados = {
    numero,
    tipo,
    grupoId,
    armadorId,
    produtoId,
    ...locais,
    tipoOperacaoId: tipoOperacao?.id ?? null,
    fluxo: fluxo ?? Prisma.DbNull,
    booking: texto(b.booking, "Booking", { max: 60 }),
    lacre: texto(b.lacre, "Lacre", { max: 60 }),
    navio: texto(b.navio, "Navio", { max: 120 }),
    deadline: dataHora(b.deadline, "Deadline"),
    coletaProgramadaEm: dataHora(b.coletaProgramadaEm, "Coleta programada para"),
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
    setpoint: comFaixa ? produto.setpoint : null,
    tempMin: comFaixa ? produto.tempMin : null,
    tempMax: comFaixa ? produto.tempMax : null,
    toleranciaMinutos: comFaixa ? produto.toleranciaMinutos : null,
    status: coletadoEm ? "COLETADO" : "PROGRAMADO",
    coletadoEm,
    criadoPor: usuarioEmail,
  };
  return dados;
}

// Tipo de Operação informado (ativo) ou o padrão. Sem nenhum cadastrado: null (fluxo de sempre).
async function tipoOperacaoDoCadastro(valor, cache) {
  if (valor !== undefined && valor !== null && valor !== "") {
    const tipo = await buscarCadastro(cache, "tipoOperacao", validarId(valor, "Tipo de operação"), SELECT_TIPO_OPERACAO);
    if (!tipo?.ativo) throw erroHttp(400, "Tipo de operação inexistente ou inativo.");
    return tipo;
  }
  const chave = "tipoOperacao:padrao";
  const buscar = () => prisma.tipoOperacao.findFirst({ where: { padrao: true, ativo: true }, ...SELECT_TIPO_OPERACAO });
  if (!cache) return buscar();
  if (!cache.has(chave)) cache.set(chave, buscar());
  return cache.get(chave);
}

// Paradas iniciais do trajeto: as passagens do fluxo do Tipo de Operação (com local sugerido).
const paradasDoFluxo = (c) => {
  const ordem = { ANTES_CARREGAMENTO: 0, APOS_CARREGAMENTO: 0 };
  return (c.fluxo?.passagens ?? []).filter((p) => p.localId).map((p) => ({ containerId: c.id, localId: p.localId, fase: p.fase, ordem: ordem[p.fase]++ }));
};

// Grava o container novo (dentro da transação de quem chama) com os eventos e o log.
export async function gravarNovoContainer(tx, dados, usuarioEmail, descricao = null) {
  const { numero, coletadoEm } = dados;
  // Só pode existir uma passagem ativa por número (evita cadastro duplicado).
  const ativo = await tx.container.findFirst({ where: { numero, status: { notIn: STATUS_ENCERRADOS } } });
  if (ativo) throw erroHttp(409, `O container ${numero} já está ativo no sistema (status: ${ROTULO_STATUS[ativo.status]}).`);
  // Dois cadastros do mesmo número ao mesmo tempo: o índice único parcial (v3.2) barra o segundo.
  const c = await tx.container.create({ data: dados }).catch((err) => {
    if (err.code === "P2002") throw erroHttp(409, `O container ${numero} acabou de ser cadastrado por outra pessoa.`);
    throw err;
  });
  const paradas = paradasDoFluxo(c);
  if (paradas.length) await tx.paradaContainer.createMany({ data: paradas });
  await tx.eventoContainer.create({
    data: { containerId: c.id, statusDe: null, statusPara: "PROGRAMADO", ocorridoEm: c.criadoEm, usuarioEmail },
  });
  if (coletadoEm) {
    await tx.eventoContainer.create({
      data: { containerId: c.id, statusDe: "PROGRAMADO", statusPara: "COLETADO", ocorridoEm: coletadoEm, usuarioEmail },
    });
  }
  await registrarLog(
    { usuarioEmail, acao: "CRIAR", entidade: "Container", entidadeId: c.id, descricao: descricao ?? `Container ${numero} cadastrado`, dadosDepois: c },
    tx
  );
  return c;
}

/**
 * Grava vários containers novos de uma vez (importação por planilha), numa transação só:
 * 1 consulta de duplicados + 1 inserção dos containers + 1 dos eventos + 1 do log.
 * Números que ficaram ativos entre a conferência e a confirmação são devolvidos em `recusados`.
 */
export async function gravarContainersEmLote(tx, lista, usuarioEmail, descricao) {
  const ativos = new Set((await tx.container.findMany({
    where: { numero: { in: lista.map((d) => d.numero) }, status: { notIn: STATUS_ENCERRADOS } }, select: { numero: true },
  })).map((c) => c.numero));
  const livres = lista.filter((d) => !ativos.has(d.numero));
  if (!livres.length) return { criados: [], recusados: [...ativos] };
  const criados = await tx.container.createManyAndReturn({ data: livres }).catch((err) => {
    if (err.code === "P2002") throw erroHttp(409, "Algum desses containers acabou de ser cadastrado por outra pessoa. Confira a planilha de novo.");
    throw err;
  });
  const paradas = criados.flatMap(paradasDoFluxo);
  if (paradas.length) await tx.paradaContainer.createMany({ data: paradas });
  await tx.eventoContainer.createMany({
    data: criados.flatMap((c) => [
      { containerId: c.id, statusDe: null, statusPara: "PROGRAMADO", ocorridoEm: c.criadoEm, usuarioEmail },
      ...(c.coletadoEm ? [{ containerId: c.id, statusDe: "PROGRAMADO", statusPara: "COLETADO", ocorridoEm: c.coletadoEm, usuarioEmail }] : []),
    ]),
  });
  await tx.logAuditoria.createMany({
    data: criados.map((c) => ({
      usuarioEmail, acao: "CRIAR", entidade: "Container", entidadeId: String(c.id), descricao: descricao(c), dadosDepois: JSON.stringify(c),
    })),
  });
  return { criados, recusados: [...ativos] };
}

containersRouter.post("/", requirePermissao("containers.operar"), asyncHandler(async (req, res) => {
  const dados = await validarNovoContainer(req.body ?? {}, req.usuario.email);
  const criado = await prisma.$transaction((tx) => gravarNovoContainer(tx, dados, req.usuario.email));
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
  if ("coletaProgramadaEm" in b) dados.coletaProgramadaEm = dataHora(b.coletaProgramadaEm, "Coleta programada para");
  Object.assign(dados, await validarLocais(b, antes));

  const camposPrazo = ["metaEstadiaHoras", "custoEstadiaPorHora", "freeTimeDias", "setpoint", "tempMin", "tempMax", "toleranciaMinutos"];
  if (camposPrazo.some((c) => c in b)) {
    if (!tem(req, "containers.prazos")) {
      throw erroHttp(403, "Seu usuário não tem a permissão \"Alterar prazos do container\". Peça a um administrador.");
    }
    if ("metaEstadiaHoras" in b) dados.metaEstadiaHoras = inteiro(b.metaEstadiaHoras, "Meta de estadia (h)", { obrigatorio: true, min: 1, max: 2000 });
    if ("custoEstadiaPorHora" in b) dados.custoEstadiaPorHora = decimal(b.custoEstadiaPorHora, "Custo por hora excedida", { min: 0 });
    if ("freeTimeDias" in b) dados.freeTimeDias = inteiro(b.freeTimeDias, "Free time (dias)", { obrigatorio: true, min: 0, max: 365 });
    if (controlaTemperatura(antes)) {
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
  // Local de retirada/carregamento/entrega trocado na edição → Histórico (com antes e depois).
  if (Object.keys(FUNCAO_DO_CAMPO).some((c) => c in dados)) {
    await registrarMudancaTrajeto(prisma, { container: antes, antes, depois, usuarioEmail: req.usuario.email, origem: "FICHA" });
  }
  await registrarLog({
    usuarioEmail: req.usuario.email,
    acao: "ALTERAR",
    entidade: "Container",
    entidadeId: containerId,
    descricao: `Container ${antes.numero} alterado (${Object.keys(dados).join(", ") || "sem mudanças"})`,
    dadosAntes: antes,
    dadosDepois: depois,
  });
  if (Object.keys(FUNCAO_DO_CAMPO).some((c) => c in dados)) await prepararRota(containerId);
  await sincronizarAlertas(containerId);
  res.json(await detalhe(containerId));
}));

// ---------- Etapas ----------

// ---------- Trajeto com pontos de parada (Editar trajeto) ----------
// Corpo: { pontos: [{ papel: RETIRADA|PARADA|CARREGAMENTO|ENTREGA, localId, paradaId? }] } na ordem.
// Recalcula distâncias, ciclo, ETA e alertas; container ainda Programado refaz o Planejado.
containersRouter.put("/:id/trajeto", requirePermissao("containers.operar"), asyncHandler(async (req, res) => {
  const containerId = validarId(req.params.id);
  const c = await prisma.container.findUnique({ where: { id: containerId }, include: { paradas: true } });
  if (!c) throw erroHttp(404, "Container não encontrado.");
  if (STATUS_ENCERRADOS.includes(c.status)) throw erroHttp(409, "Container encerrado: o trajeto não pode mais ser alterado.");
  const trajeto = await validarTrajeto(req.body?.pontos, c);
  const refazPlano = c.status === "PROGRAMADO";
  await prisma.$transaction(async (tx) => {
    await gravarTrajeto(tx, c, trajeto, req.usuario.email);
    if (refazPlano) await tx.container.update({ where: { id: c.id }, data: { planejamento: Prisma.DbNull } });
  });
  await prepararRota(containerId);
  await sincronizarAlertas(containerId); // refaz o Planejado (se foi limpo), previsão e alertas
  res.json(await detalhe(containerId));
}));

async function paradaDoContainer(req) {
  const containerId = validarId(req.params.id);
  const paradaId = validarId(req.params.paradaId, "Parada");
  const c = await prisma.container.findUnique({ where: { id: containerId } });
  if (!c) throw erroHttp(404, "Container não encontrado.");
  const parada = await prisma.paradaContainer.findFirst({ where: { id: paradaId, containerId }, include: { local: true } });
  if (!parada) throw erroHttp(404, "Parada não encontrada neste container.");
  return { c, parada };
}

// Passagem pela parada registrada pela ficha (horário informado ou agora).
containersRouter.post("/:id/paradas/:paradaId/passagem", requirePermissao("containers.operar"), asyncHandler(async (req, res) => {
  const { c, parada } = await paradaDoContainer(req);
  const passouEm = dataHora(req.body?.passouEm, "Data/hora da passagem") ?? new Date();
  await registrarPassagem({ container: c, parada, passouEm, quem: req.usuario.email, origem: "FICHA" });
  await sincronizarAlertas(c.id);
  res.status(201).json(await detalhe(c.id));
}));

// Desfazer passagem (registrada por engano).
containersRouter.delete("/:id/paradas/:paradaId/passagem", requirePermissao("containers.corrigir"), asyncHandler(async (req, res) => {
  const { c, parada } = await paradaDoContainer(req);
  if (!parada.passouEm) throw erroHttp(409, "Esta parada não tem passagem registrada.");
  await prisma.paradaContainer.update({ where: { id: parada.id }, data: { passouEm: null, registradoPor: null, origemRegistro: null, latitude: null, longitude: null, precisaoM: null } });
  await registrarLog({ usuarioEmail: req.usuario.email, acao: "DESFAZER", entidade: "Container", entidadeId: c.id, descricao: `Container ${c.numero}: passagem por ${parada.local.nome} desfeita` });
  await sincronizarAlertas(c.id);
  res.json(await detalhe(c.id));
}));

// Troca de etapa condicionada à etapa lida: se outra requisição mudou antes, nada é gravado (409).
async function mudarStatus(tx, c, data) {
  const r = await tx.container.updateMany({ where: { id: c.id, status: c.status }, data });
  if (r.count !== 1) throw erroHttp(409, `O container ${c.numero} acabou de mudar de etapa por outra pessoa. Atualize a tela.`);
}

containersRouter.post("/:id/avancar", requirePermissao("containers.operar"), asyncHandler(async (req, res) => {
  const containerId = validarId(req.params.id);
  const b = req.body ?? {};
  const ocorridoEm = dataHora(b.ocorridoEm, "Data/hora") ?? new Date();
  const observacao = texto(b.observacao, "Observação", { max: 1000 });

  await prisma.$transaction(async (tx) => {
    const c = await tx.container.findUnique({ where: { id: containerId }, include: SELECT_LOCAIS_ETAPAS });
    if (!c) throw erroHttp(404, "Container não encontrado.");
    const etapas = etapasDoContainer(c);
    const posicao = etapas.indexOf(c.status);
    if (posicao === -1 || posicao === etapas.length - 1) throw erroHttp(409, "Este container já está encerrado.");
    const proximo = etapas[posicao + 1];
    // O front envia a etapa esperada: se outra pessoa avançou antes, evita pular uma etapa sem querer.
    if (b.statusPara && b.statusPara !== proximo) {
      throw erroHttp(409, `O container já mudou de etapa (agora: ${nomeEtapa(c, c.status)}). Atualize a tela.`);
    }
    validarMomento(ocorridoEm, c);
    // Só grava se continua na etapa lida (duplo clique / duas pessoas: o segundo recebe 409).
    await mudarStatus(tx, c, { status: proximo, [CAMPO_DATA[proximo]]: ocorridoEm });
    await tx.eventoContainer.create({
      data: { containerId, statusDe: c.status, statusPara: proximo, ocorridoEm, observacao, usuarioEmail: req.usuario.email },
    });
    await registrarLog(
      {
        usuarioEmail: req.usuario.email,
        acao: "AVANCAR",
        entidade: "Container",
        entidadeId: containerId,
        descricao: `Container ${c.numero}: ${nomeEtapa(c, c.status)} → ${nomeEtapa(c, proximo)}`,
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
    const c = await tx.container.findUnique({ where: { id: containerId }, include: SELECT_LOCAIS_ETAPAS });
    if (!c) throw erroHttp(404, "Container não encontrado.");
    const ultimo = await tx.eventoContainer.findFirst({ where: { containerId }, orderBy: [{ registradoEm: "desc" }, { id: "desc" }] });
    if (!ultimo || !ultimo.statusDe || ultimo.statusPara !== c.status) throw erroHttp(409, "Não há etapa para desfazer.");
    await mudarStatus(tx, c, { status: ultimo.statusDe, [CAMPO_DATA[c.status]]: null });
    await tx.eventoContainer.delete({ where: { id: ultimo.id } });
    await registrarLog(
      {
        usuarioEmail: req.usuario.email,
        acao: "DESFAZER",
        entidade: "Container",
        entidadeId: containerId,
        descricao: `Container ${c.numero}: etapa "${nomeEtapa(c, c.status)}" desfeita (volta para ${nomeEtapa(c, ultimo.statusDe)})`,
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
    await mudarStatus(tx, c, { status: "CANCELADO", canceladoEm: agora });
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
