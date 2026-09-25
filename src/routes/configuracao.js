import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { requirePermissao } from "../lib/permissoes.js";
import { registrarLog } from "../lib/auditoria.js";
import { lerConfiguracao, salvarConfiguracao } from "../lib/configuracao.js";
import { executarVerificacao } from "../lib/verificador.js";
import { inteiro, decimal } from "../lib/validacao.js";

export const configuracaoRouter = Router();

configuracaoRouter.get("/", asyncHandler(async (_req, res) => {
  res.json(await lerConfiguracao());
}));

configuracaoRouter.put("/", requirePermissao("administrar"), asyncHandler(async (req, res) => {
  const antes = await lerConfiguracao();
  const intervaloLeituraMinutos = inteiro(req.body?.intervaloLeituraMinutos, "Intervalo máximo entre leituras (min)", {
    obrigatorio: true,
    min: 0,
    max: 10080,
  });
  const cotacoes = {};
  for (const [chave, rotulo] of [["cotacaoUSD", "Cotação do dólar (R$)"], ["cotacaoEUR", "Cotação do euro (R$)"]]) {
    if (chave in (req.body ?? {})) cotacoes[chave] = decimal(req.body[chave], rotulo, { min: 0, max: 1000 }) ?? 0;
  }
  // Regras da previsão de rota (todas opcionais no corpo; o que não vier fica como está).
  const b = req.body ?? {};
  const rota = {};
  if ("rodagemInicioMin" in b) rota.rodagemInicioMin = inteiro(b.rodagemInicioMin, "Início da rodagem", { obrigatorio: true, min: 0, max: 1439 });
  if ("rodagemFimMin" in b) rota.rodagemFimMin = inteiro(b.rodagemFimMin, "Fim da rodagem", { obrigatorio: true, min: 1, max: 1440 });
  if ("kmPorDia" in b) rota.kmPorDia = decimal(b.kmPorDia, "Km por dia", { obrigatorio: true, min: 50, max: 2000 });
  if ("filaPortoHorasPadrao" in b) rota.filaPortoHorasPadrao = decimal(b.filaPortoHorasPadrao, "Fila padrão no porto (h)", { obrigatorio: true, min: 0, max: 240 });
  if ("fatorLinhaReta" in b) rota.fatorLinhaReta = decimal(b.fatorLinhaReta, "Fator da estimativa em linha reta", { obrigatorio: true, min: 1, max: 3 });
  if ("riscoFolgaHoras" in b) rota.riscoFolgaHoras = decimal(b.riscoFolgaHoras, "Folga mínima para alertar risco (h)", { obrigatorio: true, min: 0, max: 720 });
  if ("toleranciaPlanejadoMinutos" in b) rota.toleranciaPlanejadoMinutos = inteiro(b.toleranciaPlanejadoMinutos, "Tolerância do planejado (min)", { obrigatorio: true, min: 0, max: 10080 });
  if ("atrasoColetaCriticoHoras" in b) rota.atrasoColetaCriticoHoras = decimal(b.atrasoColetaCriticoHoras, "Atraso na coleta vira crítico após (h)", { obrigatorio: true, min: 0, max: 720 });
  if ("urlPublica" in b) {
    const url = String(b.urlPublica ?? "").trim().replace(/\/+$/, "");
    if (url && !/^https?:\/\/[^\s/]+(:\d+)?$/i.test(url)) {
      throw erroHttp(400, "Endereço do sistema inválido. Use só o endereço, sem caminho — ex.: http://192.168.0.10:5174 ou https://meusistema.onrender.com");
    }
    rota.urlPublica = url;
  }
  const inicio = rota.rodagemInicioMin ?? antes.rodagemInicioMin;
  const fim = rota.rodagemFimMin ?? antes.rodagemFimMin;
  if (fim - inicio < 60) throw erroHttp(400, "A janela de rodagem precisa ter pelo menos 1 hora (fim depois do início).");

  const depois = await salvarConfiguracao({ intervaloLeituraMinutos, ...cotacoes, ...rota });
  await registrarLog({ usuarioEmail: req.usuario.email, acao: "ALTERAR", entidade: "Configuracao", descricao: "Configurações alteradas", dadosAntes: antes, dadosDepois: depois });
  // Aplica as regras novas ("sem leitura", previsão de rota) já, sem esperar o próximo ciclo.
  await executarVerificacao();
  res.json(depois);
}));

export const logsRouter = Router();
logsRouter.use(requirePermissao("auditoria.ver"));

logsRouter.get("/", asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.entidade) where.entidade = String(req.query.entidade);
  if (req.query.entidadeId) where.entidadeId = String(req.query.entidadeId);
  const logs = await prisma.logAuditoria.findMany({
    where,
    orderBy: { criadoEm: "desc" },
    take: 300,
    select: { id: true, usuarioEmail: true, acao: true, entidade: true, entidadeId: true, descricao: true, criadoEm: true },
  });
  res.json(logs);
}));
