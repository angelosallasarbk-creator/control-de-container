import bcrypt from "bcryptjs";
import { prisma } from "./prisma.js";
import { registrarLog } from "./auditoria.js";
import { comoSistema } from "./tenant.js";

// Cria o primeiro administrador a partir de variáveis de ambiente, SOMENTE se o banco ainda
// não tiver nenhum usuário. Serve para hospedagens sem shell (ex.: Render gratuito). Depois
// que existir qualquer usuário, as variáveis são ignoradas — podem (e devem) ser removidas.
export function criarAdminInicialSeNecessario(env = process.env) {
  return comoSistema(() => criarAdminInicial(env));
}

async function criarAdminInicial(env) {
  const email = env.ADMIN_INICIAL_EMAIL?.trim().toLowerCase();
  const senha = env.ADMIN_INICIAL_SENHA;
  if (!email || !senha) return null;
  if ((await prisma.usuario.count()) > 0) {
    console.log("Admin inicial: já existem usuários; ADMIN_INICIAL_* ignoradas (pode remover essas variáveis).");
    return null;
  }
  if (senha.length < 8) {
    console.error("Admin inicial: ADMIN_INICIAL_SENHA precisa ter pelo menos 8 caracteres. Nada foi criado.");
    return null;
  }
  // Primeira organização (a migração v3.0 cria a AS TECH LOG).
  const org = await prisma.organizacao.findFirst({ orderBy: { id: "asc" } });
  if (!org) {
    console.error("Admin inicial: nenhuma organização cadastrada. Nada foi criado.");
    return null;
  }
  const usuario = await prisma.usuario.create({
    data: {
      organizacaoId: org.id,
      email,
      nome: env.ADMIN_INICIAL_NOME?.trim() || "Administrador",
      perfil: "ADMIN",
      senhaHash: await bcrypt.hash(senha, 10),
    },
  });
  await registrarLog({ organizacaoId: org.id, usuarioEmail: "sistema", acao: "CRIAR", entidade: "Usuario", entidadeId: usuario.id, descricao: `Administrador inicial criado: ${email}` });
  console.log(`Admin inicial criado: ${email}. Troque a senha pela tela e remova ADMIN_INICIAL_* do ambiente.`);
  return usuario;
}
