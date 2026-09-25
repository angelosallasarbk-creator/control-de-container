<script setup>
import { computed, ref, watchEffect } from "vue";
import QRCode from "qrcode";

// Etiqueta no tamanho real (mm) — usada na pré-visualização e na folha de impressão.
// Mesmo layout do ZPL (src/lib/etiquetas.js): horizontal em etiqueta larga, vertical na quadrada/alta.
const props = defineProps({
  codigo: { type: String, required: true },
  url: { type: String, required: true },
  larguraMm: { type: Number, required: true },
  alturaMm: { type: Number, required: true },
  titulo: { type: String, default: "Controle de Container" },
});

const horizontal = computed(() => props.larguraMm >= props.alturaMm * 1.3);
const margem = 2; // mm
const ladoQrMm = computed(() =>
  horizontal.value
    ? Math.min(props.alturaMm - 2 * margem, props.larguraMm * 0.5)
    : Math.min(props.larguraMm - 2 * margem, props.alturaMm * 0.62)
);
// Etiqueta grande: correção de erro alta (aguenta ~30% sujo/riscado); pequena: M, módulos maiores.
const nivel = computed(() => (ladoQrMm.value >= 30 ? "H" : "M"));
const tamanhoCodigoMm = computed(() =>
  horizontal.value
    ? Math.min(props.alturaMm * 0.2, (props.larguraMm - ladoQrMm.value - 3 * margem) / 6.8)
    : Math.min((props.alturaMm - ladoQrMm.value - 2 * margem) * 0.4, props.larguraMm / 8)
);

const svg = ref("");
watchEffect(async () => {
  svg.value = await QRCode.toString(props.url, { type: "svg", errorCorrectionLevel: nivel.value, margin: 0 });
});
</script>

<template>
  <div
    class="etiqueta" :class="horizontal ? 'horizontal' : 'vertical'"
    :style="{ width: `${larguraMm}mm`, height: `${alturaMm}mm`, padding: `${margem}mm`, gap: `${margem}mm` }"
  >
    <!-- SVG gerado pela biblioteca qrcode a partir da URL da etiqueta (não é conteúdo do usuário). -->
    <div class="qr" :style="{ width: `${ladoQrMm}mm`, height: `${ladoQrMm}mm` }" v-html="svg"></div>
    <div class="textos">
      <div class="codigo" :style="{ fontSize: `${tamanhoCodigoMm}mm` }">{{ codigo }}</div>
      <div class="instrucao" :style="{ fontSize: `${Math.max(1.8, tamanhoCodigoMm * 0.45)}mm` }">Escaneie para registrar</div>
      <div class="instrucao" :style="{ fontSize: `${Math.max(1.8, tamanhoCodigoMm * 0.45)}mm` }">{{ titulo }}</div>
    </div>
  </div>
</template>

<style scoped>
.etiqueta { box-sizing: border-box; background: #fff; color: #000; display: flex; overflow: hidden; font-family: "Inter Variable", "Segoe UI", Arial, sans-serif; }
.etiqueta.horizontal { flex-direction: row; align-items: center; }
.etiqueta.vertical { flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.qr { flex-shrink: 0; }
.qr :deep(svg) { width: 100%; height: 100%; display: block; }
.textos { min-width: 0; display: flex; flex-direction: column; gap: 0.6mm; }
.codigo { font-weight: 800; letter-spacing: 0.02em; line-height: 1.05; white-space: nowrap; }
.instrucao { font-weight: 600; line-height: 1.15; }
</style>
