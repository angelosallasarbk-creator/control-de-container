<script setup>
// Filtros do cabeçalho da tela de Containers: Região e Ponto de Carregamento (múltipla escolha).
// Pontos de carregamento seguem as regiões marcadas; marcar outra região limpa pontos que saíram.
import { computed, onMounted, ref, watch } from "vue";
import { api } from "../api.js";
import { filtroContainers, chaveRegiao } from "../filtroContainers.js";
import FiltroMultiplo from "./FiltroMultiplo.vue";

const regioes = ref([]);
const grupos = ref([]);
onMounted(async () => {
  [regioes.value, grupos.value] = await Promise.all([api.listar("regioes").catch(() => []), api.listar("grupos").catch(() => [])]);
});

const opcoesRegiao = computed(() => {
  const lista = regioes.value.map((r) => ({ valor: r.id, texto: r.nome, detalhe: r.ativo ? "" : "inativa" }));
  if (grupos.value.some((g) => !g.regiaoId)) lista.push({ valor: "sem", texto: "Sem região" });
  return lista;
});
const opcoesGrupo = computed(() =>
  grupos.value
    .filter((g) => !filtroContainers.regioes.length || filtroContainers.regioes.includes(chaveRegiao(g.regiaoId)))
    .map((g) => ({ valor: g.id, texto: `${g.cliente} / ${g.fabrica}`, detalhe: g.regiao?.nome ?? "sem região" }))
);
// Ponto de carregamento marcado que não pertence mais às regiões escolhidas sai do filtro.
watch(opcoesGrupo, (opcoes) => {
  const validos = new Set(opcoes.map((o) => o.valor));
  const filtrados = filtroContainers.grupos.filter((g) => validos.has(g));
  if (grupos.value.length && filtrados.length !== filtroContainers.grupos.length) filtroContainers.grupos = filtrados;
});
</script>

<template>
  <div class="filtros-containers">
    <FiltroMultiplo v-model="filtroContainers.regioes" rotulo="Região" todos="Todas" :opcoes="opcoesRegiao" />
    <FiltroMultiplo v-model="filtroContainers.grupos" rotulo="Ponto de Carregamento" :opcoes="opcoesGrupo" busca />
  </div>
</template>

<style scoped>
.filtros-containers { display: flex; gap: 8px; margin-left: 14px; flex-wrap: wrap; }
</style>
