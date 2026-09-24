// Cria (ou reativa e redefine a senha de) um administrador. Uso:
//   npm run criar-admin -- email@empresa.com "Nome Completo" "senha-com-8+-caracteres"
import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma.js";

const [email, nome, senha] = process.argv.slice(2);
if (!email || !nome || !senha || senha.length < 8) {
  console.error('Uso: npm run criar-admin -- email@empresa.com "Nome" "senha (mín. 8 caracteres)"');
  process.exit(1);
}

const senhaHash = await bcrypt.hash(senha, 10);
const usuario = await prisma.usuario.upsert({
  where: { email: email.toLowerCase().trim() },
  create: { email: email.toLowerCase().trim(), nome, senhaHash, perfil: "ADMIN" },
  update: { nome, senhaHash, perfil: "ADMIN", ativo: true },
});
console.log(`Administrador pronto: ${usuario.email}`);
await prisma.$disconnect();
