<script setup>
// Ícones de traço simples (SVG inline, herdam a cor do texto via currentColor).
defineProps({
  nome: { type: String, required: true },
  tamanho: { type: [Number, String], default: 20 },
});
const CAMINHOS = {
  relogio: ["M12 7v5l3 2", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"],
  local: ["M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z", "M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"],
  calendario: ["M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z", "M4 10h16", "M8 3v4", "M16 3v4"],
  folga: ["M12 3a9 9 0 1 0 9 9", "M12 7v5h5", "M17 3v4h4"],
  armazem: ["M3 10l9-6 9 6v10H3z", "M8 20v-6h8v6", "M8 17h8"],
  navio: ["M4 15l1.5 4h13L20 15z", "M6 15V9h12v6", "M9 9V5h6v4", "M3 21c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1"],
  caminhao: ["M3 6h11v10H3z", "M14 10h4l3 3v3h-7", "M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z", "M17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"],
  termometro: ["M10 14.5V5a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0z", "M12 9v8"],
  alerta: ["M12 4l9 16H3z", "M12 10v4", "M12 17h.01"],
  mais: ["M12 6h.01", "M12 12h.01", "M12 18h.01"],
  busca: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-4-4"],
  voltar: ["M15 18l-6-6 6-6"],
  ok: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M8 12.5l2.8 2.8L16.5 9.5"],
  floco: ["M12 2v20", "M4.5 6.5l15 11", "M19.5 6.5l-15 11", "M9.5 3.5L12 6l2.5-2.5", "M9.5 20.5L12 18l2.5 2.5", "M3.5 10l3.2 1-1 3.2", "M20.5 10l-3.2 1 1 3.2"],
  exclamacao: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7.5v5.5", "M12 16.5h.01"],
  grid: ["M3 4h7v16H3z", "M13 4h8v7h-8z", "M13 14h8v6h-8z"],
  upload: ["M12 15V4", "M7.5 8.5L12 4l4.5 4.5", "M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"],
  download: ["M12 4v11", "M7.5 10.5L12 15l4.5-4.5", "M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"],
  tabela: ["M3 5h18v14H3z", "M3 10h18", "M3 15h18", "M9 10v9"],
  // Menu lateral
  casa: ["M3 11l9-7 9 7", "M5 9.5V20h14V9.5", "M10 20v-5.5h4V20"],
  container: ["M3 7h18v11H3z", "M8 7v11", "M12 7v11", "M16 7v11"],
  sino: ["M6 16v-5a6 6 0 1 1 12 0v5l2 2H4z", "M10 21h4"],
  qr: ["M4 4h6v6H4z", "M14 4h6v6h-6z", "M4 14h6v6H4z", "M14 14h2v2h-2z", "M18 14h2", "M14 19h2", "M18 18h2v2h-2z"],
  teclado: ["M3 7h18v10H3z", "M7 10.5h.01", "M11 10.5h.01", "M15 10.5h.01", "M8 14h8"],
  moeda: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M14.5 9.5c-.4-1-1.4-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.2 0-2.2-.6-2.6-1.6", "M12 6.5V8", "M12 16v1.5"],
  mapa: ["M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z", "M9 4v14", "M15 6v14"],
  fabrica: ["M3 20v-9l5 3v-3l5 3V5h4v15", "M3 20h18", "M7 17h2", "M12 17h2"],
  fluxo: ["M4 4h5v5H4z", "M15 15h5v5h-5z", "M6.5 9v3a3 3 0 0 0 3 3H15", "M13 13l2 2-2 2"],
  caixa: ["M3 7.5l9-4 9 4v9l-9 4-9-4z", "M3 7.5l9 4 9-4", "M12 11.5v9"],
  pessoa: ["M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 21a8 8 0 0 1 16 0"],
  usuarios: ["M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M2 21a7 7 0 0 1 14 0", "M16 3.5a4 4 0 0 1 0 7.5", "M18 14.5a7 7 0 0 1 4 6.5"],
  plugue: ["M9 3v5", "M15 3v5", "M6 8h12v3a6 6 0 0 1-12 0z", "M12 17v4"],
  ajustes: ["M4 6h9", "M17 6h3", "M15 4v4", "M4 12h3", "M11 12h9", "M9 10v4", "M4 18h11", "M19 18h1", "M17 16v4"],
  sair: ["M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4", "M16 17l5-5-5-5", "M21 12H9"],
};
</script>

<template>
  <svg
    :width="tamanho" :height="tamanho" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icone"
  >
    <path v-for="(d, i) in CAMINHOS[nome] ?? []" :key="i" :d="d" />
  </svg>
</template>

<style scoped>
.icone { flex-shrink: 0; }
</style>
