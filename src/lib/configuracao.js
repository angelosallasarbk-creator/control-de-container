import { prisma } from "./prisma.js";

// Parâmetros globais editáveis na tela de Configurações.
export const CONFIG_PADRAO = {
  // Na leitura manual, o operador registra a temperatura a cada X minutos; passando disso, alerta.
  intervaloLeituraMinutos: 240,
  // Cotação manual para consolidar o Custo estimado em R$ (0 = não informada: a tela mostra
  // cada moeda separada, sem somar moedas diferentes).
  cotacaoUSD: 0,
  cotacaoEUR: 0,
  // Previsão de rota: janela diária de rodagem (minutos desde 00:00, horário de Brasília),
  // km máximos por dia, fila/gate padrão nos portos, fator da estimativa em linha reta
  // (quando o serviço de rota não responde) e folga mínima para alertar risco.
  rodagemInicioMin: 300, // 05:00
  rodagemFimMin: 1320, // 22:00
  kmPorDia: 500,
  filaPortoHorasPadrao: 4,
  fatorLinhaReta: 1.3,
  riscoFolgaHoras: 24,
};

export async function lerConfiguracao() {
  const linhas = await prisma.configuracao.findMany();
  const config = { ...CONFIG_PADRAO };
  for (const { chave, valor } of linhas) {
    if (chave in CONFIG_PADRAO) config[chave] = Number(valor);
  }
  return config;
}

export async function salvarConfiguracao(parcial) {
  for (const [chave, valor] of Object.entries(parcial)) {
    if (!(chave in CONFIG_PADRAO)) continue;
    await prisma.configuracao.upsert({
      where: { chave },
      create: { chave, valor: String(valor) },
      update: { valor: String(valor) },
    });
  }
  return lerConfiguracao();
}
