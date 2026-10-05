// Acesso do MOTORISTA (não é usuário do sistema): identidade = celular verificado por SMS.
// 1) pedirCodigo: gera 6 dígitos, válido por 15 min; um pedido novo encerra o anterior; só o HMAC
//    do código fica no banco. Limites: 1 pedido/min e 5/h por celular (+ limite por IP na rota).
// 2) verificarCodigo: até 5 tentativas por código. Motorista já cadastrado (e com termo aceito)
//    → sessão; senão devolve um "comprovante de celular" (JWT de 30 min) para concluir o cadastro.
// 3) Sessão: token aleatório em cookie httpOnly (60 dias, só /api/motorista); só o hash no banco.
//    Bloquear o motorista (ou desativar a transportadora) derruba o acesso na hora.
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { prisma } from "./prisma.js";
import { erroHttp } from "./asyncHandler.js";
import { registrarLog } from "./auditoria.js";
import { enviarSms, normalizarCelular } from "./sms.js";

export const VALIDADE_CODIGO_MIN = 15;
export const MAX_TENTATIVAS = 5;
export const SESSAO_DIAS = 60;
// Teto de códigos SMS por CLIENTE por hora (v3.3, item 10): abuso numa etiqueta de um cliente não
// para o login dos motoristas dos outros. O total da plataforma vira só alarme de custo (log).
export const MAX_CODIGOS_POR_HORA_CLIENTE = Number(process.env.MOTORISTA_MAX_CODIGOS_HORA_CLIENTE) || 100;
export const ALARME_CODIGOS_POR_HORA = Number(process.env.MOTORISTA_MAX_CODIGOS_HORA) || 500;
// Por etiqueta (v3.5): quem tem uma etiqueta não esgota sozinho o teto do cliente. Os dois tetos
// contam só celulares NOVOS — motorista já vinculado ao cliente segue entrando (limite por celular).
export const MAX_CODIGOS_POR_HORA_ETIQUETA = Number(process.env.MOTORISTA_MAX_CODIGOS_HORA_ETIQUETA) || 20;
let ultimoAlarme = 0;
export const COOKIE_MOTORISTA = "cc_motorista";
const MIN = 60 * 1000;
const COMPROVANTE_MIN = 30;

const segredo = () => {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET não configurado.");
  return process.env.JWT_SECRET;
};
// Comprovante de celular (cadastro do motorista) assinado com um segredo DERIVADO, diferente do que
// assina a sessão da equipe (v3.3, item 20): um não serve no lugar do outro.
const segredoComprovante = () => crypto.createHmac("sha256", segredo()).update("comprovante-cadastro-motorista").digest("hex");
// HMAC com o segredo do servidor: sem ele, o hash de um código de 6 dígitos não é "quebrável" por tabela.
const hashCodigo = (celular, codigo) => crypto.createHmac("sha256", segredo()).update(`${celular}:${codigo}`).digest("hex");
const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

export function celularValido(valor) {
  try {
    const c = normalizarCelular(valor);
    if (!c) throw new Error("Informe o número do celular com DDD.");
    return c;
  } catch (err) {
    throw erroHttp(400, err.message);
  }
}

// Identificação do motorista nos registros (log, leituras, etapas, etiqueta).
export const identidadeMotorista = (m) => `${m.nome} (motorista · ${m.transportadora?.nome ?? "transportadora"})`;

export async function pedirCodigo({ celular: bruto, ip, agora = new Date(), texto = null, conferirBloqueio = true, organizacaoId = null, etiquetaId = null }) {
  const celular = celularValido(bruto);
  const recentes = await prisma.codigoAcessoMotorista.findMany({
    where: { celular, criadoEm: { gte: new Date(agora.getTime() - 60 * MIN) } }, orderBy: { criadoEm: "desc" }, select: { criadoEm: true },
  });
  if (recentes[0] && agora - recentes[0].criadoEm < MIN) throw erroHttp(429, "Aguarde 1 minuto para pedir outro código.");
  if (recentes.length >= 5) throw erroHttp(429, "Muitos códigos pedidos para este celular. Tente de novo em 1 hora.");
  const umaHora = new Date(agora.getTime() - 60 * MIN);
  const motorista = await prisma.motorista.findUnique({ where: { celular }, select: { id: true, bloqueado: true } });
  // Celular de motorista já vinculado ao cliente: não consome os tetos de números novos.
  const vinculo = organizacaoId && motorista
    ? await prisma.motoristaOrganizacao.findUnique({ where: { motoristaId_organizacaoId: { motoristaId: motorista.id, organizacaoId } }, select: { bloqueado: true } })
    : null;
  const conhecido = Boolean(vinculo);
  if (conferirBloqueio && vinculo?.bloqueado) throw erroHttp(403, "Seu acesso às cargas deste cliente foi bloqueado. Fale com o responsável.");
  if (organizacaoId && !conhecido) {
    const novos = { conhecido: false, criadoEm: { gte: umaHora } };
    const [doCliente, daEtiqueta] = await Promise.all([
      prisma.codigoAcessoMotorista.count({ where: { ...novos, organizacaoId } }),
      etiquetaId ? prisma.codigoAcessoMotorista.count({ where: { ...novos, etiquetaId } }) : 0,
    ]);
    if (doCliente >= MAX_CODIGOS_POR_HORA_CLIENTE || daEtiqueta >= MAX_CODIGOS_POR_HORA_ETIQUETA) {
      console.error(`Acesso do motorista: teto de códigos/hora atingido (cliente ${organizacaoId}: ${doCliente}; etiqueta ${etiquetaId}: ${daEtiqueta}) — possível abuso.`);
      throw erroHttp(429, "Muitos pedidos de código no momento. Tente de novo em alguns minutos.");
    }
  }
  // Total da plataforma: só alarme de custo (no máximo 1 aviso a cada 10 min no log).
  const total = await prisma.codigoAcessoMotorista.count({ where: { criadoEm: { gte: umaHora } } });
  if (total >= ALARME_CODIGOS_POR_HORA && agora - ultimoAlarme > 10 * MIN) {
    ultimoAlarme = agora.getTime();
    console.error(`ALARME de custo: ${total} códigos SMS de motorista na última hora (alarme: ${ALARME_CODIGOS_POR_HORA}).`);
  }
  if (conferirBloqueio && motorista?.bloqueado) throw erroHttp(403, "Seu acesso foi bloqueado. Fale com o responsável.");

  const codigo = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.$transaction([
    // Pedido novo encerra os anteriores ainda válidos deste celular.
    prisma.codigoAcessoMotorista.updateMany({ where: { celular, encerradoEm: null }, data: { encerradoEm: agora } }),
    prisma.codigoAcessoMotorista.create({
      data: { celular, codigoHash: hashCodigo(celular, codigo), criadoEm: agora, expiraEm: new Date(agora.getTime() + VALIDADE_CODIGO_MIN * MIN), ip: ip ?? null, organizacaoId, etiquetaId, conhecido },
    }),
  ]);
  const r = await enviarSms({ para: celular, texto: texto ? texto(codigo) : `CCS: seu codigo de acesso e ${codigo}. Vale por ${VALIDADE_CODIGO_MIN} min. Nao compartilhe.` });
  return { celular, simulado: Boolean(r.simulado), expiraEm: new Date(agora.getTime() + VALIDADE_CODIGO_MIN * MIN) };
}

// Confere e CONSOME o código SMS do celular (uso único, até 5 tentativas). Lança 400 se não vale.
async function consumirCodigo(celular, codigo, agora) {
  const digitado = String(codigo ?? "").replace(/\D/g, "");
  if (digitado.length !== 6) throw erroHttp(400, "O código tem 6 números.");
  const pendente = await prisma.codigoAcessoMotorista.findFirst({ where: { celular, encerradoEm: null }, orderBy: { criadoEm: "desc" } });
  if (!pendente || pendente.expiraEm < agora) throw erroHttp(400, "Código expirado ou inexistente. Peça um novo código.");
  const certo = crypto.timingSafeEqual(Buffer.from(pendente.codigoHash), Buffer.from(hashCodigo(celular, digitado)));
  if (!certo) {
    const tentativas = pendente.tentativas + 1;
    const esgotou = tentativas >= MAX_TENTATIVAS;
    await prisma.codigoAcessoMotorista.update({ where: { id: pendente.id }, data: { tentativas, encerradoEm: esgotou ? agora : null } });
    throw erroHttp(400, esgotou ? "Código incorreto. Limite de tentativas atingido: peça um novo código." : `Código incorreto. Restam ${MAX_TENTATIVAS - tentativas} tentativa(s).`);
  }
  // Uso único: a condição no WHERE impede usar o mesmo código duas vezes ao mesmo tempo.
  const r = await prisma.codigoAcessoMotorista.updateMany({ where: { id: pendente.id, encerradoEm: null }, data: { encerradoEm: agora } });
  if (r.count !== 1) throw erroHttp(400, "Este código já foi usado. Peça um novo código.");
  return pendente;
}

// Transportadoras que quem está se cadastrando pode escolher (v3.9): só as vinculadas ao cliente da
// etiqueta lida (mais a que já está no cadastro dele, se foi pré-cadastrado por outro cliente).
// Antes era a lista da plataforma inteira: um desconhecido com um celular via as transportadoras
// de todos os clientes e, ao registrar uma leitura, o cliente passava a ver nome e CNPJ da transportadora
// de outro cliente.
const transportadorasPermitidas = (organizacaoId, motorista) => ({
  ativo: true,
  OR: [{ organizacoes: { some: { organizacaoId } } }, ...(motorista ? [{ id: motorista.transportadoraId }] : [])],
});

export async function verificarCodigo({ celular: bruto, codigo, agora = new Date() }) {
  const celular = celularValido(bruto);
  const { organizacaoId } = await consumirCodigo(celular, codigo, agora);

  const motorista = await prisma.motorista.findUnique({ where: { celular }, include: { transportadora: true } });
  if (motorista?.bloqueado) throw erroHttp(403, "Seu acesso foi bloqueado. Fale com o responsável.");
  if (motorista && motorista.consentimentoEm && motorista.transportadora.ativo) return { motorista };
  // Primeiro acesso (ou importado pelo gestor e ainda sem o termo aceito): completa o cadastro.
  const comprovante = jwt.sign({ tipo: "cadastro-motorista", celular, org: organizacaoId ?? null }, segredoComprovante(), { expiresIn: `${COMPROVANTE_MIN}m`, audience: "cadastro-motorista" });
  const lista = organizacaoId
    ? await prisma.transportadora.findMany({ where: transportadorasPermitidas(organizacaoId, motorista), orderBy: { nome: "asc" }, select: { id: true, nome: true } })
    : [];
  // Nomes iguais (empresas diferentes, v3.4): mostra o código para diferenciar (nunca o CNPJ).
  const repetidos = new Set(lista.map((t) => t.nome.toLowerCase()).filter((n, i, a) => a.indexOf(n) !== i));
  const transportadoras = lista.map((t) => ({ id: t.id, nome: repetidos.has(t.nome.toLowerCase()) ? `${t.nome} · cód. ${t.id}` : t.nome }));
  return {
    precisaCadastro: true,
    comprovante,
    transportadoras,
    preenchido: motorista ? { nome: motorista.nome, transportadoraId: motorista.transportadora.ativo ? motorista.transportadoraId : null, placa: motorista.placa } : null,
  };
}

function lerComprovante(comprovante) {
  try {
    const p = jwt.verify(String(comprovante ?? ""), segredoComprovante(), { audience: "cadastro-motorista" });
    if (p.tipo !== "cadastro-motorista" || !p.celular) throw new Error();
    return { celular: p.celular, organizacaoId: p.org ?? null };
  } catch {
    throw erroHttp(401, "A confirmação do celular expirou. Peça um novo código.");
  }
}

const cpfValido = (cpf) => {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const dv = (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(cpf[i]) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(cpf[9]) && dv(10) === Number(cpf[10]);
};

export function validarDadosMotorista(b, { exigirTransportadora = true } = {}) {
  const nome = String(b.nome ?? "").trim().replace(/\s+/g, " ");
  if (nome.length < 3 || nome.length > 120) throw erroHttp(400, "Informe o nome completo (3 a 120 letras).");
  const transportadoraId = Number(b.transportadoraId);
  if (exigirTransportadora && (!Number.isInteger(transportadoraId) || transportadoraId <= 0)) throw erroHttp(400, "Escolha a transportadora.");
  const placa = b.placa ? String(b.placa).toUpperCase().replace(/[^A-Z0-9]/g, "") : null;
  if (placa && !/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(placa)) throw erroHttp(400, "Placa inválida (ex.: ABC1D23 ou ABC1234).");
  const cpf = b.cpf ? String(b.cpf).replace(/\D/g, "") : null;
  if (cpf && !cpfValido(cpf)) throw erroHttp(400, "CPF inválido.");
  return { nome, transportadoraId, placa, cpf };
}

/** Conclui o cadastro (ou aceita o termo de quem foi importado) e abre a sessão. */
export async function concluirCadastro({ comprovante, dados: b, agora = new Date() }) {
  const { celular, organizacaoId } = lerComprovante(comprovante);
  if (b.aceite !== true) throw erroHttp(400, "É preciso aceitar o termo de uso dos dados para continuar.");
  const dados = validarDadosMotorista(b);
  const existente = await prisma.motorista.findUnique({ where: { celular } });
  // Só as transportadoras do cliente da etiqueta (v3.9): escolher a de outro cliente é recusado.
  const transp = organizacaoId
    ? await prisma.transportadora.findFirst({ where: { id: dados.transportadoraId, ...transportadorasPermitidas(organizacaoId, existente) } })
    : null;
  if (!transp?.ativo) throw erroHttp(400, "Transportadora não encontrada ou inativa. Escolha uma da lista; se a sua não aparece, peça ao responsável pelo cliente para cadastrá-la.");
  if (existente?.bloqueado) throw erroHttp(403, "Seu acesso foi bloqueado. Fale com o responsável.");
  const motorista = existente
    ? await prisma.motorista.update({ where: { id: existente.id }, data: { ...dados, consentimentoEm: agora }, include: { transportadora: true } })
    : await prisma.motorista.create({ data: { ...dados, celular, consentimentoEm: agora }, include: { transportadora: true } }).catch(async (err) => {
        if (err.code === "P2002") return prisma.motorista.findUnique({ where: { celular }, include: { transportadora: true } });
        throw err;
      });
  await registrarLog({
    usuarioEmail: identidadeMotorista(motorista), motoristaId: motorista.id, acao: existente ? "MOTORISTA_ACEITE" : "MOTORISTA_CADASTRO", entidade: "Motorista", entidadeId: motorista.id,
    descricao: existente ? `Motorista ${motorista.nome} aceitou o termo no primeiro acesso` : `Motorista ${motorista.nome} (${transp.nome}) cadastrou-se pelo QR`,
  });
  return motorista;
}

// ---------- Troca de celular pelo próprio motorista (v3.2) ----------
// O celular é a identidade do motorista e vale para todos os clientes: só ele troca, confirmando o
// número NOVO por SMS. Os outros acessos caem, e o número antigo recebe um aviso.

export async function pedirCodigoTrocaCelular({ motorista, celular: bruto, ip, agora = new Date() }) {
  const celular = celularValido(bruto);
  if (celular === motorista.celular) throw erroHttp(400, "Esse já é o seu celular.");
  const outro = await prisma.motorista.findUnique({ where: { celular }, select: { id: true } });
  if (outro) throw erroHttp(409, "Esse celular já está em uso na plataforma.");
  return pedirCodigo({
    celular, ip, agora, conferirBloqueio: false,
    texto: (codigo) => `CCS: codigo para confirmar seu novo celular: ${codigo}. Vale por ${VALIDADE_CODIGO_MIN} min. Nao compartilhe.`,
  });
}

export async function confirmarTrocaCelular({ motorista, celular: bruto, codigo, sessaoId, agora = new Date() }) {
  const celular = celularValido(bruto);
  await consumirCodigo(celular, codigo, agora);
  const antigo = motorista.celular;
  const m = await prisma.$transaction(async (tx) => {
    const m = await tx.motorista.update({ where: { id: motorista.id }, data: { celular }, include: { transportadora: true } }).catch((err) => {
      if (err.code === "P2002") throw erroHttp(409, "Esse celular já está em uso na plataforma.");
      throw err;
    });
    // Mantém só este acesso (o de quem confirmou o número novo).
    await tx.sessaoMotorista.updateMany({
      where: { motoristaId: m.id, revogadaEm: null, id: { not: sessaoId } }, data: { revogadaEm: agora, revogadaPor: "troca de celular pelo próprio motorista" },
    });
    return m;
  });
  try {
    await enviarSms({ para: antigo, texto: `CCS: o celular do seu acesso de motorista foi trocado para o final ${celular.slice(-4)}. Se nao foi voce, fale com a transportadora.` });
  } catch (err) {
    console.error("Troca de celular do motorista: aviso ao número antigo falhou:", err.message);
  }
  await registrarLog({
    usuarioEmail: identidadeMotorista(m), motoristaId: m.id, acao: "ALTERAR", entidade: "Motorista", entidadeId: m.id,
    descricao: `Motorista ${m.nome} trocou o próprio celular (final ${antigo.slice(-4)} → ${celular.slice(-4)}), confirmado por SMS`,
  });
  return m;
}

// ---------- Sessão ----------

const resumirDispositivo = (ua) => {
  const s = String(ua ?? "");
  const so = /Android/i.test(s) ? "Android" : /iPhone|iPad/i.test(s) ? "iPhone" : /Windows/i.test(s) ? "Windows" : /Mac/i.test(s) ? "Mac" : "Outro";
  const nav = /Edg\//.test(s) ? "Edge" : /Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : /Firefox\//.test(s) ? "Firefox" : "navegador";
  return `${nav} · ${so}`;
};

export async function abrirSessao(res, motorista, req, agora = new Date()) {
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.sessaoMotorista.create({
    data: { motoristaId: motorista.id, tokenHash: hashToken(token), criadaEm: agora, ultimoUsoEm: agora, expiraEm: new Date(agora.getTime() + SESSAO_DIAS * 24 * 60 * MIN), dispositivo: resumirDispositivo(req.get("user-agent")) },
  });
  await prisma.motorista.update({ where: { id: motorista.id }, data: { ultimoAcessoEm: agora } });
  res.cookie(COOKIE_MOTORISTA, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/motorista", maxAge: SESSAO_DIAS * 24 * 60 * MIN,
  });
}

export function limparCookieMotorista(res) {
  res.clearCookie(COOKIE_MOTORISTA, { path: "/api/motorista" });
}

/**
 * Middleware das rotas do motorista: valida a sessão (a cada requisição, no banco) e monta
 * req.usuario no formato que as rotas do QR usam (perfil TRANSPORTADOR, só "qr.registrar").
 */
export async function carregarMotorista(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE_MOTORISTA];
    if (!token) return res.status(401).json({ erro: "Entre com o seu celular para continuar.", codigo: "SEM_SESSAO_MOTORISTA" });
    const s = await prisma.sessaoMotorista.findUnique({ where: { tokenHash: hashToken(token) }, include: { motorista: { include: { transportadora: true } } } });
    const agora = new Date();
    // Bloqueado (o bloqueio também encerra as sessões): mensagem clara, não "sessão terminou".
    if (s && (s.motorista.bloqueado || !s.motorista.transportadora.ativo)) {
      limparCookieMotorista(res);
      return res.status(403).json({ erro: "Seu acesso foi bloqueado. Fale com o responsável.", codigo: "MOTORISTA_BLOQUEADO" });
    }
    if (!s || s.revogadaEm || s.expiraEm < agora) {
      limparCookieMotorista(res);
      return res.status(401).json({ erro: "Sua sessão terminou. Entre de novo com o seu celular.", codigo: "SEM_SESSAO_MOTORISTA" });
    }
    const m = s.motorista;
    if (m.bloqueado || !m.transportadora.ativo || !m.consentimentoEm) {
      limparCookieMotorista(res);
      return res.status(403).json({ erro: "Seu acesso foi bloqueado. Fale com o responsável.", codigo: "MOTORISTA_BLOQUEADO" });
    }
    // Último uso: grava no máximo a cada 10 min (evita uma escrita por requisição).
    if (!s.ultimoUsoEm || agora - s.ultimoUsoEm > 10 * MIN) {
      await prisma.sessaoMotorista.update({ where: { id: s.id }, data: { ultimoUsoEm: agora } });
      await prisma.motorista.update({ where: { id: m.id }, data: { ultimoAcessoEm: agora } });
    }
    req.motorista = m;
    req.sessaoMotoristaId = s.id;
    req.usuario = { id: null, motoristaId: m.id, email: identidadeMotorista(m), nome: m.nome, perfil: "TRANSPORTADOR" };
    req.permissoes = ["qr.registrar"];
    next();
  } catch (err) {
    next(err);
  }
}

export async function encerrarSessao(req, res) {
  const token = req.cookies?.[COOKIE_MOTORISTA];
  if (token) await prisma.sessaoMotorista.updateMany({ where: { tokenHash: hashToken(token), revogadaEm: null }, data: { revogadaEm: new Date(), revogadaPor: "o próprio motorista (Sair)" } });
  limparCookieMotorista(res);
}

export const dadosPublicosMotorista = (m) => ({
  id: m.id, nome: m.nome, celular: m.celular, placa: m.placa, transportadora: m.transportadora ? { id: m.transportadora.id, nome: m.transportadora.nome } : null,
});
