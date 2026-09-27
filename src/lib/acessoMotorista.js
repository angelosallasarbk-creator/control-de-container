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
export const MAX_CODIGOS_POR_HORA = Number(process.env.MOTORISTA_MAX_CODIGOS_HORA) || 500;
export const COOKIE_MOTORISTA = "cc_motorista";
const MIN = 60 * 1000;
const COMPROVANTE_MIN = 30;

const segredo = () => {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET não configurado.");
  return process.env.JWT_SECRET;
};
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

export async function pedirCodigo({ celular: bruto, ip, agora = new Date() }) {
  const celular = celularValido(bruto);
  const recentes = await prisma.codigoAcessoMotorista.findMany({
    where: { celular, criadoEm: { gte: new Date(agora.getTime() - 60 * MIN) } }, orderBy: { criadoEm: "desc" }, select: { criadoEm: true },
  });
  if (recentes[0] && agora - recentes[0].criadoEm < MIN) throw erroHttp(429, "Aguarde 1 minuto para pedir outro código.");
  if (recentes.length >= 5) throw erroHttp(429, "Muitos códigos pedidos para este celular. Tente de novo em 1 hora.");
  // Teto global (proteção contra robô disparando SMS para muitos números = custo): 500 códigos/hora (ajustável).
  const ultimaHora = await prisma.codigoAcessoMotorista.count({ where: { criadoEm: { gte: new Date(agora.getTime() - 60 * MIN) } } });
  if (ultimaHora >= MAX_CODIGOS_POR_HORA) {
    console.error(`Acesso do motorista: teto de ${MAX_CODIGOS_POR_HORA} códigos/hora atingido — possível abuso.`);
    throw erroHttp(429, "Muitos pedidos de código no momento. Tente de novo em alguns minutos.");
  }
  const motorista = await prisma.motorista.findUnique({ where: { celular }, include: { transportadora: true } });
  if (motorista?.bloqueado) throw erroHttp(403, "Seu acesso foi bloqueado pela transportadora. Fale com o responsável.");

  const codigo = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.$transaction([
    // Pedido novo encerra os anteriores ainda válidos deste celular.
    prisma.codigoAcessoMotorista.updateMany({ where: { celular, encerradoEm: null }, data: { encerradoEm: agora } }),
    prisma.codigoAcessoMotorista.create({
      data: { celular, codigoHash: hashCodigo(celular, codigo), criadoEm: agora, expiraEm: new Date(agora.getTime() + VALIDADE_CODIGO_MIN * MIN), ip: ip ?? null },
    }),
  ]);
  const r = await enviarSms({ para: celular, texto: `CCS: seu codigo de acesso e ${codigo}. Vale por ${VALIDADE_CODIGO_MIN} min. Nao compartilhe.` });
  return { celular, simulado: Boolean(r.simulado), expiraEm: new Date(agora.getTime() + VALIDADE_CODIGO_MIN * MIN) };
}

export async function verificarCodigo({ celular: bruto, codigo, agora = new Date() }) {
  const celular = celularValido(bruto);
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

  const motorista = await prisma.motorista.findUnique({ where: { celular }, include: { transportadora: true } });
  if (motorista?.bloqueado) throw erroHttp(403, "Seu acesso foi bloqueado pela transportadora. Fale com o responsável.");
  if (motorista && motorista.consentimentoEm && motorista.transportadora.ativo) return { motorista };
  // Primeiro acesso (ou importado pelo gestor e ainda sem o termo aceito): completa o cadastro.
  const comprovante = jwt.sign({ tipo: "cadastro-motorista", celular }, segredo(), { expiresIn: `${COMPROVANTE_MIN}m` });
  const transportadoras = await prisma.transportadora.findMany({ where: { ativo: true }, orderBy: { nome: "asc" }, select: { id: true, nome: true } });
  return {
    precisaCadastro: true,
    comprovante,
    transportadoras,
    preenchido: motorista ? { nome: motorista.nome, transportadoraId: motorista.transportadora.ativo ? motorista.transportadoraId : null, placa: motorista.placa } : null,
  };
}

function lerComprovante(comprovante) {
  try {
    const p = jwt.verify(String(comprovante ?? ""), segredo());
    if (p.tipo !== "cadastro-motorista" || !p.celular) throw new Error();
    return p.celular;
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
  const celular = lerComprovante(comprovante);
  if (b.aceite !== true) throw erroHttp(400, "É preciso aceitar o termo de uso dos dados para continuar.");
  const dados = validarDadosMotorista(b);
  const transp = await prisma.transportadora.findUnique({ where: { id: dados.transportadoraId } });
  if (!transp?.ativo) throw erroHttp(400, "Transportadora não encontrada ou inativa.");
  const existente = await prisma.motorista.findUnique({ where: { celular } });
  if (existente?.bloqueado) throw erroHttp(403, "Seu acesso foi bloqueado pela transportadora. Fale com o responsável.");
  const motorista = existente
    ? await prisma.motorista.update({ where: { id: existente.id }, data: { ...dados, consentimentoEm: agora }, include: { transportadora: true } })
    : await prisma.motorista.create({ data: { ...dados, celular, consentimentoEm: agora }, include: { transportadora: true } }).catch(async (err) => {
        if (err.code === "P2002") return prisma.motorista.findUnique({ where: { celular }, include: { transportadora: true } });
        throw err;
      });
  await registrarLog({
    usuarioEmail: identidadeMotorista(motorista), acao: existente ? "MOTORISTA_ACEITE" : "MOTORISTA_CADASTRO", entidade: "Motorista", entidadeId: motorista.id,
    descricao: existente ? `Motorista ${motorista.nome} aceitou o termo no primeiro acesso` : `Motorista ${motorista.nome} (${transp.nome}) cadastrou-se pelo QR`,
  });
  return motorista;
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
      return res.status(403).json({ erro: "Seu acesso foi bloqueado pela transportadora. Fale com o responsável.", codigo: "MOTORISTA_BLOQUEADO" });
    }
    if (!s || s.revogadaEm || s.expiraEm < agora) {
      limparCookieMotorista(res);
      return res.status(401).json({ erro: "Sua sessão terminou. Entre de novo com o seu celular.", codigo: "SEM_SESSAO_MOTORISTA" });
    }
    const m = s.motorista;
    if (m.bloqueado || !m.transportadora.ativo || !m.consentimentoEm) {
      limparCookieMotorista(res);
      return res.status(403).json({ erro: "Seu acesso foi bloqueado pela transportadora. Fale com o responsável.", codigo: "MOTORISTA_BLOQUEADO" });
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
