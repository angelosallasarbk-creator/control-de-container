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
  tabela: ["M3 5h18v14H3z", "M3 10h18", "M3 15h18", "M9 10v9"],
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
