<script setup>
// Rodapé de paginação: "1–20 de 137", seletor 10/20/50 por página e navegação.
// p = retorno de usePaginacao (reativo). Some quando a lista cabe numa página só do menor tamanho.
import { computed } from "vue";
import { TAMANHOS_PAGINA } from "../composables/usePaginacao.js";

const props = defineProps({ p: { type: Object, required: true }, compacto: { type: Boolean, default: false } });
// Números visíveis: primeira, última e vizinhas da atual, com "…" nos saltos.
const paginas = computed(() => {
  const n = props.p.totalPaginas.value;
  const atual = props.p.pagina.value;
  const lista = [];
  for (let i = 1; i <= n; i++) {
    if (i === 1 || i === n || Math.abs(i - atual) <= 1) lista.push(i);
    else if (lista.at(-1) !== "…") lista.push("…");
  }
  return lista;
});
const visivel = computed(() => props.p.total.value > TAMANHOS_PAGINA[0]);
</script>

<template>
  <nav v-if="visivel" class="paginacao" :class="{ compacto }" aria-label="Paginação">
    <span class="mudo pequeno">{{ p.primeiro.value }}–{{ p.ultimo.value }} de {{ p.total.value }}</span>
    <label class="por-pagina pequeno">
      <span v-if="!compacto">Por página</span>
      <select v-model.number="p.porPagina.value" aria-label="Itens por página">
        <option v-for="t in TAMANHOS_PAGINA" :key="t" :value="t">{{ t }}</option>
      </select>
    </label>
    <div class="botoes">
      <button type="button" class="pequeno" :disabled="p.pagina.value <= 1" aria-label="Página anterior" @click="p.irPara(p.pagina.value - 1)">‹</button>
      <template v-if="!compacto">
        <template v-for="(n, i) in paginas" :key="i">
          <span v-if="n === '…'" class="mudo reticencias">…</span>
          <button
            v-else type="button" class="pequeno" :class="{ atual: n === p.pagina.value }" :aria-current="n === p.pagina.value ? 'page' : undefined"
            @click="p.irPara(n)"
          >{{ n }}</button>
        </template>
      </template>
      <span v-else class="pequeno">{{ p.pagina.value }}/{{ p.totalPaginas.value }}</span>
      <button type="button" class="pequeno" :disabled="p.pagina.value >= p.totalPaginas.value" aria-label="Próxima página" @click="p.irPara(p.pagina.value + 1)">›</button>
    </div>
  </nav>
</template>

<style scoped>
.paginacao { display: flex; align-items: center; justify-content: flex-end; gap: 12px; flex-wrap: wrap; padding: 10px 12px; }
.paginacao.compacto { justify-content: space-between; gap: 6px; padding: 8px; }
.por-pagina { display: flex; align-items: center; gap: 6px; }
.por-pagina select { width: auto; padding: 4px 8px; }
.botoes { display: flex; gap: 4px; align-items: center; }
.botoes button { min-width: 32px; justify-content: center; }
.botoes button.atual { background: var(--primaria); color: #fff; border-color: var(--primaria); }
.reticencias { padding: 0 4px; }
</style>
