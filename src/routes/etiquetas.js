import { Router } from "express";
import os from "node:os";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { requirePermissao } from "../lib/permissoes.js";
import { registrarLog } from "../lib/auditoria.js";
import { lerConfiguracao } from "../lib/configuracao.js";
import { gerarCodigo, gerarToken, urlDaEtiqueta, zplDoLote, MODELOS_ETIQUETA, DPI_SUPORTADOS } from "../lib/etiquetas.js";
import { STATUS_ENCERRADOS } from "../lib/prazos.js";
import { texto, inteiro, decimal, id as validarId, umDe } from "../lib/validacao.js";

const MAX_POR_LOTE = 500;

// Estado mostrado ao usuário: "ENCERRADA" é deduzido (container entregue/cancelado).
export function estadoDaEtiqueta(e) {
  if (e.status === "VINCULADA" && e.container && STATUS_ENCERRADOS.includes(e.container.status)) return "ENCERRADA";
  return e.status;
}

const SELECT_CONTAINER = { select: { id: true, numero: true, status: true, tipo: true } };
const INCLUDE = { container: SELECT_CONTAINER, lote: { select: { criadoPor: true } }, _count: { select: { leituras: true } } };

// Cada usuário vê, imprime e cancela só as etiquetas dos lotes que ELE gerou — assim uma
// fábrica não imprime por engano etiquetas de outra. O administrador pode pedir "todos"
// (?todos=1) para suporte/auditoria. Ler o QR (/api/qr) continua aberto a qualquer operador.
function escopo(req, { permitirTodos = true } = {}) {
  if (req.usuario.perfil === "ADMIN" && permitirTodos && req.query.todos === "1") return {};
  return { lote: { criadoPor: req.usuario.email } };
}
const ehDono = (req, e) => req.usuario.perfil === "ADMIN" || e.lote?.criadoPor === req.usuario.email;

function serializar(e) {
  return {
    id: e.id, codigo: e.codigo, token: e.token, loteId: e.loteId, status: e.status, estado: estadoDaEtiqueta(e),
    geradaPor: e.lote?.criadoPor ?? null,
    container: e.container ?? null, vinculadaEm: e.vinculadaEm, vinculadaPor: e.vinculadaPor,
    canceladaEm: e.canceladaEm, canceladaPor: e.canceladaPor, motivoCancelamento: e.motivoCancelamento,
    vezesImpressa: e.vezesImpressa ?? 0, impressaEm: e.impressaEm ?? null, impressaPor: e.impressaPor ?? null,
    criadoEm: e.criadoEm, leituras: e._count?.leituras ?? 0,
  };
}

// Etiquetas pedidas por id que são do usuário. Se alguma não for, recusa (em vez de ignorar
// calado) para ninguém imprimir um lote achando que saiu completo.
async function etiquetasDoUsuario(req, ids) {
  const encontradas = await prisma.etiquetaQR.findMany({ where: { id: { in: ids }, ...escopo(req, { permitirTodos: false }) }, include: INCLUDE, orderBy: { id: "asc" } });
  if (req.usuario.perfil !== "ADMIN" && encontradas.length !== new Set(ids).size) {
    throw erroHttp(403, "Há etiquetas selecionadas que foram geradas por outro usuário. Cada pessoa imprime só as etiquetas que gerou.");
  }
  if (req.usuario.perfil === "ADMIN" && encontradas.length !== new Set(ids).size) {
    // Admin pode imprimir de qualquer um (suporte), mas nunca ids inexistentes.
    const todas = await prisma.etiquetaQR.findMany({ where: { id: { in: ids } }, include: INCLUDE, orderBy: { id: "asc" } });
    if (todas.length !== new Set(ids).size) throw erroHttp(404, "Etiqueta não encontrada.");
    return todas;
  }
  return encontradas;
}

// Endereços IPv4 desta máquina na rede local: sugestão para testar o QR no celular sem publicar.
// Adaptadores virtuais (WSL, Hyper-V, Docker, VMs) vão por último: o celular não os alcança.
const ADAPTADOR_VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback/i;
function enderecosDaRede() {
  const ips = [];
  for (const [nome, lista] of Object.entries(os.networkInterfaces())) {
    for (const a of lista ?? []) {
      if (a.family === "IPv4" && !a.internal && !/^169\.254\./.test(a.address)) {
        ips.push({ interface: nome, ip: a.address, virtual: ADAPTADOR_VIRTUAL.test(nome) });
      }
    }
  }
  return ips.sort((a, b) => a.virtual - b.virtual);
}

// Registra que as etiquetas foram enviadas à impressora (vezes, quando, quem) + log.
async function marcarImpressas(req, ids, meio) {
  if (!ids.length) return;
  const agora = new Date();
  await prisma.etiquetaQR.updateMany({
    where: { id: { in: ids } },
    data: { vezesImpressa: { increment: 1 }, impressaEm: agora, impressaPor: req.usuario.email },
  });
  await registrarLog({
    usuarioEmail: req.usuario.email, acao: "IMPRIMIR", entidade: "EtiquetaQR",
    descricao: `${ids.length} etiqueta(s) enviada(s) para impressão (${meio})`,
  });
}

export const etiquetasRouter = Router();

// A folha de impressão do navegador chama isto quando a janela de impressão fecha (afterprint).
etiquetasRouter.post("/impressas", requirePermissao("etiquetas.emitir"), asyncHandler(async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).slice(0, MAX_POR_LOTE).map((i) => validarId(i, "Etiqueta"));
  if (!ids.length) throw erroHttp(400, "Nenhuma etiqueta informada.");
  const etiquetas = (await etiquetasDoUsuario(req, ids)).filter((e) => e.status !== "CANCELADA");
  await marcarImpressas(req, etiquetas.map((e) => e.id), "navegador");
  res.status(204).end();
}));

etiquetasRouter.get("/", asyncHandler(async (req, res) => {
  const where = { ...escopo(req) };
  if (req.query.impressao === "nao") where.vezesImpressa = 0;
  else if (req.query.impressao === "sim") where.vezesImpressa = { gt: 0 };
  if (req.query.ids) {
    where.id = { in: String(req.query.ids).split(",").slice(0, MAX_POR_LOTE).map((i) => validarId(i, "Etiqueta")) };
  }
  if (req.query.loteId) where.loteId = validarId(req.query.loteId, "Lote");
  if (req.query.busca) {
    const b = String(req.query.busca).trim().toUpperCase();
    where.OR = [{ codigo: { contains: b } }, { container: { numero: { contains: b.replace(/\s/g, "") } } }];
  }
  const etiquetas = await prisma.etiquetaQR.findMany({ where, include: INCLUDE, orderBy: { id: "desc" }, take: 1000 });
  let lista = etiquetas.map(serializar);
  if (req.query.estado) {
    const estado = umDe(req.query.estado, ["LIVRE", "VINCULADA", "ENCERRADA", "CANCELADA"], "Situação");
    lista = lista.filter((e) => e.estado === estado);
  }
  res.json(lista);
}));

etiquetasRouter.get("/lotes", asyncHandler(async (req, res) => {
  const where = req.usuario.perfil === "ADMIN" && req.query.todos === "1" ? {} : { criadoPor: req.usuario.email };
  const lotes = await prisma.loteEtiquetas.findMany({ where, orderBy: { id: "desc" }, take: 100, include: { _count: { select: { etiquetas: true } } } });
  res.json(lotes.map(({ _count, ...l }) => ({ ...l, total: _count.etiquetas })));
}));

// Dados para a tela de impressão: modelos de etiqueta, DPIs, endereço configurado e sugestões.
etiquetasRouter.get("/impressao", asyncHandler(async (_req, res) => {
  const config = await lerConfiguracao();
  const porta = process.env.PORT || 3000;
  res.json({
    modelos: MODELOS_ETIQUETA,
    dpis: DPI_SUPORTADOS,
    urlPublica: config.urlPublica,
    // Em desenvolvimento a tela roda no Vite (5174); no build, o próprio servidor serve tudo.
    sugestoes: enderecosDaRede().flatMap(({ interface: nome, ip, virtual }) => {
      const obs = virtual ? " — adaptador virtual, o celular não alcança" : "";
      return [
        { rotulo: `${ip} · porta 5174 (tela em desenvolvimento) · ${nome}${obs}`, url: `http://${ip}:5174`, virtual },
        { rotulo: `${ip} · porta ${porta} (servidor) · ${nome}${obs}`, url: `http://${ip}:${porta}`, virtual },
      ];
    }),
  });
}));

etiquetasRouter.post("/lotes", requirePermissao("etiquetas.emitir"), asyncHandler(async (req, res) => {
  const quantidade = inteiro(req.body?.quantidade, "Quantidade", { obrigatorio: true, min: 1, max: MAX_POR_LOTE });
  const lote = await prisma.$transaction(async (tx) => {
    const l = await tx.loteEtiquetas.create({ data: { quantidade, criadoPor: req.usuario.email } });
    const codigos = new Set();
    while (codigos.size < quantidade) codigos.add(gerarCodigo());
    // Colisão com etiqueta antiga é improvável (31^6 combinações), mas o índice único garante.
    const existentes = new Set((await tx.etiquetaQR.findMany({ where: { codigo: { in: [...codigos] } }, select: { codigo: true } })).map((e) => e.codigo));
    for (const c of existentes) {
      codigos.delete(c);
      let novo;
      do novo = gerarCodigo(); while (codigos.has(novo) || existentes.has(novo));
      codigos.add(novo);
    }
    await tx.etiquetaQR.createMany({ data: [...codigos].map((codigo) => ({ codigo, token: gerarToken(), loteId: l.id })) });
    await registrarLog({ usuarioEmail: req.usuario.email, acao: "CRIAR", entidade: "LoteEtiquetas", entidadeId: l.id, descricao: `Lote de ${quantidade} etiqueta(s) QR gerado` }, tx);
    return l;
  });
  const etiquetas = await prisma.etiquetaQR.findMany({ where: { loteId: lote.id }, include: INCLUDE, orderBy: { id: "asc" } });
  res.status(201).json({ lote, etiquetas: etiquetas.map(serializar) });
}));

etiquetasRouter.post("/:id/cancelar", requirePermissao("etiquetas.cancelar"), asyncHandler(async (req, res) => {
  const etiquetaId = validarId(req.params.id, "Etiqueta");
  const motivo = texto(req.body?.motivo, "Motivo", { obrigatorio: true, max: 300 });
  const e = await prisma.etiquetaQR.findUnique({ where: { id: etiquetaId }, include: INCLUDE });
  if (!e) throw erroHttp(404, "Etiqueta não encontrada.");
  if (!ehDono(req, e)) throw erroHttp(403, "Esta etiqueta foi gerada por outro usuário; só quem gerou (ou um administrador) pode cancelá-la.");
  if (e.status === "CANCELADA") throw erroHttp(409, "Esta etiqueta já está cancelada.");
  const depois = await prisma.etiquetaQR.update({
    where: { id: etiquetaId },
    data: { status: "CANCELADA", canceladaEm: new Date(), canceladaPor: req.usuario.email, motivoCancelamento: motivo },
    include: INCLUDE,
  });
  await registrarLog({
    usuarioEmail: req.usuario.email, acao: "CANCELAR", entidade: "EtiquetaQR", entidadeId: etiquetaId,
    descricao: `Etiqueta ${e.codigo} cancelada${e.container ? ` (container ${e.container.numero})` : ""}: ${motivo}`,
  });
  res.json(serializar(depois));
}));

// Motivo pelo qual uma etiqueta NÃO pode ser excluída (null = pode). Etiqueta que já foi ligada
// a container ou tem leitura é prova de rastreabilidade: nesse caso o caminho é Cancelar.
function motivoParaNaoExcluir(e) {
  if (e.containerId) return `ligada ao container ${e.container?.numero ?? e.containerId} — use Cancelar`;
  if ((e._count?.leituras ?? 0) > 0) return `tem ${e._count.leituras} leitura(s) registrada(s) — use Cancelar`;
  return null;
}

/**
 * Excluir várias etiquetas em UMA requisição e UM comando no banco (deleteMany), com o padrão
 * de exclusão em massa segura:
 *  1. captura os ids pedidos (chave primária) já filtrados pelo dono, dentro da transação;
 *  2. separa as que podem sair das que não podem (e diz o motivo);
 *  3. apaga por id E repete as condições no WHERE (sem container, sem leituras, do dono) —
 *     se algo mudou entre a leitura e o delete (ex.: alguém ligou a etiqueta agora), ela não sai;
 *  4. ainda na transação, confere: saíram exatamente as esperadas e as recusadas continuam
 *     existindo. Se não bater, lança erro → rollback, nada é apagado.
 */
etiquetasRouter.post("/excluir", requirePermissao("etiquetas.cancelar"), asyncHandler(async (req, res) => {
  const pedidos = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!pedidos.length) throw erroHttp(400, "Selecione ao menos uma etiqueta.");
  if (pedidos.length > MAX_POR_LOTE) throw erroHttp(400, `Máximo de ${MAX_POR_LOTE} etiquetas por exclusão.`);
  const ids = [...new Set(pedidos.map((i) => validarId(i, "Etiqueta")))];
  const ehAdmin = req.usuario.perfil === "ADMIN";
  const doDono = ehAdmin ? {} : { lote: { criadoPor: req.usuario.email } };

  const resultado = await prisma.$transaction(async (tx) => {
    const encontradas = await tx.etiquetaQR.findMany({ where: { id: { in: ids } }, include: INCLUDE });
    if (encontradas.length !== ids.length) throw erroHttp(404, "Alguma etiqueta selecionada não existe mais. Atualize a tela.");
    if (!ehAdmin && encontradas.some((e) => e.lote.criadoPor !== req.usuario.email)) {
      throw erroHttp(403, "Há etiquetas selecionadas que foram geradas por outro usuário. Cada pessoa exclui só as etiquetas que gerou.");
    }
    const bloqueadas = encontradas.filter((e) => motivoParaNaoExcluir(e)).map((e) => ({ id: e.id, codigo: e.codigo, motivo: motivoParaNaoExcluir(e) }));
    const aExcluir = encontradas.filter((e) => !motivoParaNaoExcluir(e));
    const idsExcluir = aExcluir.map((e) => e.id);

    let apagadas = 0;
    if (idsExcluir.length) {
      ({ count: apagadas } = await tx.etiquetaQR.deleteMany({
        where: { id: { in: idsExcluir }, containerId: null, leituras: { none: {} }, ...doDono },
      }));
      // Conferência dentro da transação (nada é confirmado se falhar).
      const aindaExistem = await tx.etiquetaQR.findMany({ where: { id: { in: ids } }, select: { id: true } });
      const restantes = new Set(aindaExistem.map((e) => e.id));
      const sumiuRecusada = bloqueadas.some((b) => !restantes.has(b.id));
      const sobrouExcluida = idsExcluir.some((id) => restantes.has(id));
      if (apagadas !== idsExcluir.length || sumiuRecusada || sobrouExcluida) {
        throw erroHttp(409, "As etiquetas mudaram durante a exclusão (ex.: alguém acabou de usar uma delas). Nada foi excluído — atualize a tela e tente de novo.");
      }
      await registrarLog(
        {
          usuarioEmail: req.usuario.email, acao: "EXCLUIR", entidade: "EtiquetaQR",
          descricao: `${apagadas} etiqueta(s) QR excluída(s): ${aExcluir.map((e) => e.codigo).join(", ")}` +
            (aExcluir.some((e) => e.vezesImpressa > 0) ? ` (${aExcluir.filter((e) => e.vezesImpressa > 0).length} já impressa[s])` : ""),
          dadosAntes: aExcluir.map((e) => ({ id: e.id, codigo: e.codigo, status: e.status, vezesImpressa: e.vezesImpressa, geradaPor: e.lote.criadoPor })),
        },
        tx
      );
    }
    return { excluidas: aExcluir.map((e) => e.codigo), bloqueadas };
  });
  res.json(resultado);
}));

// Arquivo ZPL (linguagem da Zebra) para imprimir direto na impressora de etiquetas.
etiquetasRouter.post("/zpl", requirePermissao("etiquetas.emitir"), asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const ids = (Array.isArray(b.ids) ? b.ids : []).slice(0, MAX_POR_LOTE).map((i) => validarId(i, "Etiqueta"));
  if (!ids.length) throw erroHttp(400, "Selecione ao menos uma etiqueta.");
  const larguraMm = decimal(b.larguraMm, "Largura (mm)", { obrigatorio: true, min: 20, max: 200 });
  const alturaMm = decimal(b.alturaMm, "Altura (mm)", { obrigatorio: true, min: 15, max: 300 });
  const dpi = Number(umDe(String(b.dpi ?? 203), DPI_SUPORTADOS.map(String), "Resolução (dpi)"));
  const baseUrl = texto(b.baseUrl, "Endereço do sistema", { obrigatorio: true, max: 200 });
  if (!/^https?:\/\/[^\s/]+(:\d+)?\/?$/i.test(baseUrl)) throw erroHttp(400, "Endereço do sistema inválido (ex.: http://192.168.0.10:5174).");
  const etiquetas = (await etiquetasDoUsuario(req, ids)).filter((e) => e.status !== "CANCELADA");
  if (!etiquetas.length) throw erroHttp(400, "As etiquetas selecionadas estão canceladas.");
  const zpl = zplDoLote(etiquetas.map((e) => ({ codigo: e.codigo, url: urlDaEtiqueta(baseUrl, e.token) })), { larguraMm, alturaMm, dpi });
  await marcarImpressas(req, etiquetas.map((e) => e.id), "ZPL");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="etiquetas-${larguraMm}x${alturaMm}mm-${dpi}dpi.zpl"`);
  res.send(zpl);
}));
