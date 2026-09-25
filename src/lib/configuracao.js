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
  // Coleta programada que passou sem coleta registrada: ATENÇÃO logo que passa do horário,
  // CRÍTICO depois destas horas de atraso.
  atrasoColetaCriticoHoras: 4,
  // Aba Etapas: realizado até X minutos depois do planejado ainda conta como "no prazo" (verde).
  toleranciaPlanejadoMinutos: 60,
  // Endereço que vai dentro do QR das etiquetas (o celular abre este endereço). Vazio = usa o
  // endereço de onde a etiqueta foi gerada. Teste na rede local: http://IP-DO-COMPUTADOR:5174;
  // online: https://seu-sistema.onrender.com.
  urlPublica: "",
};

export async function lerConfiguracao() {
  const linhas = await prisma.configuracao.findMany();
  const config = { ...CONFIG_PADRAO };
  for (const { chave, valor } of linhas) {
    // Mantém o tipo do padrão: número vira número, texto continua texto.
    if (chave in CONFIG_PADRAO) config[chave] = typeof CONFIG_PADRAO[chave] === "number" ? Number(valor) : valor;
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
