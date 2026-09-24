<script setup>
import { computed } from "vue";
import { Bar } from "vue-chartjs";
import { fmtMoeda } from "../formato.js";

// Barras (empilhadas ou não, verticais ou horizontais) em UMA moeda — nunca dois eixos.
// series: [{ nome, cor, valores: number[] }]
const props = defineProps({
  rotulos: { type: Array, required: true },
  series: { type: Array, required: true },
  moeda: { type: String, default: "BRL" },
  empilhado: { type: Boolean, default: true },
  horizontal: { type: Boolean, default: false },
  altura: { type: Number, default: 260 },
});

const SUPERFICIE = "#ffffff"; // fundo do .card: separa segmentos empilhados (2px)
const TINTA_MUDA = "#898781";
const GRADE = "#e1e0d9";

const data = computed(() => ({
  labels: props.rotulos,
  datasets: props.series.map((s) => ({
    label: s.nome,
    data: s.valores,
    backgroundColor: s.cor,
    borderColor: SUPERFICIE,
    borderWidth: 2,
    borderRadius: 4,
    borderSkipped: false,
    maxBarThickness: 36,
  })),
}));

const eixoValor = computed(() => ({
  stacked: props.empilhado,
  beginAtZero: true,
  grid: { color: GRADE },
  border: { display: false },
  ticks: { color: TINTA_MUDA, callback: (v) => fmtMoeda(v, props.moeda).replace(/,00$/, "") },
}));
const eixoCategoria = computed(() => ({
  stacked: props.empilhado,
  grid: { display: false },
  border: { color: "#c3c2b7" },
  ticks: { color: TINTA_MUDA, autoSkip: true, maxRotation: 0 },
}));

const options = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  indexAxis: props.horizontal ? "y" : "x",
  interaction: { mode: "index", intersect: false },
  scales: props.horizontal ? { x: eixoValor.value, y: eixoCategoria.value } : { x: eixoCategoria.value, y: eixoValor.value },
  plugins: {
    legend: { display: props.series.length > 1, position: "top", align: "start", labels: { boxWidth: 12, boxHeight: 12, color: "#52514e" } },
    tooltip: {
      callbacks: {
        label: (i) => ` ${i.dataset.label}: ${fmtMoeda(i.raw, props.moeda)}`,
        footer: (itens) => (itens.length > 1 ? `Total: ${fmtMoeda(itens.reduce((s, i) => s + i.raw, 0), props.moeda)}` : ""),
      },
    },
  },
}));
</script>

<template>
  <div :style="{ height: `${altura}px` }"><Bar :data="data" :options="options" /></div>
</template>
