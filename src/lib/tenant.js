// Contexto da organização (multi-tenant, v3.0). Cada requisição/rotina roda "dentro" de uma
// organização; o Prisma (lib/prisma.js) usa esse contexto para filtrar TODAS as consultas das
// tabelas de cliente e preencher organizacaoId nas criações. Sem contexto, a consulta falha
// (nunca devolve dados de todas as organizações por engano).
//   { organizacaoId: 7 }       → usuário/rotina de uma organização
//   { organizacaoId: null }    → plataforma (admin da plataforma, gestor de transportadora):
//                                 só enxerga registros sem organização
//   { sistema: true }          → rotina interna explícita (login, varredura por organização…):
//                                 sem filtro — usar só onde a própria rotina escolhe a organização
import { AsyncLocalStorage } from "node:async_hooks";

const armazem = new AsyncLocalStorage();

export const contextoAtual = () => armazem.getStore() ?? null;

export function organizacaoAtual() {
  const c = contextoAtual();
  if (!c || c.sistema) return undefined;
  return c.organizacaoId;
}

// Atenção: consultas do Prisma só executam quando alguém faz await/then. Por isso o await fica
// DENTRO do contexto — senão comoSistema(() => prisma.x.findMany()) executaria fora dele.
const rodar = (store, fn) => armazem.run(store, async () => await fn());
export const comOrganizacao = (organizacaoId, fn, extra = {}) => rodar({ ...extra, organizacaoId }, fn);
export const comoPlataforma = (fn) => rodar({ organizacaoId: null }, fn);
export const comoSistema = (fn) => rodar({ sistema: true }, fn);
// Marca que as consultas já estão dentro de uma transação (o contexto do banco já foi definido).
export const dentroDaTransacao = (fn) => rodar({ ...(contextoAtual() ?? {}), emTransacao: true }, fn);

// Middleware do Express: a requisição inteira roda na organização do usuário logado.
export function contextoDaRequisicao(req, _res, next) {
  const org = req.usuario?.organizacaoId ?? null;
  armazem.run({ organizacaoId: org }, next);
}
