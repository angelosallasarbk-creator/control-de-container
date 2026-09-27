import jwt from "jsonwebtoken";

const SEGREDO = process.env.JWT_SECRET;
if (!SEGREDO) {
  throw new Error("Variável de ambiente JWT_SECRET não definida.");
}

const COOKIE_NOME = "token_container";
// Sessão normal: 12h e o cookie some ao fechar o navegador. "Lembrar meu login": 30 dias.
// A senha nunca vai para o navegador — só este token, num cookie httpOnly (o JavaScript da
// página não lê) e Secure em produção.
const DURACAO_NORMAL = "12h";
export const LEMBRAR_DIAS = 30;

export function gerarToken(usuario, { lembrar = false } = {}) {
  // sv = "versão" das sessões do usuário no momento da emissão (sessoesValidasApos). Trocar a
  // senha muda a versão e todo token antigo deixa de bater — comparação exata, sem janela de tempo.
  const sv = usuario.sessoesValidasApos ? new Date(usuario.sessoesValidasApos).getTime() : 0;
  return jwt.sign({ email: usuario.email, nome: usuario.nome, perfil: usuario.perfil, lembrar: Boolean(lembrar), sv }, SEGREDO, {
    expiresIn: lembrar ? `${LEMBRAR_DIAS}d` : DURACAO_NORMAL,
  });
}

export function definirCookieAuth(res, token, { lembrar = false } = {}) {
  res.cookie(COOKIE_NOME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    // Sem maxAge = cookie de sessão (apagado ao fechar o navegador).
    ...(lembrar ? { maxAge: LEMBRAR_DIAS * 24 * 60 * 60 * 1000 } : {}),
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

// Autorização por ação: ver src/lib/permissoes.js (requirePermissao / carregarUsuarioAtual).
