<script setup>
import { computed } from "vue";
import { Line } from "vue-chartjs";
import { fmtDataHora } from "../formato.js";

const props = defineProps({
  leituras: { type: Array, required: true },
  tempMin: { type: Number, required: true },
  tempMax: { type: Number, required: true },
  setpoint: { type: Number, default: null },
});

const data = computed(() => ({
  datasets: [
    {
      label: "Temperatura (°C)",
      data: props.leituras.map((l) => ({ x: new Date(l.lidaEm).getTime(), y: l.temperatura })),
      borderColor: "#1f5fa8",
      backgroundColor: "#1f5fa8",
      pointRadius: 3,
      pointBackgroundColor: props.leituras.map((l) => (l.temperatura < props.tempMin || l.temperatura > props.tempMax ? "#c53030" : "#1f5fa8")),
      tension: 0.2,
    },
  ],
}));

const options = computed(() => {
  const valores = props.leituras.map((l) => l.temperatura);
  const min = Math.min(props.tempMin, ...valores) - 2;
  const max = Math.max(props.tempMax, ...valores) + 2;
  // Com poucas leituras o Chart.js estica o eixo por anos; garante uma janela mínima de 2h.
  const tempos = props.leituras.map((l) => new Date(l.lidaEm).getTime());
  const JANELA_MIN_MS = 2 * 60 * 60 * 1000;
  let xMin = Math.min(...tempos);
  let xMax = Math.max(...tempos);
  if (xMax - xMin < JANELA_MIN_MS) {
    const meio = (xMin + xMax) / 2;
    xMin = meio - JANELA_MIN_MS / 2;
    xMax = meio + JANELA_MIN_MS / 2;
  }
  const annotations = {
    faixa: { type: "box", yMin: props.tempMin, yMax: props.tempMax, backgroundColor: "rgba(30,142,78,0.08)", borderWidth: 0 },
    minimo: { type: "line", yMin: props.tempMin, yMax: props.tempMin, borderColor: "#c53030", borderWidth: 1, borderDash: [5, 4] },
    maximo: { type: "line", yMin: props.tempMax, yMax: props.tempMax, borderColor: "#c53030", borderWidth: 1, borderDash: [5, 4] },
  };
  if (props.setpoint !== null) {
    annotations.setpoint = { type: "line", yMin: props.setpoint, yMax: props.setpoint, borderColor: "#1e8e4e", borderWidth: 1 };
  }
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      x: { type: "linear", min: xMin, max: xMax, ticks: { callback: (v) => fmtDataHora(v), maxTicksLimit: 6 } },
      y: { min: Math.floor(min), max: Math.ceil(max), title: { display: true, text: "°C" } },
    },
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { title: (items) => fmtDataHora(items[0].parsed.x), label: (i) => `${i.parsed.y.toFixed(1)} °C` } },
      annotation: { annotations },
    },
  };
});
</script>

<template>
  <div style="height: 240px"><Line :data="data" :options="options" /></div>
</template>
