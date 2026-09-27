// Rastreamento por SMS.
// Cadeia: Etiqueta QR → Container → Usuário responsável (Container.rastreioResponsavelId) → Celular.
// - Quem REGISTRA algo pelo QR (vínculo, temperatura, coleta, entrada/saída) vira o responsável;
//   o anterior deixa de receber SMS na hora e os links que ele recebeu param de valer.
// - O celular é lido do cadastro do usuário no momento de cada envio (trocar o número vale já).
// - Enquanto o container está ativo, o responsável recebe SMS pedindo a posição GPS: a cada
//   rastreioIntervaloMin (30) ou, no ponto de carregamento, a cada rastreioIntervaloCarregamentoMin (240).
// - O link do SMS leva um código aleatório; só o hash SHA-256 fica no banco (SolicitacaoPosicao).
import crypto from "node:crypto";
import { prisma } from "./prisma.js";
import { registrarLog } from "./auditoria.js";
import { lerConfiguracao } from "./configuracao.js";
import { enviarSms } from "./sms.js";
import { enderecoPublicoFixo } from "./enderecoPublico.js";
import { STATUS_ENCERRADOS } from "./prazos.js";

// Etapas "no ponto de carregamento": intervalo maior (o container fica parado lá).
export const ETAPAS_CARREGAMENTO = ["NA_FABRICA", "EM_OPERACAO", "LIBERADO"];
export const VALIDADE_LINK_HORAS = 12;
// Falha no envio: tenta de novo depois disto (em vez de esperar o intervalo inteiro).
const NOVA_TENTATIVA_MIN = 5;
const MIN = 60 * 1000;

const hashDoCodigo = (codigo) => crypto.createHash("sha256").update(String(codigo)).digest("hex");

export const intervaloDaEtapa = (status, config) =>
  ETAPAS_CARREGAMENTO.includes(status) ? config.rastreioIntervaloCarregamentoMin : config.rastreioIntervaloMin;

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
async function enviarAoUsuario({ usuario, containerId, tipo, texto }) {
  const base = { containerId, usuarioId: usuario.id, tipo, texto };
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

/** Uma rodada do agendador: manda o pedido de posição de cada container cujo intervalo venceu. */
export async function executarRastreamento(agora = new Date()) {
  const config = await lerConfiguracao();
  if (!config.rastreioSmsAtivo) return { enviados: 0 };
  const limite = (min) => new Date(agora.getTime() - min * MIN);
  const vencido = (min) => ({ OR: [{ rastreioUltimoEnvioEm: null }, { rastreioUltimoEnvioEm: { lte: limite(min) } }] });
  const candidatos = await prisma.container.findMany({
    where: {
      rastreioResponsavelId: { not: null },
      OR: [
        { status: { in: ETAPAS_CARREGAMENTO }, ...vencido(config.rastreioIntervaloCarregamentoMin) },
        { status: { notIn: [...ETAPAS_CARREGAMENTO, ...STATUS_ENCERRADOS] }, ...vencido(config.rastreioIntervaloMin) },
      ],
    },
    select: { id: true, numero: true, status: true, rastreioResponsavelId: true, rastreioUltimoEnvioEm: true },
    orderBy: { id: "asc" },
    take: 200,
  });
  if (!candidatos.length) return { enviados: 0 };
  const base = await enderecoPublicoFixo();
  let enviados = 0;
  for (const c of candidatos) {
    // Reserva idempotente: só quem trocar o "último envio" antigo pelo de agora manda o SMS
    // (duas rodadas/instâncias ao mesmo tempo não duplicam; troca de responsável no meio cancela).
    const reserva = await prisma.container.updateMany({
      where: { id: c.id, rastreioResponsavelId: c.rastreioResponsavelId, rastreioUltimoEnvioEm: c.rastreioUltimoEnvioEm, status: c.status },
      data: { rastreioUltimoEnvioEm: agora },
    });
    if (reserva.count !== 1) continue;
    const usuario = await prisma.usuario.findUnique({ where: { id: c.rastreioResponsavelId }, select: { id: true, email: true, celular: true, ativo: true } });
    let status;
    if (!base) {
      await registrarSms({
        containerId: c.id, usuarioId: usuario.id, tipo: "POSICAO", status: "FALHA", texto: "(não enviado)",
        erro: "Endereço do sistema não configurado (Configurações → Endereço do sistema, ou APP_URL).",
      });
      status = "FALHA";
    } else {
      const codigo = crypto.randomBytes(16).toString("base64url");
      const pedido = await prisma.solicitacaoPosicao.create({
        data: { containerId: c.id, usuarioId: usuario.id, tokenHash: hashDoCodigo(codigo), criadaEm: agora, expiraEm: new Date(agora.getTime() + VALIDADE_LINK_HORAS * 60 * MIN) },
      });
      status = await enviarAoUsuario({
        usuario, containerId: c.id, tipo: "POSICAO",
        texto: `CCS: envie a posicao atual do container ${c.numero}: ${base}/p/${codigo}`,
      });
      // SMS não saiu: o link não chegou a ninguém.
      if (status === "FALHA" || status === "SEM_CELULAR") await prisma.solicitacaoPosicao.delete({ where: { id: pedido.id } });
    }
    if (status === "FALHA") {
      // Tenta de novo em alguns minutos: volta o "último envio" para o intervalo vencer mais cedo.
      const volta = intervaloDaEtapa(c.status, config) - NOVA_TENTATIVA_MIN;
      await prisma.container.updateMany({ where: { id: c.id, rastreioUltimoEnvioEm: agora }, data: { rastreioUltimoEnvioEm: limite(volta) } });
    } else if (status !== "SEM_CELULAR") {
      enviados++;
    }
  }
  return { enviados, candidatos: candidatos.length };
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
        status: true, rastreioDesde: true, rastreioUltimoEnvioEm: true,
        rastreioResponsavel: { select: { nome: true, email: true, celular: true, ativo: true } },
      },
    }),
    lerConfiguracao(),
  ]);
  if (!c) return null;
  const [posicoes, mensagens] = await Promise.all([
    prisma.posicaoContainer.findMany({
      where: { containerId }, orderBy: { registradaEm: "desc" }, take: 50,
      select: { id: true, latitude: true, longitude: true, precisaoM: true, origem: true, etapa: true, registradaEm: true, usuario: { select: { nome: true } } },
    }),
    prisma.mensagemSms.findMany({
      where: { containerId }, orderBy: { criadaEm: "desc" }, take: 50,
      select: { id: true, tipo: true, status: true, erro: true, telefone: true, criadaEm: true, usuario: { select: { nome: true } } },
    }),
  ]);
  const ativo = Boolean(config.rastreioSmsAtivo) && Boolean(c.rastreioResponsavel) && !STATUS_ENCERRADOS.includes(c.status);
  const intervaloMin = intervaloDaEtapa(c.status, config);
  const r = c.rastreioResponsavel;
  return {
    smsAtivo: Boolean(config.rastreioSmsAtivo),
    ativo,
    intervaloMin,
    responsavel: r && { nome: r.nome, email: r.email, celular: mascararCelular(r.celular), temCelular: Boolean(r.celular), ativo: r.ativo },
    desde: c.rastreioDesde,
    proximoPedidoEm: ativo && c.rastreioUltimoEnvioEm ? new Date(c.rastreioUltimoEnvioEm.getTime() + intervaloMin * MIN) : null,
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
