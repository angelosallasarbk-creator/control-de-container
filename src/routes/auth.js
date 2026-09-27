import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { gerarToken, definirCookieAuth, limparCookieAuth, requireAuth } from "../lib/auth.js";
import { permissoesEfetivas, carregarUsuarioAtual } from "../lib/permissoes.js";
import { solicitarRedefinicao, conferirCodigo, redefinirComCodigo } from "../lib/redefinicaoSenha.js";
import { enderecoPublico } from "../lib/enderecoPublico.js";

export const authRouter = Router();

// Limita tentativas de login por IP para dificultar força bruta de senha. Só as tentativas que
// FALHAM contam: vários usuários atrás do mesmo IP (mesmo escritório) entrando certo não se bloqueiam.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: "Muitas tentativas de login. Aguarde alguns minutos e tente novamente." },
});

authRouter.post("/login", loginLimiter, asyncHandler(async (req, res) => {
  const { email, senha } = req.body ?? {};
  const lembrar = req.body?.lembrar === true;
  if (!email || !senha) {
    return res.status(400).json({ erro: "E-mail e senha são obrigatórios." });
  }
  const usuario = await prisma.usuario.findUnique({ where: { email: String(email).toLowerCase().trim() } });
  // Mesma mensagem para e-mail inexistente e senha errada: não revela quais e-mails existem.
  if (!usuario || !(await bcrypt.compare(String(senha), usuario.senhaHash))) {
    return res.status(401).json({ erro: "E-mail ou senha inválidos." });
  }
  if (!usuario.ativo) {
    return res.status(401).json({ erro: "Conta desativada. Fale com um administrador." });
  }
  definirCookieAuth(res, gerarToken(usuario, { lembrar }), { lembrar });
  res.json({ email: usuario.email, nome: usuario.nome, perfil: usuario.perfil, permissoes: permissoesEfetivas(usuario) });
}));

// ---------- Esqueci minha senha ----------
// Resposta sempre igual (exista ou não o e-mail): não revela quais contas existem.
const RESPOSTA_ESQUECI = { mensagem: "Se o e-mail estiver cadastrado, você receberá em instantes um link para criar uma nova senha." };
const esqueciLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: "Muitos pedidos de redefinição. Aguarde alguns minutos e tente novamente." },
});
const redefinirLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: "Muitas tentativas. Aguarde alguns minutos e tente novamente." },
});

authRouter.post("/esqueci-senha", esqueciLimiter, asyncHandler(async (req, res) => {
  const email = String(req.body?.email ?? "").trim();
  if (!email || email.length > 160) return res.status(400).json({ erro: "Informe o e-mail da sua conta." });
  const base = await enderecoPublico(req);
  if (!base) {
    console.error("Esqueci minha senha: defina o endereço do sistema (Configurações → Etiquetas QR ou APP_URL) para montar o link.");
    return res.json(RESPOSTA_ESQUECI);
  }
  try {
    await solicitarRedefinicao({ email, baseUrl: base });
  } catch (err) {
    // Falha no envio não muda a resposta (não revela se a conta existe); fica no log do servidor.
    console.error("Esqueci minha senha: falha ao enviar o e-mail:", err.message);
  }
  res.json(RESPOSTA_ESQUECI);
}));

authRouter.get("/redefinir-senha/:codigo", redefinirLimiter, asyncHandler(async (req, res) => {
  res.json(await conferirCodigo(req.params.codigo));
}));

authRouter.post("/redefinir-senha", redefinirLimiter, asyncHandler(async (req, res) => {
  await redefinirComCodigo({ codigo: req.body?.codigo, senha: req.body?.senha });
  res.json({ mensagem: "Senha redefinida. Entre com a nova senha." });
}));

authRouter.post("/logout", (_req, res) => {
  limparCookieAuth(res);
  res.status(204).end();
});

// A tela consulta periodicamente: permissões/perfil alterados pelo admin aparecem sem relogar.
authRouter.get("/me", requireAuth, carregarUsuarioAtual, (req, res) => {
  const { email, nome, perfil } = req.usuario;
  res.json({ email, nome, perfil, permissoes: req.permissoes });
});
