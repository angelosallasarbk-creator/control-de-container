import { prisma } from "./prisma.js";

// Parâmetros globais editáveis na tela de Configurações.
export const CONFIG_PADRAO = {
  // Na leitura manual, o operador registra a temperatura a cada X minutos; passando disso, alerta.
  intervaloLeituraMinutos: 240,
  // Cotação manual para consolidar o Custo estimado em R$ (0 = não informada: a tela mostra
  // cada moeda separada, sem somar moedas diferentes).
  cotacaoUSD: 0,
  cotacaoEUR: 0,
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
