// Organizações (clientes da plataforma) — utilitários das rotinas automáticas (v3.0).
import { prisma } from "./prisma.js";
import { comOrganizacao } from "./tenant.js";

/** Roda fn dentro de cada organização ativa, uma por vez. Falha de uma não impede as outras. */
export async function paraCadaOrganizacao(fn, rotulo = "rotina") {
  const orgs = await prisma.organizacao.findMany({ where: { ativo: true }, select: { id: true, nome: true }, orderBy: { id: "asc" } });
  const resultados = [];
  for (const org of orgs) {
    try {
      resultados.push(await comOrganizacao(org.id, () => fn(org)));
    } catch (err) {
      console.error(`${rotulo}: falha na organização ${org.nome}:`, err);
    }
  }
  return resultados;
}
