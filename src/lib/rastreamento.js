// Rastreamento por SMS.
// Cadeia: Etiqueta QR → Container → Usuário responsável (Container.rastreioResponsavelId) → Celular.
// - Quem REGISTRA algo pelo QR (vínculo, temperatura, coleta, entrada/saída) vira o responsável;
//   o anterior deixa de receber SMS na hora e os links que ele recebeu param de valer.
// - O celular é lido do cadastro do usuário no momento de cada envio (trocar o número vale já).
// - Enquanto o container está ativo, o responsável recebe SMS pedindo a posição GPS:
//   · padrão: só em TRECHOS CRÍTICOS (motivosDoPedido) — previsão estourada, risco de prazo,
//     parado ou sem posição há muito tempo;
//   · "intervalo personalizado": a cada rastreioIntervaloMin (30) ou, no ponto de carregamento,
//     a cada rastreioIntervaloCarregamentoMin (240);
//   · a qualquer momento pelo botão "Solicitar posição" da ficha (solicitarPosicaoManual).
// - O link do SMS leva um código aleatório; só o hash SHA-256 fica no banco (SolicitacaoPosicao).
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { registrarLog } from "./auditoria.js";
import { erroHttp } from "./asyncHandler.js";
import { lerConfiguracao } from "./configuracao.js";
import { enviarSms } from "./sms.js";
import { enderecoPublicoFixo } from "./enderecoPublico.js";
import { STATUS_ENCERRADOS } from "./prazos.js";

// Etapas "no ponto de carregamento" (container parado lá): intervalo próprio no modo personalizado.
export const ETAPAS_CARREGAMENTO = ["NA_FABRICA", "EM_OPERACAO", "LIBERADO"];
export const VALIDADE_LINK_HORAS = 12;
// Falha no envio: tenta de novo depois disto (em vez de esperar o intervalo inteiro).
const NOVA_TENTATIVA_MIN = 5;
const MIN = 60 * 1000;

const hashDoCodigo = (codigo) => crypto.createHash("sha256").update(String(codigo)).digest("hex");


// Mostra só o começo e o fim do número (dado pessoal) — ex.: +55 11 9****-4321.
export function mascararCelular(celular) {
  if (!celular) return null;
  const m = /^\+55(\d{2})(\d)\d{4}(\d{4})$/.exec(celular);
  return m ? `+55 ${m[1]} ${m[2]}****-${m[3]}` : `${celular.slice(0, 4)}****${celular.slice(-4)}`;
}

async function registrarSms(dados) {
  await prisma.mensagemSms.create({ data: { ...dados, erro: dados.erro ? String(dados.erro).slice(0, 500) : null } });
}

/**
 * Envia um SMS ao usuário e registra o resultado (ENVIADA | SIMULADA | FALHA | SEM_CELULAR).
 * Nunca lança: devolve o status para quem chamou decidir (ex.: tentar de novo mais cedo).
 */
async function enviarAoUsuario({ usuario, containerId, tipo, texto, motivo = null }) {
  const base = { containerId, usuarioId: usuario.id, tipo, texto, motivo };
  if (!usuario.ativo) {
    await registrarSms({ ...base, status: "FALHA", erro: "Conta do usuário desativada." });
    return "FALHA";
  }
  if (!usuario.celular) {
    await registrarSms({ ...base, status: "SEM_CELULAR", erro: "Usuário sem celular cadastrado (Configurações → Usuários)." });
    return "SEM_CELULAR";
  }
  try {
    const r = await enviarSms({ para: usuario.celular, texto });
    const status = r.simulado ? "SIMULADA" : "ENVIADA";
    await registrarSms({ ...base, telefone: usuario.celular, status });
    return status;
  } catch (err) {
    console.error(`Rastreamento: falha ao enviar SMS (${tipo}) do container ${containerId}:`, err.message);
    await registrarSms({ ...base, telefone: usuario.celular, status: "FALHA", erro: err.message });
    return "FALHA";
  }
}

/**
 * Registrou algo pelo QR: grava a posição (se o celular mandou) e passa o rastreamento para
 * este usuário. Se o responsável mudou, avisa o novo por SMS (com o rastreamento ligado).
 * Nunca lança — o registro pelo QR já foi gravado e não pode falhar por causa disto.
 */
export async function assumirRastreio({ containerId, usuarioId, posicao = {}, agora = new Date() }) {
  try {
    const c = await prisma.container.findUnique({
      where: { id: containerId },
      select: { id: true, numero: true, status: true, rastreioResponsavelId: true, rastreioResponsavel: { select: { email: true } } },
    });
    if (!c) return { trocou: false };
    const temPosicao = posicao.latitude !== undefined && posicao.latitude !== null;
    if (temPosicao) {
      await prisma.posicaoContainer.create({
        data: {
          containerId: c.id, usuarioId, latitude: posicao.latitude, longitude: posicao.longitude,
          precisaoM: posicao.precisaoM ?? null, origem: "QR", etapa: c.status, registradaEm: agora,
        },
      });
    }
    if (STATUS_ENCERRADOS.includes(c.status)) {
      // Encerrado: ninguém mais recebe pedidos.
      if (c.rastreioResponsavelId) await prisma.container.update({ where: { id: c.id }, data: { rastreioResponsavelId: null } });
      return { trocou: false };
    }
    if (c.rastreioResponsavelId === usuarioId) {
      // Mesmo responsável: posição acabou de chegar pelo QR, então o próximo pedido conta daqui.
      if (temPosicao) await prisma.container.update({ where: { id: c.id }, data: { rastreioUltimoEnvioEm: agora } });
      return { trocou: false };
    }

    const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId }, select: { id: true, email: true, nome: true, celular: true, ativo: true } });
    await prisma.container.update({
      where: { id: c.id },
      data: { rastreioResponsavelId: usuarioId, rastreioDesde: agora, rastreioUltimoEnvioEm: agora },
    });
    await registrarLog({
      usuarioEmail: usuario.email, acao: "RASTREIO", entidade: "Container", entidadeId: c.id,
      descricao: `Container ${c.numero}: rastreamento por SMS passou para ${usuario.email}` +
        (c.rastreioResponsavel ? ` (antes: ${c.rastreioResponsavel.email}, que deixa de receber)` : ""),
    });
    const config = await lerConfiguracao();
    if (config.rastreioSmsAtivo) {
      await enviarAoUsuario({
        usuario, containerId: c.id, tipo: "VINCULO",
        texto: `CCS: o QR do container ${c.numero} foi vinculado a voce. Voce recebera SMS pedindo a posicao do container ate a entrega.`,
      });
    }
    return { trocou: true };
  } catch (err) {
    console.error(`Rastreamento: falha ao assumir o rastreio do container ${containerId}:`, err);
    return { trocou: false, erro: err.message };
  }
}

/**
 * Celular cadastrado/trocado depois de o usuário já ser o responsável (ex.: leu o QR sem celular,
 * o aviso ficou "Sem celular"): manda o aviso de vínculo agora para cada container ativo dele, sem
 * esperar o próximo pedido de posição. Nunca lança (a alteração do usuário já foi gravada).
 */
export async function avisarCelularAtualizado(usuarioId) {
  try {
    const config = await lerConfiguracao();
    if (!config.rastreioSmsAtivo) return 0;
    const [usuario, containers] = await Promise.all([
      prisma.usuario.findUnique({ where: { id: usuarioId }, select: { id: true, email: true, celular: true, ativo: true } }),
      prisma.container.findMany({ where: { rastreioResponsavelId: usuarioId, status: { notIn: STATUS_ENCERRADOS } }, select: { id: true, numero: true } }),
    ]);
    if (!usuario?.celular || !usuario.ativo) return 0;
    for (const c of containers) {
      await enviarAoUsuario({
        usuario, containerId: c.id, tipo: "VINCULO",
        texto: `CCS: o QR do container ${c.numero} foi vinculado a voce. Voce recebera SMS pedindo a posicao do container ate a entrega.`,
      });
    }
    return containers.length;
  } catch (err) {
    console.error(`Rastreamento: falha ao avisar o celular novo do usuário ${usuarioId}:`, err);
    return 0;
  }
}

// ---------- Quando pedir a posição ----------

// Em trânsito: indo para o carregamento (COLETADO) ou para o porto (SAIU_FABRICA).
export const EM_TRANSITO = ["COLETADO", "SAIU_FABRICA"];
// Próxima etapa planejada de cada trecho em trânsito (plano congelado da aba Etapas).
const PROXIMA_DO_TRECHO = { COLETADO: ["NA_FABRICA", "chegada ao carregamento"], SAIU_FABRICA: ["ENTREGUE_PORTO", "entrega no porto"] };
// Alertas abertos que contam como "risco de prazo".
export const ALERTAS_DE_PRAZO = {
  RISCO_DEMURRAGE: "Risco de demurrage",
  RISCO_DEADLINE: "Risco de perder o deadline do navio",
  DEMURRAGE: "Free time acabando ou vencido",
  DEADLINE: "Deadline do navio próximo ou vencido",
};
const RAIO_PARADO_M = 500;

function distanciaM(a, b) {
  const rad = (g) => (Number(g) * Math.PI) / 180;
  const dLat = rad(b.latitude) - rad(a.latitude);
  const dLon = rad(b.longitude) - rad(a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
const fmtHoras = (ms) => {
  const min = Math.round(ms / MIN);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
};
const fmtHorario = (d) =>
  new Date(d).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * Por que pedir a posição deste container agora, e de quanto em quanto tempo.
 * Devolve [{ texto, intervaloMin }] — vazio = sem motivo (não pede).
 * - personalizado: intervalo fixo (X min; no ponto de carregamento, Y min);
 * - trechos críticos: previsão estourada, risco de prazo (alertas abertos), parado (2 últimas
 *   posições a até 500 m uma da outra, com X h entre elas) ou sem posição há X h. Parado no ponto
 *   de carregamento é o esperado: lá só vale o risco de prazo.
 * `posicoes` = as 2 últimas (mais recente primeiro); `alertas` = tipos dos alertas abertos.
 */
export function motivosDoPedido(c, { posicoes = [], alertas = [], config, agora = new Date() }) {
  if (STATUS_ENCERRADOS.includes(c.status)) return [];
  if (config.rastreioPersonalizado) {
    const intervaloMin = ETAPAS_CARREGAMENTO.includes(c.status) ? config.rastreioIntervaloCarregamentoMin : config.rastreioIntervaloMin;
    return [{ texto: `Intervalo personalizado (a cada ${intervaloMin} min)`, intervaloMin }];
  }
  const critico = config.rastreioCriticoIntervaloMin;
  const motivos = [];
  const emTransito = EM_TRANSITO.includes(c.status);
  if (emTransito) {
    const [etapa, nome] = PROXIMA_DO_TRECHO[c.status];
    const planejado = c.planejamento?.[etapa];
    if (planejado && agora - new Date(planejado) > (config.toleranciaPlanejadoMinutos ?? 60) * MIN) {
      motivos.push({ texto: `Previsão estourada: ${nome} planejada para ${fmtHorario(planejado)}`, intervaloMin: critico });
    }
  }
  for (const tipo of Object.keys(ALERTAS_DE_PRAZO)) {
    if (alertas.includes(tipo)) motivos.push({ texto: ALERTAS_DE_PRAZO[tipo], intervaloMin: critico });
  }
  if (emTransito) {
    const [ultima, anterior] = posicoes;
    if (ultima && anterior && distanciaM(ultima, anterior) <= RAIO_PARADO_M &&
        new Date(ultima.registradaEm) - new Date(anterior.registradaEm) >= config.rastreioParadoHoras * 60 * MIN) {
      motivos.push({ texto: `Parado há ${fmtHoras(agora - new Date(anterior.registradaEm))}`, intervaloMin: critico });
    }
    const desde = ultima?.registradaEm ?? c.rastreioDesde;
    if (desde && agora - new Date(desde) >= config.rastreioSemPosicaoHoras * 60 * MIN) {
      motivos.push({ texto: `Sem posição há ${fmtHoras(agora - new Date(desde))}`, intervaloMin: Math.round(config.rastreioSemPosicaoHoras * 60) });
    }
  }
  return motivos;
}

// Motivos cujo intervalo já venceu desde o último SMS.
const vencidos = (motivos, ultimoEnvioEm, agora) =>
  motivos.filter((m) => !ultimoEnvioEm || agora - new Date(ultimoEnvioEm) >= m.intervaloMin * MIN);

// Últimas 2 posições e tipos de alertas abertos de vários containers (2 consultas no total).
async function contextoDosPedidos(ids) {
  const posicoes = new Map(ids.map((id) => [id, []]));
  const alertas = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return { posicoes, alertas };
  const [linhas, abertos] = await Promise.all([
    prisma.$queryRaw`
      SELECT "containerId", latitude, longitude, "registradaEm" FROM (
        SELECT p.*, row_number() OVER (PARTITION BY "containerId" ORDER BY "registradaEm" DESC, id DESC) AS n
        FROM "PosicaoContainer" p WHERE "containerId" IN (${Prisma.join(ids)})
      ) x WHERE n <= 2 ORDER BY "containerId", "registradaEm" DESC, id DESC`,
    prisma.alerta.findMany({ where: { containerId: { in: ids }, chaveAberta: { not: null } }, select: { containerId: true, tipo: true } }),
  ]);
  for (const p of linhas) posicoes.get(p.containerId).push({ latitude: Number(p.latitude), longitude: Number(p.longitude), registradaEm: p.registradaEm });
  for (const a of abertos) alertas.get(a.containerId).push(a.tipo);
  return { posicoes, alertas };
}

// Cria o link, manda o SMS e registra. Link desfeito se o SMS não saiu. Devolve o status.
async function enviarPedidoPosicao({ c, usuario, base, motivo, agora }) {
  if (!base) {
    await registrarSms({
      containerId: c.id, usuarioId: usuario.id, tipo: "POSICAO", status: "FALHA", texto: "(não enviado)", motivo,
      erro: "Endereço do sistema não configurado (Configurações → Endereço do sistema, ou APP_URL).",
    });
    return "FALHA";
  }
  const codigo = crypto.randomBytes(16).toString("base64url");
  const pedido = await prisma.solicitacaoPosicao.create({
    data: { containerId: c.id, usuarioId: usuario.id, tokenHash: hashDoCodigo(codigo), criadaEm: agora, motivo, expiraEm: new Date(agora.getTime() + VALIDADE_LINK_HORAS * 60 * MIN) },
  });
  const status = await enviarAoUsuario({
    usuario, containerId: c.id, tipo: "POSICAO", motivo,
    texto: `CCS: envie a posicao atual do container ${c.numero}: ${base}/p/${codigo}`,
  });
  // SMS não saiu: o link não chegou a ninguém.
  if (status === "FALHA" || status === "SEM_CELULAR") await prisma.solicitacaoPosicao.delete({ where: { id: pedido.id } });
  return status;
}

const SELECT_RESPONSAVEL = { id: true, email: true, nome: true, celular: true, ativo: true };

/** Uma rodada do agendador: manda o pedido de posição de cada container que tem motivo vencido. */
export async function executarRastreamento(agora = new Date()) {
  const config = await lerConfiguracao();
  if (!config.rastreioSmsAtivo) return { enviados: 0 };
  // Só olha quem está há pelo menos o MENOR intervalo possível sem SMS (o resto nem é avaliado).
  const menorIntervalo = config.rastreioPersonalizado
    ? Math.min(config.rastreioIntervaloMin, config.rastreioIntervaloCarregamentoMin)
    : Math.min(config.rastreioCriticoIntervaloMin, config.rastreioSemPosicaoHoras * 60);
  const limite = (min) => new Date(agora.getTime() - min * MIN);
  const candidatos = await prisma.container.findMany({
    where: {
      rastreioResponsavelId: { not: null },
      status: { notIn: STATUS_ENCERRADOS },
      OR: [{ rastreioUltimoEnvioEm: null }, { rastreioUltimoEnvioEm: { lte: limite(menorIntervalo) } }],
    },
    select: { id: true, numero: true, status: true, planejamento: true, rastreioResponsavelId: true, rastreioUltimoEnvioEm: true, rastreioDesde: true },
    orderBy: { id: "asc" },
    take: 500,
  });
  if (!candidatos.length) return { enviados: 0, candidatos: 0 };
  const ctx = await contextoDosPedidos(candidatos.map((c) => c.id));
  const base = await enderecoPublicoFixo();
  let enviados = 0;
  for (const c of candidatos) {
    const devidos = vencidos(motivosDoPedido(c, { posicoes: ctx.posicoes.get(c.id), alertas: ctx.alertas.get(c.id), config, agora }), c.rastreioUltimoEnvioEm, agora);
    if (!devidos.length) continue;
    // Reserva idempotente: só quem trocar o "último envio" antigo pelo de agora manda o SMS
    // (duas rodadas/instâncias ao mesmo tempo não duplicam; troca de responsável no meio cancela).
    const reserva = await prisma.container.updateMany({
      where: { id: c.id, rastreioResponsavelId: c.rastreioResponsavelId, rastreioUltimoEnvioEm: c.rastreioUltimoEnvioEm, status: c.status },
      data: { rastreioUltimoEnvioEm: agora },
    });
    if (reserva.count !== 1) continue;
    const usuario = await prisma.usuario.findUnique({ where: { id: c.rastreioResponsavelId }, select: SELECT_RESPONSAVEL });
    const status = await enviarPedidoPosicao({ c, usuario, base, motivo: devidos.map((m) => m.texto).join(" · "), agora });
    if (status === "FALHA") {
      // Tenta de novo em alguns minutos: volta o "último envio" para o intervalo vencer mais cedo.
      const volta = Math.min(...devidos.map((m) => m.intervaloMin)) - NOVA_TENTATIVA_MIN;
      await prisma.container.updateMany({ where: { id: c.id, rastreioUltimoEnvioEm: agora }, data: { rastreioUltimoEnvioEm: limite(volta) } });
    } else if (status !== "SEM_CELULAR") {
      enviados++;
    }
  }
  return { enviados, candidatos: candidatos.length };
}

export const INTERVALO_MANUAL_MIN = 5;

/**
 * Botão "Solicitar posição" da ficha: manda o pedido agora ao responsável atual (no máximo 1
 * pedido de posição a cada 5 min por container, contando os automáticos). Lança erroHttp.
 */
export async function solicitarPosicaoManual({ containerId, solicitante, agora = new Date() }) {
  const config = await lerConfiguracao();
  if (!config.rastreioSmsAtivo) throw erroHttp(409, "O envio de SMS de rastreamento está desligado (Configurações → Rastreamento).");
  const c = await prisma.container.findUnique({
    where: { id: containerId },
    select: { id: true, numero: true, status: true, rastreioResponsavelId: true, rastreioUltimoEnvioEm: true },
  });
  if (!c) throw erroHttp(404, "Container não encontrado.");
  if (STATUS_ENCERRADOS.includes(c.status)) throw erroHttp(409, `O container ${c.numero} já foi encerrado.`);
  if (!c.rastreioResponsavelId) throw erroHttp(409, "Ninguém registrou este container pelo QR ainda — não há para quem pedir a posição.");
  const ultimo = await prisma.mensagemSms.findFirst({
    where: { containerId: c.id, tipo: "POSICAO", status: { in: ["ENVIADA", "SIMULADA"] } }, orderBy: { criadaEm: "desc" }, select: { criadaEm: true },
  });
  if (ultimo && agora - ultimo.criadaEm < INTERVALO_MANUAL_MIN * MIN) {
    const falta = Math.ceil((INTERVALO_MANUAL_MIN * MIN - (agora - ultimo.criadaEm)) / MIN);
    throw erroHttp(429, `Um pedido de posição foi enviado há menos de ${INTERVALO_MANUAL_MIN} min. Tente de novo em ${falta} min.`);
  }
  const usuario = await prisma.usuario.findUnique({ where: { id: c.rastreioResponsavelId }, select: SELECT_RESPONSAVEL });
  const status = await enviarPedidoPosicao({ c, usuario, base: await enderecoPublicoFixo(), motivo: `Pedido manual por ${solicitante.nome ?? solicitante.email}`, agora });
  // Pedido enviado: o próximo automático conta a partir daqui (não manda outro logo em seguida).
  if (status === "ENVIADA" || status === "SIMULADA") {
    await prisma.container.updateMany({ where: { id: c.id, rastreioResponsavelId: c.rastreioResponsavelId }, data: { rastreioUltimoEnvioEm: agora } });
  }
  await registrarLog({
    usuarioEmail: solicitante.email, acao: "RASTREIO", entidade: "Container", entidadeId: c.id,
    descricao: `Container ${c.numero}: posição solicitada manualmente a ${usuario.email} (${status === "ENVIADA" ? "SMS enviado" : status === "SIMULADA" ? "SMS simulado" : status === "SEM_CELULAR" ? "responsável sem celular" : "falha no envio"})`,
  });
  if (status === "SEM_CELULAR") throw erroHttp(409, `O responsável (${usuario.nome}) não tem celular cadastrado. Cadastre em Configurações → Usuários.`);
  if (status === "FALHA") throw erroHttp(502, "O SMS não pôde ser enviado agora. Veja o motivo na lista de SMS da aba Rastreamento.");
  return { status, para: usuario.nome };
}

// ---------- Link do SMS (página pública /p/:codigo) ----------

async function pedidoDoCodigo(codigo, agora) {
  if (!codigo || !/^[A-Za-z0-9_-]{16,64}$/.test(String(codigo))) return { erro: "Link inválido." };
  const p = await prisma.solicitacaoPosicao.findUnique({
    where: { tokenHash: hashDoCodigo(codigo) },
    include: { container: { select: { id: true, numero: true, status: true, rastreioResponsavelId: true } }, usuario: { select: { id: true, ativo: true } } },
  });
  if (!p) return { erro: "Link inválido." };
  if (p.respondidaEm) return { erro: "A posição deste link já foi enviada. Obrigado!", respondida: true };
  if (p.expiraEm < agora) return { erro: "Este link expirou. Aguarde o próximo SMS." };
  if (STATUS_ENCERRADOS.includes(p.container.status)) return { erro: `O container ${p.container.numero} já foi encerrado; não é preciso enviar a posição.` };
  if (p.container.rastreioResponsavelId !== p.usuarioId || !p.usuario.ativo) {
    return { erro: `O rastreamento do container ${p.container.numero} passou para outra pessoa; este link não vale mais.` };
  }
  return { pedido: p };
}

export async function conferirPedido(codigo, agora = new Date()) {
  const { pedido, erro, respondida } = await pedidoDoCodigo(codigo, agora);
  if (!pedido) return { valido: false, mensagem: erro, respondida: Boolean(respondida) };
  return { valido: true, numero: pedido.container.numero, expiraEm: pedido.expiraEm };
}

export async function registrarPosicaoDoLink({ codigo, latitude, longitude, precisaoM, agora = new Date() }) {
  const { pedido, erro } = await pedidoDoCodigo(codigo, agora);
  if (!pedido) return { ok: false, mensagem: erro };
  return prisma.$transaction(async (tx) => {
    // Condição no WHERE: o mesmo link enviado duas vezes ao mesmo tempo grava uma posição só.
    const r = await tx.solicitacaoPosicao.updateMany({ where: { id: pedido.id, respondidaEm: null }, data: { respondidaEm: agora } });
    if (r.count !== 1) return { ok: false, mensagem: "A posição deste link já foi enviada. Obrigado!" };
    await tx.posicaoContainer.create({
      data: {
        containerId: pedido.containerId, usuarioId: pedido.usuarioId, latitude, longitude, precisaoM: precisaoM ?? null,
        origem: "LINK_SMS", etapa: pedido.container.status, registradaEm: agora,
      },
    });
    return { ok: true, numero: pedido.container.numero };
  });
}

// ---------- Aba "Rastreamento" da ficha ----------

export async function resumoRastreamento(containerId) {
  const [c, config] = await Promise.all([
    prisma.container.findUnique({
      where: { id: containerId },
      select: {
        status: true, planejamento: true, rastreioDesde: true, rastreioUltimoEnvioEm: true,
        rastreioResponsavel: { select: { nome: true, email: true, celular: true, ativo: true } },
      },
    }),
    lerConfiguracao(),
  ]);
  if (!c) return null;
  const [posicoes, mensagens, alertas] = await Promise.all([
    prisma.posicaoContainer.findMany({
      where: { containerId }, orderBy: { registradaEm: "desc" }, take: 50,
      select: { id: true, latitude: true, longitude: true, precisaoM: true, origem: true, etapa: true, registradaEm: true, usuario: { select: { nome: true } } },
    }),
    prisma.mensagemSms.findMany({
      where: { containerId }, orderBy: { criadaEm: "desc" }, take: 50,
      select: { id: true, tipo: true, status: true, erro: true, motivo: true, telefone: true, criadaEm: true, usuario: { select: { nome: true } } },
    }),
    prisma.alerta.findMany({ where: { containerId, chaveAberta: { not: null } }, select: { tipo: true } }),
  ]);
  const ativo = Boolean(config.rastreioSmsAtivo) && Boolean(c.rastreioResponsavel) && !STATUS_ENCERRADOS.includes(c.status);
  // Motivos para pedir a posição agora (trechos críticos) ou o intervalo fixo (personalizado).
  const motivos = ativo
    ? motivosDoPedido(c, { posicoes: posicoes.slice(0, 2).map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude), registradaEm: p.registradaEm })), alertas: alertas.map((a) => a.tipo), config })
    : [];
  const intervaloMin = motivos.length ? Math.min(...motivos.map((m) => m.intervaloMin)) : null;
  const r = c.rastreioResponsavel;
  return {
    smsAtivo: Boolean(config.rastreioSmsAtivo),
    modo: config.rastreioPersonalizado ? "PERSONALIZADO" : "CRITICO",
    ativo,
    motivos: motivos.map((m) => m.texto),
    intervaloMin,
    responsavel: r && { nome: r.nome, email: r.email, celular: mascararCelular(r.celular), temCelular: Boolean(r.celular), ativo: r.ativo },
    desde: c.rastreioDesde,
    // Com motivo: último SMS + intervalo. Sem motivo, em trânsito: a checagem "sem posição" (última
    // posição + X h). Sem motivo no carregamento: nenhum pedido previsto até aparecer um.
    proximoPedidoEm: !ativo ? null
      : intervaloMin && c.rastreioUltimoEnvioEm ? new Date(Math.max(Date.now(), c.rastreioUltimoEnvioEm.getTime() + intervaloMin * MIN))
      : EM_TRANSITO.includes(c.status) && (posicoes[0]?.registradaEm ?? c.rastreioDesde)
        ? new Date(new Date(posicoes[0]?.registradaEm ?? c.rastreioDesde).getTime() + config.rastreioSemPosicaoHoras * 60 * MIN)
        : null,
    posicoes: posicoes.map((p) => ({ ...p, latitude: Number(p.latitude), longitude: Number(p.longitude), usuario: p.usuario?.nome ?? null })),
    mensagens: mensagens.map((m) => ({ ...m, telefone: mascararCelular(m.telefone), usuario: m.usuario?.nome ?? null })),
  };
}

// ---------- Agendador ----------

let rodando = false;
export async function rodadaRastreamento() {
  if (rodando) return null;
  rodando = true;
  try {
    const r = await executarRastreamento();
    if (r.enviados) console.log(`Rastreamento: ${r.enviados} pedido(s) de posição enviado(s).`);
    return r;
  } catch (err) {
    console.error("Rastreamento: falha na rodada:", err);
    return null;
  } finally {
    rodando = false;
  }
}

// Confere a cada minuto (o intervalo de cada container é controlado pelo "último envio").
export function iniciarRastreamento() {
  return setInterval(rodadaRastreamento, MIN);
}
