import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { lerConfiguracao } from "./configuracao.js";
import { calcularSituacao, alertasDesejados, STATUS_ENCERRADOS } from "./prazos.js";
import { estimarCiclo } from "./estimativa.js";
import { montarContextos, configRodagem } from "./previsao.js";
import { congelarPlanoSeFaltar, completarPlanoSeFaltar } from "./planejamento.js";
import { sincronizarViagem } from "./viagem.js";

// Leituras suficientes para achar o início de uma sequência fora da faixa sem carregar o histórico todo.
const LEITURAS_AVALIADAS = 200;

export function chaveAlerta(containerId, tipo, nivel) {
  return `${containerId}:${tipo}:${nivel}`;
}

export async function leiturasRecentes(containerId, cliente = prisma) {
  const desc = await cliente.leituraTemperatura.findMany({
    where: { containerId },
    orderBy: { lidaEm: "desc" },
    take: LEITURAS_AVALIADAS,
  });
  return desc.reverse();
}

// Últimas leituras de vários containers numa consulta só (varredura em lote, v3.4 item 12): as
// LEITURAS_AVALIADAS mais recentes de cada um, pelo índice (containerId, lidaEm). Em ordem cronológica.
async function leiturasDeVarios(ids) {
  const porContainer = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return porContainer;
  const linhas = await prisma.$queryRaw`
    SELECT l.* FROM unnest(ARRAY[${Prisma.join(ids)}]::int[]) AS c(id)
    CROSS JOIN LATERAL (
      SELECT * FROM "LeituraTemperatura" WHERE "containerId" = c.id ORDER BY "lidaEm" DESC LIMIT ${LEITURAS_AVALIADAS}
    ) l`;
  for (const l of linhas) porContainer.get(l.containerId).push(l);
  for (const lista of porContainer.values()) lista.reverse();
  return porContainer;
}

// Compara os alertas que deveriam estar abertos com os que estão abertos no banco:
// abre os que faltam e encerra os que deixaram de valer. Idempotente — pode rodar quantas
// vezes for preciso sem duplicar alerta (o índice único em chaveAberta garante isso).
export async function sincronizarAlertas(containerId, { agora = new Date(), config } = {}) {
  const container = await prisma.container.findUnique({ where: { id: containerId } });
  if (!container) return { abertos: 0, encerrados: 0 };
  const cfg = config ?? (await lerConfiguracao());
  const [leituras, contextos, abertos] = await Promise.all([
    leiturasRecentes(containerId),
    montarContextos([container], cfg),
    prisma.alerta.findMany({ where: { containerId, chaveAberta: { not: null } } }),
  ]);
  return aplicarAlertas(container, { leituras, contexto: contextos.get(containerId), abertos, cfg, agora });
}

// Núcleo da sincronização com os dados já carregados (um container ou a varredura em lote):
// só grava quando algo muda (plano a congelar, alerta a abrir/encerrar, mensagem a atualizar).
async function aplicarAlertas(container, { leituras, contexto, abertos, cfg, agora }) {
  const containerId = container.id;
  // Viagem (v3.8): quem chegou a um ponto, encerrou ou mudou de responsável sai dela.
  await sincronizarViagem(container, agora);
  const previsao = estimarCiclo(container, contexto, agora, configRodagem(cfg));
  // O plano parte da coleta programada mesmo que ela já tenha passado (a previsão "ao vivo" não
  // simula no passado): assim coleta, chegada, saída e entrega planejadas ficam coerentes entre si.
  const basePlano = !container.coletadoEm && container.coletaProgramadaEm ? new Date(container.coletaProgramadaEm) : null;
  const previsaoPlano = basePlano && basePlano < agora ? estimarCiclo(container, contexto, basePlano, configRodagem(cfg)) : previsao;
  await congelarPlanoSeFaltar(container, previsaoPlano, agora);
  await completarPlanoSeFaltar(container, previsao, agora);
  const situacao = calcularSituacao(container, leituras, agora, cfg.intervaloLeituraMinutos, previsao, cfg.atrasoColetaCriticoHoras);
  const desejados = alertasDesejados(container, situacao);
  const chavesDesejadas = new Set(desejados.map((a) => chaveAlerta(containerId, a.tipo, a.nivel)));

  const chavesAbertas = new Set(abertos.map((a) => a.chaveAberta));

  const aEncerrar = abertos.filter((a) => !chavesDesejadas.has(a.chaveAberta));
  if (aEncerrar.length) {
    await prisma.alerta.updateMany({
      where: { id: { in: aEncerrar.map((a) => a.id) } },
      data: { encerradoEm: agora, chaveAberta: null },
    });
  }

  let criados = 0;
  const abertoPorChave = new Map(abertos.map((a) => [a.chaveAberta, a]));
  for (const alerta of desejados) {
    const chave = chaveAlerta(containerId, alerta.tipo, alerta.nivel);
    if (chavesAbertas.has(chave)) {
      // Alerta já aberto: mantém a mensagem em dia ("atrasada há 2h30", não o texto do momento
      // em que abriu). Só grava quando o texto mudou.
      const atual = abertoPorChave.get(chave);
      if (atual.mensagem !== alerta.mensagem) await prisma.alerta.update({ where: { id: atual.id }, data: { mensagem: alerta.mensagem } });
      continue;
    }
    try {
      await prisma.alerta.create({ data: { containerId, ...alerta, chaveAberta: chave, abertoEm: agora } });
      criados++;
    } catch (err) {
      // P2002 = outra execução concorrente abriu o mesmo alerta primeiro; nada a fazer.
      if (err.code !== "P2002") throw err;
    }
  }
  return { abertos: criados, encerrados: aEncerrar.length };
}

// Varredura periódica: todo container ativo + qualquer container que ainda tenha alerta aberto.
// Em LOTE (v3.4, item 12): containers, leituras, contexto de rota e alertas abertos de todos de
// uma vez (4 consultas) — antes eram ~4 consultas por container, uma de cada vez.
export async function sincronizarTodos(agora = new Date()) {
  const config = await lerConfiguracao();
  const alvos = await prisma.container.findMany({
    where: {
      OR: [{ status: { notIn: STATUS_ENCERRADOS } }, { alertas: { some: { chaveAberta: { not: null } } } }],
    },
  });
  const ids = alvos.map((c) => c.id);
  const [leituras, contextos, todosAbertos] = await Promise.all([
    leiturasDeVarios(ids),
    montarContextos(alvos, config),
    ids.length ? prisma.alerta.findMany({ where: { containerId: { in: ids }, chaveAberta: { not: null } } }) : [],
  ]);
  const abertosPor = new Map(ids.map((id) => [id, []]));
  for (const a of todosAbertos) abertosPor.get(a.containerId).push(a);
  let abertos = 0;
  let encerrados = 0;
  for (const c of alvos) {
    try {
      const r = await aplicarAlertas(c, { leituras: leituras.get(c.id), contexto: contextos.get(c.id), abertos: abertosPor.get(c.id), cfg: config, agora });
      abertos += r.abertos;
      encerrados += r.encerrados;
    } catch (err) {
      // Um container com problema não pode travar a verificação dos demais.
      console.error(`Verificador: falha ao sincronizar alertas do container ${c.id}:`, err);
    }
  }
  return { containers: alvos.length, abertos, encerrados };
}
