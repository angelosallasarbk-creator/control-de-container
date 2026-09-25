<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "../api.js";
import EtiquetaVisual from "../components/EtiquetaVisual.vue";

// Folha de impressão: cada etiqueta vira uma "página" do tamanho exato da etiqueta (@page),
// que é o que o driver da Zebra espera. Abre em nova aba e chama a impressão sozinha.
const route = useRoute();
const larguraMm = Number(route.query.w) || 50;
const alturaMm = Number(route.query.h) || 30;
// Endereço dentro do QR: sempre o de Configurações → Etiquetas QR (lido do servidor).
const base = ref("");
const etiquetas = ref([]);
const erro = ref(null);
const aviso = ref(null);
const pronto = ref(false);

// Ao fechar a janela de impressão, registra que estas etiquetas foram impressas (para avisar
// antes de uma reimpressão). O navegador não diz se a pessoa cancelou — conta como enviada.
let registrado = false;
async function aposImprimir() {
  if (registrado || !etiquetas.value.length) return;
  registrado = true;
  try {
    await api.marcarImpressas(etiquetas.value.map((e) => e.id));
  } catch (e) {
    erro.value = `Não foi possível registrar a impressão: ${e.message}`;
  }
}

const estiloPagina = document.createElement("style");
estiloPagina.textContent = `@page { size: ${larguraMm}mm ${alturaMm}mm; margin: 0; } @media print { html, body { margin: 0; padding: 0; background: #fff; } }`;

onMounted(async () => {
  document.head.appendChild(estiloPagina);
  window.addEventListener("afterprint", aposImprimir);
  try {
    const ids = String(route.query.ids || "");
    if (!ids) throw new Error("Nenhuma etiqueta selecionada.");
    const { urlPublica } = await api.configImpressao();
    if (!urlPublica) throw new Error("O endereço do sistema para o QR não está configurado. Um administrador deve preenchê-lo em Configurações → Etiquetas QR.");
    base.value = urlPublica.replace(/\/+$/, "");
    const pedidas = ids.split(",").length;
    // O servidor só devolve etiquetas do próprio usuário (e não canceladas ficam de fora aqui).
    etiquetas.value = (await api.etiquetas({ ids })).filter((e) => e.estado !== "CANCELADA");
    if (etiquetas.value.length < pedidas) {
      aviso.value = `${pedidas - etiquetas.value.length} etiqueta(s) ficaram de fora: são de outro usuário ou estão canceladas.`;
    }
    if (!etiquetas.value.length) throw new Error("Nenhuma etiqueta para imprimir.");
    await nextTick();
    // Espera os QR (SVG) serem gerados antes de abrir a janela de impressão.
    setTimeout(() => {
      pronto.value = true;
      window.print();
    }, 600);
  } catch (e) {
    erro.value = e.message;
  }
});
onBeforeUnmount(() => {
  estiloPagina.remove();
  window.removeEventListener("afterprint", aposImprimir);
});

const imprimir = () => window.print();
const resumo = computed(() => `${etiquetas.value.length} etiqueta(s) · ${larguraMm} × ${alturaMm} mm`);
</script>

<template>
  <div class="barra-impressao">
    <strong>Imprimir etiquetas</strong> — {{ resumo }}
    <button class="primario pequeno" :disabled="!etiquetas.length" @click="imprimir">🖨 Imprimir</button>
    <div class="pequeno mudo" style="margin-top: 6px">
      Na janela de impressão: escolha a impressora <strong>Zebra</strong>, tamanho do papel <strong>{{ larguraMm }} × {{ alturaMm }} mm</strong>
      (ou o da etiqueta instalada), margens <strong>Nenhuma</strong> e escala <strong>100%</strong>. Desmarque "Cabeçalhos e rodapés".
    </div>
    <div v-if="aviso" class="aviso" style="margin-top: 8px">{{ aviso }}</div>
    <div v-if="erro" class="erro" style="margin-top: 8px">{{ erro }}</div>
  </div>
  <div class="folha">
    <div v-for="e in etiquetas" :key="e.id" class="folha-etiqueta">
      <EtiquetaVisual :codigo="e.codigo" :url="`${base}/q/${e.token}`" :largura-mm="larguraMm" :altura-mm="alturaMm" />
    </div>
  </div>
</template>

<style scoped>
.barra-impressao { padding: 14px 20px; background: var(--superficie); border-bottom: 1px solid var(--borda); }
.barra-impressao button { margin-left: 12px; }
.folha { padding: 20px; display: flex; flex-wrap: wrap; gap: 12px; background: var(--fundo); }
.folha-etiqueta { box-shadow: var(--sombra); }
@media print {
  .barra-impressao { display: none; }
  .folha { padding: 0; gap: 0; display: block; background: #fff; }
  .folha-etiqueta { box-shadow: none; break-after: page; page-break-after: always; }
  .folha-etiqueta:last-child { break-after: auto; page-break-after: auto; }
}
</style>
