import jwt from "jsonwebtoken";

const SEGREDO = process.env.JWT_SECRET;
if (!SEGREDO) {
  throw new Error("Variável de ambiente JWT_SECRET não definida.");
}

const COOKIE_NOME = "token_container";
const EXPIRA_EM = "12h";

export function gerarToken(usuario) {
  return jwt.sign({ email: usuario.email, nome: usuario.nome, perfil: usuario.perfil }, SEGREDO, { expiresIn: EXPIRA_EM });
}

export function definirCookieAuth(res, token) {
  res.cookie(COOKIE_NOME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 12 * 60 * 60 * 1000,
  });
}

export function limparCookieAuth(res) {
  res.clearCookie(COOKIE_NOME);
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NOME];
  if (!token) {
    return res.status(401).json({ erro: "Não autenticado." });
  }
  try {
    req.usuario = jwt.verify(token, SEGREDO, { algorithms: ["HS256"] });
    next();
  } catch {
    return res.status(401).json({ erro: "Sessão inválida ou expirada." });
  }
}

// Perfis que podem executar cada tipo de ação. VISUALIZACAO só lê.
export const PERMISSOES = {
  cadastros: ["ADMIN", "SUPERVISOR"],
  operar: ["ADMIN", "SUPERVISOR", "OPERADOR"],
  administrar: ["ADMIN"],
};

export function requireRole(...perfisPermitidos) {
  return (req, res, next) => {
    if (!perfisPermitidos.includes(req.usuario?.perfil)) {
      return res.status(403).json({ erro: "Seu perfil não tem permissão para esta ação." });
    }
    next();
  };
}
