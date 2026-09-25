<script setup>
// /containers: abre no modelo escolhido no seletor Grid / Tabela do cabeçalho (padrão: Grid).
import { visaoContainers } from "../visaoContainers.js";
import Containers from "./Containers.vue";
import FichaContainer from "./FichaContainer.vue";
</script>

<template>
  <Containers v-if="visaoContainers === 'tabela'" />
  <FichaContainer v-else />
</template>
