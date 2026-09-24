import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { gerarToken, definirCookieAuth, limparCookieAuth, requireAuth } from "../lib/auth.js";

export const authRouter = Router();

// Limita tentativas de login por IP para dificultar força bruta de senha.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: "Muitas tentativas de login. Aguarde alguns minutos e tente novamente." },
});

authRouter.post("/login", loginLimiter, asyncHandler(async (req, res) => {
  const { email, senha } = req.body ?? {};
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
  definirCookieAuth(res, gerarToken(usuario));
  res.json({ email: usuario.email, nome: usuario.nome, perfil: usuario.perfil });
}));

authRouter.post("/logout", (_req, res) => {
  limparCookieAuth(res);
  res.status(204).end();
});

authRouter.get("/me", requireAuth, (req, res) => {
  const { email, nome, perfil } = req.usuario;
  res.json({ email, nome, perfil });
});
