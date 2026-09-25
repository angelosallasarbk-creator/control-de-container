import { prisma } from "./prisma.js";
import { lerConfiguracao } from "./configuracao.js";
import { calcularSituacao, alertasDesejados, STATUS_ENCERRADOS } from "./prazos.js";
import { estimarCiclo } from "./estimativa.js";
import { montarContextos, configRodagem } from "./previsao.js";

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

// Compara os alertas que deveriam estar abertos com os que estão abertos no banco:
// abre os que faltam e encerra os que deixaram de valer. Idempotente — pode rodar quantas
// vezes for preciso sem duplicar alerta (o índice único em chaveAberta garante isso).
export async function sincronizarAlertas(containerId, { agora = new Date(), config } = {}) {
  const container = await prisma.container.findUnique({ where: { id: containerId } });
  if (!container) return { abertos: 0, encerrados: 0 };
  const cfg = config ?? (await lerConfiguracao());
  const [leituras, contextos] = await Promise.all([leiturasRecentes(containerId), montarContextos([container], cfg)]);
  const previsao = estimarCiclo(container, contextos.get(containerId), agora, configRodagem(cfg));
  const situacao = calcularSituacao(container, leituras, agora, cfg.intervaloLeituraMinutos, previsao, cfg.atrasoColetaCriticoHoras);
  const desejados = alertasDesejados(container, situacao);
  const chavesDesejadas = new Set(desejados.map((a) => chaveAlerta(containerId, a.tipo, a.nivel)));

  const abertos = await prisma.alerta.findMany({ where: { containerId, chaveAberta: { not: null } } });
  const chavesAbertas = new Set(abertos.map((a) => a.chaveAberta));

  const aEncerrar = abertos.filter((a) => !chavesDesejadas.has(a.chaveAberta));
  if (aEncerrar.length) {
    await prisma.alerta.updateMany({
      where: { id: { in: aEncerrar.map((a) => a.id) } },
      data: { encerradoEm: agora, chaveAberta: null },
    });
  }

  let criados = 0;
  for (const alerta of desejados) {
    const chave = chaveAlerta(containerId, alerta.tipo, alerta.nivel);
    if (chavesAbertas.has(chave)) continue;
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
export async function sincronizarTodos(agora = new Date()) {
  const config = await lerConfiguracao();
  const alvos = await prisma.container.findMany({
    where: {
      OR: [{ status: { notIn: STATUS_ENCERRADOS } }, { alertas: { some: { chaveAberta: { not: null } } } }],
    },
    select: { id: true },
  });
  let abertos = 0;
  let encerrados = 0;
  for (const { id } of alvos) {
    try {
      const r = await sincronizarAlertas(id, { agora, config });
      abertos += r.abertos;
      encerrados += r.encerrados;
    } catch (err) {
      // Um container com problema não pode travar a verificação dos demais.
      console.error(`Verificador: falha ao sincronizar alertas do container ${id}:`, err);
    }
  }
  return { containers: alvos.length, abertos, encerrados };
}
