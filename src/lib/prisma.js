// Cliente Prisma com isolamento por organização (multi-tenant, v3.0).
// Camada 1 (aplicação): toda consulta a uma tabela de cliente recebe o filtro organizacaoId do
// contexto (lib/tenant.js) e toda criação recebe o organizacaoId. Sem contexto: erro.
// Camada 2 (banco): cada consulta roda numa transação que define app.org_id / app.sistema; as
// políticas de Row-Level Security do PostgreSQL só liberam as linhas daquela organização.
import { Prisma, PrismaClient } from "@prisma/client";
import { contextoAtual, dentroDaTransacao } from "./tenant.js";
import { urlDaAplicacao } from "../../scripts/preparar-banco.js";

// Tabelas de cliente (têm organizacaoId). Motorista, Transportadora e afins são globais.
export const MODELOS_DA_ORGANIZACAO = new Set([
  "Usuario", "Regiao", "GrupoOperacao", "TipoLocal", "TipoOperacao", "EtapaFluxo", "Local", "DistanciaRota", "Armador",
  "Produto", "Container", "EventoContainer", "LeituraTemperatura", "LoteEtiquetas", "EtiquetaQR", "Alerta", "TokenIntegracao",
  "Configuracao", "LogAuditoria", "PosicaoContainer", "SolicitacaoPosicao", "MensagemSms", "ParadaContainer", "MudancaTrajeto",
]);

// Tabelas em que o registro pode ser "da plataforma" (sem organização).
const ACEITA_SEM_ORGANIZACAO = new Set(["Usuario", "LogAuditoria", "MensagemSms"]);

const COM_WHERE = new Set([
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy",
  "update", "updateMany", "delete", "deleteMany", "upsert",
]);

export class SemOrganizacaoError extends Error {
  constructor(modelo, operacao) {
    super(`Consulta sem organização definida (${modelo}.${operacao}). Toda consulta a dados de cliente precisa de contexto.`);
    this.name = "SemOrganizacaoError";
  }
}

// Conexão com o usuário restrito ccs_app (RLS valendo) quando APP_DB_ROLE_PASSWORD existe.
const base = new PrismaClient({ datasourceUrl: urlDaAplicacao() });
// Produção sem o usuário restrito NÃO sobe (v3.4, item 7): com o usuário das migrações o RLS não
// vale e a camada da aplicação sozinha não filtra relações carregadas junto (include/select).
if (process.env.NODE_ENV === "production" && !process.env.APP_DB_ROLE_PASSWORD) {
  throw new Error("APP_DB_ROLE_PASSWORD não definida: em produção o sistema só conecta pelo usuário restrito ccs_app (RLS). Defina a variável no Render.");
}

// Valores do contexto para o banco (RLS): organização e modo sistema.
function variaveisDoBanco(ctx) {
  const org = ctx && !ctx.sistema && Number.isInteger(ctx.organizacaoId) ? String(ctx.organizacaoId) : "";
  return { org, sistema: ctx?.sistema ? "on" : "off", plataforma: ctx && !ctx.sistema && ctx.organizacaoId === null ? "on" : "off" };
}
export const definirContextoNoBanco = (cliente, ctx) => {
  const v = variaveisDoBanco(ctx);
  return cliente.$executeRaw`SELECT set_config('app.org_id', ${v.org}, true), set_config('app.sistema', ${v.sistema}, true), set_config('app.plataforma', ${v.plataforma}, true)`;
};

// SQL direto ($queryRaw etc.) também roda com o contexto definido (senão o RLS não mostra nada).
const RAW = new Set(["$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe"]);
function rawComContexto(nome) {
  return (...args) => {
    const ctx = contextoAtual();
    if (ctx?.emTransacao) return base[nome](...args);
    return base.$transaction([definirContextoNoBanco(base, ctx), base[nome](...args)]).then(([, r]) => r);
  };
}

function comOrganizacaoNosDados(dados, org) {
  if (Array.isArray(dados)) return dados.map((d) => ({ ...d, organizacaoId: org }));
  return { ...dados, organizacaoId: org };
}

const estendido = base.$extends({
  name: "multi-tenant",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!MODELOS_DA_ORGANIZACAO.has(model)) return query(args);
        const ctx = contextoAtual();
        // Sem contexto (ou só a marca de transação, sem organização): falha — nunca "sem filtro".
        if (!ctx || (!ctx.sistema && !("organizacaoId" in ctx))) throw new SemOrganizacaoError(model, operation);
        let a = args ?? {};
        if (!ctx.sistema) {
          const org = ctx.organizacaoId;
          // Plataforma (sem organização) em tabela que exige organização: não enxerga nada.
          const filtro = org === null && !ACEITA_SEM_ORGANIZACAO.has(model) ? { in: [] } : org;
          if (COM_WHERE.has(operation)) a = { ...a, where: { ...(a.where ?? {}), organizacaoId: filtro } };
          if (operation === "create" || operation === "createMany" || operation === "createManyAndReturn") a = { ...a, data: comOrganizacaoNosDados(a.data, org) };
          if (operation === "upsert") a = { ...a, create: comOrganizacaoNosDados(a.create, org) };
        }
        // Dentro de uma transação o contexto do banco já foi definido no início dela.
        if (ctx.emTransacao) return query(a);
        const [, resultado] = await base.$transaction([definirContextoNoBanco(base, ctx), query(a)]);
        return resultado;
      },
    },
  },
});

// Consultas feitas PELO objeto da transação (tx.modelo.x) não abrem outra transação: o contexto do
// banco já foi definido na abertura. Consultas pelo cliente de fora (prisma.x) dentro do callback
// rodam em outra conexão — continuam abrindo a própria transação com o contexto.
const txNoContexto = (tx) => new Proxy(tx, {
  get(alvo, prop) {
    const v = alvo[prop];
    if (typeof prop === "string" && !prop.startsWith("$") && v && typeof v === "object") {
      return new Proxy(v, { get: (m, metodo) => (typeof m[metodo] === "function" ? (...a) => dentroDaTransacao(() => m[metodo](...a)) : m[metodo]) });
    }
    return v;
  },
});

// Transação interativa: define o contexto do banco na abertura.
async function transacao(arg, opcoes) {
  if (Array.isArray(arg)) return estendido.$transaction(arg, opcoes); // lote: só tabelas globais
  const ctx = contextoAtual();
  return estendido.$transaction(async (tx) => {
    await definirContextoNoBanco(tx, ctx);
    return arg(txNoContexto(tx));
  }, opcoes);
}

export const prisma = new Proxy(estendido, {
  get(alvo, prop, receptor) {
    if (prop === "$transaction") return transacao;
    if (RAW.has(prop)) return rawComContexto(prop);
    return Reflect.get(alvo, prop, receptor);
  },
});
export const prismaBase = base;
export { Prisma };
