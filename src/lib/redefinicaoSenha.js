// "Esqueci minha senha": link de uso único, com validade, enviado por e-mail.
// - o código do link é aleatório (32 bytes) e só o hash SHA-256 fica no banco;
// - um pedido novo substitui o anterior; usar o link o invalida;
// - redefinir derruba todas as sessões da conta (sessoesValidasApos).
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma.js";
import { erroHttp } from "./asyncHandler.js";
import { registrarLog } from "./auditoria.js";
import { enviarEmail } from "./email.js";

export const SENHA_MIN = 8;
export const VALIDADE_LINK_MIN = 30;
// Mesmo usuário não recebe outro link antes disso (evita encher a caixa de alguém de e-mails).
const INTERVALO_MINIMO_MS = 60 * 1000;

export function validarSenha(senha) {
  if (!senha || String(senha).length < SENHA_MIN) throw erroHttp(400, `A senha deve ter pelo menos ${SENHA_MIN} caracteres.`);
  if (String(senha).length > 200) throw erroHttp(400, "Senha longa demais.");
  return String(senha);
}

const hashDoCodigo = (codigo) => crypto.createHash("sha256").update(String(codigo)).digest("hex");
const escapar = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function montarEmail(usuario, link) {
  const assunto = "Redefinição de senha – C.C.S";
  const texto =
    `Olá, ${usuario.nome}.\n\n` +
    `Recebemos um pedido para redefinir a senha da sua conta no C.C.S – Container Control Solutions.\n` +
    `Para criar uma nova senha, abra o link abaixo (válido por ${VALIDADE_LINK_MIN} minutos e de uso único):\n\n${link}\n\n` +
    `Se não foi você, ignore este e-mail: sua senha atual continua valendo.\n`;
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f3f5f8;font-family:Segoe UI,Arial,sans-serif;color:#1b2430">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;padding:28px">
      <tr><td style="text-align:center">
        <div style="font-size:26px;font-weight:800;letter-spacing:.06em">C.C.S</div>
        <div style="font-size:12px;color:#5b6776">Container Control Solutions</div>
      </td></tr>
      <tr><td style="padding-top:22px;font-size:15px;line-height:1.5">
        <p>Olá, <strong>${escapar(usuario.nome)}</strong>.</p>
        <p>Recebemos um pedido para redefinir a senha da sua conta.</p>
        <p style="text-align:center;margin:26px 0">
          <a href="${escapar(link)}" style="background:#1f5fa8;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Redefinir senha</a>
        </p>
        <p style="font-size:13px;color:#5b6776">O link vale por ${VALIDADE_LINK_MIN} minutos e só pode ser usado uma vez. Se o botão não funcionar, copie e cole no navegador:<br><span style="word-break:break-all">${escapar(link)}</span></p>
        <p style="font-size:13px;color:#5b6776">Se não foi você, ignore este e-mail: sua senha atual continua valendo.</p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
  return { assunto, texto, html };
}

/**
 * Gera o link e envia o e-mail. Devolve true se enviou, false se ignorou (conta inexistente,
 * inativa ou pedido repetido rápido demais). Quem chama responde sempre a mesma mensagem.
 */
export async function solicitarRedefinicao({ email, baseUrl, solicitante, agora = new Date() }) {
  const usuario = await prisma.usuario.findUnique({ where: { email: String(email ?? "").toLowerCase().trim() } });
  if (!usuario || !usuario.ativo) return false;
  if (usuario.resetSolicitadoEm && agora - usuario.resetSolicitadoEm < INTERVALO_MINIMO_MS) return false;

  const codigo = crypto.randomBytes(32).toString("base64url");
  await prisma.usuario.update({
    where: { id: usuario.id },
    data: { resetTokenHash: hashDoCodigo(codigo), resetExpiraEm: new Date(agora.getTime() + VALIDADE_LINK_MIN * 60 * 1000), resetSolicitadoEm: agora },
  });
  const link = `${String(baseUrl).replace(/\/+$/, "")}/redefinir-senha/${codigo}`;
  const { assunto, texto, html } = montarEmail(usuario, link);
  const quem = solicitante && solicitante !== usuario.email ? " pelo administrador" : "";
  let envio;
  try {
    envio = await enviarEmail({ para: usuario.email, nome: usuario.nome, assunto, texto, html });
  } catch (err) {
    // E-mail não saiu: desfaz o link (ninguém o recebeu) para poder pedir de novo na hora, e
    // registra o motivo no log de auditoria (visível em Configurações → Log).
    await prisma.usuario.update({ where: { id: usuario.id }, data: { resetTokenHash: null, resetExpiraEm: null, resetSolicitadoEm: null } });
    await registrarLog({
      usuarioEmail: solicitante ?? usuario.email, acao: "RESET_SENHA_FALHA_ENVIO", entidade: "Usuario", entidadeId: usuario.id,
      descricao: `Falha ao enviar o link de redefinição de senha para ${usuario.email}${quem}: ${String(err.message).slice(0, 300)}`,
    });
    throw err;
  }
  await registrarLog({
    usuarioEmail: solicitante ?? usuario.email, acao: "RESET_SENHA_SOLICITADO", entidade: "Usuario", entidadeId: usuario.id,
    descricao: envio?.simulado
      ? `Link de redefinição de senha gerado para ${usuario.email}${quem} (envio simulado — chave do Brevo não configurada, o e-mail não saiu)`
      : `Link de redefinição de senha enviado para ${usuario.email}${quem}`,
  });
  return true;
}

async function usuarioDoCodigo(codigo, agora) {
  if (!codigo || String(codigo).length > 200) return null;
  const u = await prisma.usuario.findUnique({ where: { resetTokenHash: hashDoCodigo(codigo) } });
  if (!u || !u.ativo || !u.resetExpiraEm || u.resetExpiraEm < agora) return null;
  return u;
}

export async function conferirCodigo(codigo, agora = new Date()) {
  const u = await usuarioDoCodigo(codigo, agora);
  return u ? { valido: true, nome: u.nome } : { valido: false };
}

export async function redefinirComCodigo({ codigo, senha, agora = new Date() }) {
  const nova = validarSenha(senha);
  const u = await usuarioDoCodigo(codigo, agora);
  if (!u) throw erroHttp(400, "Este link é inválido, já foi usado ou expirou. Peça um novo em \"Esqueci minha senha\".");
  // Condição no WHERE: dois envios simultâneos do mesmo link — só um redefine.
  const r = await prisma.usuario.updateMany({
    where: { id: u.id, resetTokenHash: u.resetTokenHash },
    // Link usado: libera um novo pedido na hora (o intervalo mínimo vale só com link pendente).
    data: { senhaHash: await bcrypt.hash(nova, 10), resetTokenHash: null, resetExpiraEm: null, resetSolicitadoEm: null, sessoesValidasApos: agora },
  });
  if (r.count !== 1) throw erroHttp(400, "Este link já foi usado. Peça um novo em \"Esqueci minha senha\".");
  await registrarLog({ usuarioEmail: u.email, acao: "RESET_SENHA", entidade: "Usuario", entidadeId: u.id, descricao: `Senha redefinida pelo link enviado para ${u.email}` });
  return { email: u.email };
}
