<script setup>
// Cabeçalho de coluna clicável. `ordem` = retorno de useOrdenacao().
const props = defineProps({
  chave: { type: String, required: true },
  ordem: { type: Object, required: true },
  titulo: { type: String, default: undefined },
});
</script>

<template>
  <th :aria-sort="ordem.ariaSort(chave)" :title="titulo">
    <button type="button" class="th-ordenar" :class="{ ativo: ordem.coluna.value === chave }" @click="ordem.alternar(chave)">
      <slot />
      <span class="seta" aria-hidden="true">
        {{ ordem.coluna.value !== chave ? "↕" : ordem.direcao.value === "asc" ? "▲" : "▼" }}
      </span>
    </button>
  </th>
</template>
