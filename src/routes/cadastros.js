import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { requirePermissao } from "../lib/permissoes.js";
import { registrarLog } from "../lib/auditoria.js";
import { decimaisParaNumero } from "../lib/containerView.js";
import { texto, inteiro, decimal, id as validarId } from "../lib/validacao.js";
import { STATUS_ENCERRADOS } from "../lib/prazos.js";
import { sincronizarAlertas } from "../lib/alertas.js";
import { SELECT_TIPO } from "../lib/tiposLocal.js";

// Cadastros de apoio (Regiões, Ponto de Carregamento, Armadores, Produtos) com o mesmo CRUD.
// Registro já usado não é excluído fisicamente: desativa-se (ativo = false).
// `uso` = relação que conta onde o registro é usado (bloqueia exclusão).

// A região pertence à FÁBRICA, mas a fábrica é um texto dentro do Ponto de Carregamento. Para uma
// fábrica nunca ficar dividida entre duas abas do Pátio:
// - sem região informada, o grupo herda a região dos outros clientes da mesma fábrica;
// - com região informada, ela é aplicada a todos os clientes daquela fábrica.
async function sincronizarRegiaoDaFabrica(tx, dados, corpo, antes) {
  const fabrica = dados.fabrica ?? antes?.fabrica;
  const outros = await tx.grupoOperacao.findMany({
    where: { fabrica: { equals: fabrica, mode: "insensitive" }, ...(antes ? { id: { not: antes.id } } : {}) },
    select: { id: true, regiaoId: true },
  });

  if ("regiaoId" in corpo) {
    if (dados.regiaoId) {
      const regiao = await tx.regiao.findUnique({ where: { id: dados.regiaoId } });
      if (!regiao) throw erroHttp(400, "Região não encontrada.");
      if (!regiao.ativo && regiao.id !== antes?.regiaoId) throw erroHttp(400, `A região "${regiao.nome}" está inativa.`);
    }
    const aAtualizar = outros.filter((o) => o.regiaoId !== dados.regiaoId).map((o) => o.id);
    return async () => {
      if (aAtualizar.length) {
        await tx.grupoOperacao.updateMany({ where: { id: { in: aAtualizar } }, data: { regiaoId: dados.regiaoId } });
      }
      return aAtualizar.length;
    };
  }

  // Região não informada: herda da fábrica (criação, ou renomeação para outra fábrica).
  if (outros.length && (!antes || dados.fabrica !== undefined)) {
    dados.regiaoId = outros[0].regiaoId;
  }
  return async () => 0;
}

const CADASTROS = {
  regioes: {
    modelo: "regiao",
    entidade: "Regiao",
    uso: "grupos",
    rotulo: (r) => r.nome,
    ordem: [{ nome: "asc" }],
    validar: (b, parcial) => {
      const d = {};
      if (!parcial || "nome" in b) d.nome = texto(b.nome, "Nome da região", { obrigatorio: true, max: 80 });
      if ("ativo" in b) d.ativo = Boolean(b.ativo);
      return d;
    },
  },
  grupos: {
    modelo: "grupoOperacao",
    entidade: "GrupoOperacao",
    uso: "containers",
    incluir: { regiao: { select: { id: true, nome: true } }, local: { select: { id: true, nome: true, tipo: SELECT_TIPO, cidade: true, uf: true } } },
    rotulo: (r) => `${r.cliente} / ${r.fabrica}`,
    ordem: [{ cliente: "asc" }, { fabrica: "asc" }],
    validar: (b, parcial) => {
      const d = {};
      if (!parcial || "cliente" in b) d.cliente = texto(b.cliente, "Cliente", { obrigatorio: true, max: 120 });
      if (!parcial || "fabrica" in b) d.fabrica = texto(b.fabrica, "Fábrica", { obrigatorio: true, max: 120 });
      if ("regiaoId" in b) d.regiaoId = b.regiaoId === null || b.regiaoId === "" ? null : validarId(b.regiaoId, "Região");
      if ("localId" in b) d.localId = b.localId === null || b.localId === "" ? null : validarId(b.localId, "Local da fábrica");
      if (!parcial || "metaEstadiaHoras" in b)
        d.metaEstadiaHoras = inteiro(b.metaEstadiaHoras, "Meta de estadia (h)", { obrigatorio: true, min: 1, max: 2000 });
      if (!parcial || "alertaEstadiaHoras" in b)
        d.alertaEstadiaHoras = inteiro(b.alertaEstadiaHoras ?? 6, "Antecedência do alerta (h)", { obrigatorio: true, min: 0, max: 2000 });
      if ("custoEstadiaPorHora" in b) d.custoEstadiaPorHora = decimal(b.custoEstadiaPorHora, "Custo por hora excedida", { min: 0 });
      if ("ativo" in b) d.ativo = Boolean(b.ativo);
      return d;
    },
    antesDeSalvar: async (tx, dados, corpo, antes) => {
      if (dados.localId) {
        const local = await tx.local.findUnique({ where: { id: dados.localId }, include: { tipo: true } });
        if (!local) throw erroHttp(400, "Local da fábrica não encontrado.");
        if (local.tipo.funcao !== "CARREGAMENTO") throw erroHttp(400, "O local da fábrica precisa ser um local de carregamento (ex.: Fábrica ou Armazém).");
      }
      return sincronizarRegiaoDaFabrica(tx, dados, corpo, antes);
    },
  },
  armadores: {
    modelo: "armador",
    entidade: "Armador",
    uso: "containers",
    rotulo: (r) => r.nome,
    ordem: [{ nome: "asc" }],
    validar: (b, parcial) => {
      const d = {};
      if (!parcial || "nome" in b) d.nome = texto(b.nome, "Nome", { obrigatorio: true, max: 120 });
      if (!parcial || "freeTimeDias" in b) d.freeTimeDias = inteiro(b.freeTimeDias, "Free time (dias)", { obrigatorio: true, min: 0, max: 365 });
      if (!parcial || "valorDiaria" in b) d.valorDiaria = decimal(b.valorDiaria, "Valor da diária", { obrigatorio: true, min: 0 });
      if ("moeda" in b) d.moeda = (texto(b.moeda, "Moeda", { max: 3 }) ?? "USD").toUpperCase();
      if (!parcial || "alertaDemurrageDias" in b)
        d.alertaDemurrageDias = inteiro(b.alertaDemurrageDias ?? 2, "Antecedência do alerta (dias)", { obrigatorio: true, min: 0, max: 365 });
      if ("ativo" in b) d.ativo = Boolean(b.ativo);
      return d;
    },
  },
  produtos: {
    modelo: "produto",
    entidade: "Produto",
    uso: "containers",
    rotulo: (r) => r.nome,
    ordem: [{ nome: "asc" }],
    validar: (b, parcial) => {
      const d = {};
      if (!parcial || "nome" in b) d.nome = texto(b.nome, "Nome", { obrigatorio: true, max: 120 });
      for (const [campo, rotulo] of [["setpoint", "Setpoint"], ["tempMin", "Temperatura mínima"], ["tempMax", "Temperatura máxima"]]) {
        if (!parcial || campo in b) d[campo] = decimal(b[campo], rotulo, { obrigatorio: true, min: -60, max: 60 });
      }
      if (!parcial || "toleranciaMinutos" in b)
        d.toleranciaMinutos = inteiro(b.toleranciaMinutos ?? 30, "Tolerância (min)", { obrigatorio: true, min: 0, max: 1440 });
      if ("ativo" in b) d.ativo = Boolean(b.ativo);
      return d;
    },
    validarConjunto: (r) => {
      if (Number(r.tempMin) > Number(r.tempMax)) throw erroHttp(400, "A temperatura mínima não pode ser maior que a máxima.");
      if (Number(r.setpoint) < Number(r.tempMin) || Number(r.setpoint) > Number(r.tempMax))
        throw erroHttp(400, "O setpoint precisa estar dentro da faixa mínima–máxima.");
    },
  },
};

// Campos que o container copia do cadastro na criação. Ao editar o cadastro, o usuário pode
// escolher aplicar os valores novos aos containers EM ANDAMENTO (entregues/cancelados nunca
// mudam, para o histórico de custo continuar valendo).
CADASTROS.grupos.aplicarNosContainers = { fk: "grupoId", campos: ["metaEstadiaHoras", "alertaEstadiaHoras", "custoEstadiaPorHora"] };
CADASTROS.armadores.aplicarNosContainers = { fk: "armadorId", campos: ["freeTimeDias", "valorDiaria", "moeda", "alertaDemurrageDias"] };
CADASTROS.produtos.aplicarNosContainers = { fk: "produtoId", campos: ["setpoint", "tempMin", "tempMax", "toleranciaMinutos"] };

const EM_ANDAMENTO = { status: { notIn: STATUS_ENCERRADOS } };

export const cadastrosRouter = Router();

function traduzirErroUnico(err) {
  if (err.code === "P2002") throw erroHttp(409, "Já existe um cadastro com esse nome.");
  throw err;
}

for (const [rota, cfg] of Object.entries(CADASTROS)) {
  const repo = (cliente = prisma) => cliente[cfg.modelo];
  const include = { ...cfg.incluir, _count: { select: { [cfg.uso]: true } } };
  // `emUso` = quantos registros dependem deste (containers, ou fábricas no caso de região).
  const serializar = ({ _count, ...r }) => ({ ...decimaisParaNumero(r), emUso: _count?.[cfg.uso] ?? 0 });

  cadastrosRouter.get(`/${rota}`, asyncHandler(async (req, res) => {
    const where = req.query.ativos === "1" ? { ativo: true } : {};
    const registros = await repo().findMany({ where, orderBy: cfg.ordem, include });
    // Quantos containers em andamento cada cadastro tem (para a opção "aplicar aos em andamento").
    const emAndamento = new Map();
    if (cfg.aplicarNosContainers) {
      const { fk } = cfg.aplicarNosContainers;
      const contagem = await prisma.container.groupBy({ by: [fk], where: EM_ANDAMENTO, _count: true });
      for (const linha of contagem) emAndamento.set(linha[fk], linha._count);
    }
    res.json(registros.map((r) => ({ ...serializar(r), emAndamento: emAndamento.get(r.id) ?? 0 })));
  }));

  cadastrosRouter.post(`/${rota}`, requirePermissao("cadastros.editar"), asyncHandler(async (req, res) => {
    const corpo = req.body ?? {};
    const dados = cfg.validar(corpo, false);
    cfg.validarConjunto?.(dados);
    const { criado, propagados } = await prisma.$transaction(async (tx) => {
      const depoisDeSalvar = cfg.antesDeSalvar ? await cfg.antesDeSalvar(tx, dados, corpo, null) : null;
      const criado = await repo(tx).create({ data: dados, include }).catch(traduzirErroUnico);
      return { criado, propagados: depoisDeSalvar ? await depoisDeSalvar() : 0 };
    });
    await registrarLog({
      usuarioEmail: req.usuario.email,
      acao: "CRIAR",
      entidade: cfg.entidade,
      entidadeId: criado.id,
      descricao: `Cadastro criado: ${cfg.rotulo(criado)}${propagados ? ` (região aplicada a mais ${propagados} cliente(s) da mesma fábrica)` : ""}`,
      dadosDepois: criado,
    });
    res.status(201).json(serializar(criado));
  }));

  cadastrosRouter.patch(`/${rota}/:id`, requirePermissao("cadastros.editar"), asyncHandler(async (req, res) => {
    const registroId = validarId(req.params.id);
    const corpo = req.body ?? {};
    const antes = await repo().findUnique({ where: { id: registroId } });
    if (!antes) throw erroHttp(404, "Cadastro não encontrado.");
    const dados = cfg.validar(corpo, true);
    cfg.validarConjunto?.({ ...antes, ...dados });
    const aplicar = Boolean(corpo.aplicarEmAndamento && cfg.aplicarNosContainers);
    const { depois, propagados, containersAtualizados } = await prisma.$transaction(async (tx) => {
      const depoisDeSalvar = cfg.antesDeSalvar ? await cfg.antesDeSalvar(tx, dados, corpo, antes) : null;
      const depois = await repo(tx).update({ where: { id: registroId }, data: dados, include }).catch(traduzirErroUnico);
      let containersAtualizados = [];
      if (aplicar) {
        // Aplica os valores ATUAIS do cadastro (não só os alterados agora): cobre também o caso
        // de o cadastro ter sido mudado antes sem aplicar.
        const { fk, campos } = cfg.aplicarNosContainers;
        const where = { [fk]: registroId, ...EM_ANDAMENTO };
        containersAtualizados = (await tx.container.findMany({ where, select: { id: true } })).map((c) => c.id);
        if (containersAtualizados.length) {
          await tx.container.updateMany({ where, data: Object.fromEntries(campos.map((c) => [c, depois[c]])) });
        }
      }
      return { depois, propagados: depoisDeSalvar ? await depoisDeSalvar() : 0, containersAtualizados };
    });
    // Prazos mudaram: recalcula alertas desses containers já, sem esperar o verificador.
    for (const id of containersAtualizados) await sincronizarAlertas(id);
    await registrarLog({
      usuarioEmail: req.usuario.email,
      acao: "ALTERAR",
      entidade: cfg.entidade,
      entidadeId: registroId,
      descricao:
        `Cadastro alterado: ${cfg.rotulo(depois)}` +
        (propagados ? ` (região aplicada a mais ${propagados} cliente(s) da mesma fábrica)` : "") +
        (cfg.aplicarNosContainers
          ? aplicar
            ? ` (valores aplicados a ${containersAtualizados.length} container(s) em andamento: ${containersAtualizados.join(", ") || "nenhum"})`
            : " (containers em andamento mantêm os valores antigos)"
          : ""),
      dadosAntes: antes,
      dadosDepois: depois,
    });
    res.json({ ...serializar(depois), propagados, containersAtualizados: containersAtualizados.length });
  }));

  cadastrosRouter.delete(`/${rota}/:id`, requirePermissao("cadastros.editar"), asyncHandler(async (req, res) => {
    const registroId = validarId(req.params.id);
    const antes = await repo().findUnique({ where: { id: registroId }, include: { _count: { select: { [cfg.uso]: true } } } });
    if (!antes) throw erroHttp(404, "Cadastro não encontrado.");
    if (antes._count[cfg.uso] > 0) {
      throw erroHttp(
        409,
        cfg.uso === "grupos"
          ? "Esta região tem fábricas vinculadas. Mova as fábricas para outra região ou desative a região."
          : "Este cadastro já foi usado em containers. Desative-o em vez de excluir, para preservar o histórico."
      );
    }
    await repo().delete({ where: { id: registroId } });
    await registrarLog({
      usuarioEmail: req.usuario.email,
      acao: "EXCLUIR",
      entidade: cfg.entidade,
      entidadeId: registroId,
      descricao: `Cadastro excluído: ${cfg.rotulo(antes)}`,
      dadosAntes: antes,
    });
    res.status(204).end();
  }));
}
