// Prepara o usuário de banco da APLICAÇÃO (v3.0, multi-tenant): "ccs_app", sem BYPASSRLS e sem
// ser dono das tabelas — assim as políticas de Row-Level Security valem para ele. Roda no build,
// depois do "prisma migrate deploy", com a conexão de migração (DATABASE_URL, dono das tabelas).
// A senha vem de APP_DB_ROLE_PASSWORD (variável de ambiente; nunca no código). Idempotente:
// cria o usuário se faltar, sempre sincroniza a senha e as permissões.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

export const USUARIO_APP = "ccs_app";

export async function prepararBanco({ url = process.env.DATABASE_URL, senha = process.env.APP_DB_ROLE_PASSWORD } = {}) {
  if (!senha) {
    console.log("preparar-banco: APP_DB_ROLE_PASSWORD não definida — o sistema continua usando DATABASE_URL (sem o usuário restrito).");
    return false;
  }
  if (senha.length < 16) throw new Error("APP_DB_ROLE_PASSWORD precisa ter pelo menos 16 caracteres.");
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    const existe = await db.$queryRaw`SELECT 1 FROM pg_roles WHERE rolname = ${USUARIO_APP}`;
    // Senha como literal SQL (CREATE/ALTER ROLE não aceitam parâmetro): aspas escapadas.
    const literal = `'${senha.replace(/'/g, "''")}'`;
    if (!existe.length) await db.$executeRawUnsafe(`CREATE ROLE ${USUARIO_APP} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${literal}`);
    else await db.$executeRawUnsafe(`ALTER ROLE ${USUARIO_APP} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${literal}`);
    await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${USUARIO_APP}`);
    await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${USUARIO_APP}`);
    await db.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${USUARIO_APP}`);
    // A tabela de controle das migrações fica fora do alcance do sistema.
    await db.$executeRawUnsafe(`REVOKE ALL ON "_prisma_migrations" FROM ${USUARIO_APP}`);
    // Tabelas/sequências criadas por migrações futuras já nascem com as mesmas permissões.
    await db.$executeRawUnsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${USUARIO_APP}`);
    await db.$executeRawUnsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${USUARIO_APP}`);
    console.log(`preparar-banco: usuário ${USUARIO_APP} ${existe.length ? "atualizado" : "criado"} (RLS aplicado a ele).`);
    return true;
  } finally {
    await db.$disconnect();
  }
}

// Endereço de conexão do sistema: o mesmo servidor/banco de DATABASE_URL com o usuário ccs_app.
// No pooler do Supabase o usuário vem como "postgres.<projeto>" → "ccs_app.<projeto>".
export function urlDaAplicacao(env = process.env) {
  if (!env.APP_DB_ROLE_PASSWORD) return env.DATABASE_URL;
  const u = new URL(env.DATABASE_URL);
  const sufixo = decodeURIComponent(u.username).includes(".") ? decodeURIComponent(u.username).slice(decodeURIComponent(u.username).indexOf(".")) : "";
  u.username = encodeURIComponent(USUARIO_APP + sufixo);
  u.password = encodeURIComponent(env.APP_DB_ROLE_PASSWORD);
  return u.toString();
}

// Executado direto (node scripts/preparar-banco.js no build).
if (process.argv[1]?.split(/[\\/]/).slice(-2).join("/") === "scripts/preparar-banco.js") {
  prepararBanco().catch((err) => {
    console.error("preparar-banco: falhou:", err.message);
    process.exit(1);
  });
}
