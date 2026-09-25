<script setup>
// Lista da esquerda da visão "lista + detalhe": ativos por padrão, filtro de status e busca
// por container, navio ou rota. Clicar abre o container à direita (mesma URL /containers/:id).
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth.js";
import { api } from "../api.js";
import { FLUXO, ROTULO_STATUS, ROTULO_TIPO, rotuloEtapa } from "../formato.js";
import { filtroContainers, passaFiltroContainers } from "../filtroContainers.js";
import Icone from "./Icone.vue";

const props = defineProps({ selecionado: { type: [Number, String], default: null } });
const emit = defineEmits(["carregada", "filtrada", "novo"]);
const router = useRouter();
const auth = useAuthStore();
const refItens = ref(null);

const CHAVE_FILTRO = "cc_lista_lateral_status";
const lerFiltro = () => {
  try {
    return localStorage.getItem(CHAVE_FILTRO) || "ativos";
  } catch {
    return "ativos";
  }
};
const filtro = ref(lerFiltro());
const busca = ref("");
const lista = ref([]);
const carregando = ref(true);
const erro = ref(null);

// Valor do filtro → parâmetros da API (ativos, uma etapa, entregues/cancelados, todos).
function parametros(f) {
  if (f === "ativos") return { situacao: "ativos" };
  if (f === "todos") return { situacao: "todos" };
  if (f === "encerrados") return { situacao: "encerrados" };
  return { situacao: "todos", status: f };
}

async function carregar() {
  carregando.value = true;
  try {
    lista.value = await api.containers(parametros(filtro.value));
    erro.value = null;
    emit("carregada", visiveis.value);
    rolarAteSelecionado();
  } catch (e) {
    erro.value = e.message;
  } finally {
    carregando.value = false;
  }
}
onMounted(carregar);
watch(filtro, (f) => {
  try {
    localStorage.setItem(CHAVE_FILTRO, f);
  } catch {
    // sem armazenamento: só não lembra o filtro
  }
  carregar();
});
defineExpose({ carregar });

// Mantém o container aberto visível na lista (ex.: veio da tabela ou de um link).
async function rolarAteSelecionado() {
  await nextTick();
  refItens.value?.querySelector(".item.ativo")?.scrollIntoView({ block: "nearest" });
}
watch(() => props.selecionado, rolarAteSelecionado);

const rota = (c) => [c.portoRetirada?.nome, c.localCarregamento?.nome, c.portoEntrega?.nome].filter(Boolean).join(" → ");
// Mais crítico primeiro: vermelho, amarelo, verde; na mesma cor, mantém a ordem da API
// (mais recentes primeiro). O primeiro da lista é o que o Grid abre ao entrar na tela.
const CRITICIDADE = { VERMELHO: 0, AMARELO: 1, VERDE: 2 };
// Filtros do cabeçalho (Região / Ponto de Carregamento) + busca da própria lista.
const visiveis = computed(() => {
  const t = busca.value.trim().toLowerCase();
  return lista.value
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => passaFiltroContainers(c) && (!t || `${c.numero} ${c.navio ?? ""} ${c.booking ?? ""} ${rota(c)}`.toLowerCase().includes(t)))
    .sort((a, b) => (CRITICIDADE[a.c.semaforo] ?? 3) - (CRITICIDADE[b.c.semaforo] ?? 3) || a.i - b.i)
    .map(({ c }) => c);
});
// Mudou o filtro do cabeçalho: a ficha decide se troca o container aberto.
watch(() => [filtroContainers.regioes, filtroContainers.grupos], () => emit("filtrada", visiveis.value), { deep: true });
const filtrando = computed(() => filtroContainers.regioes.length || filtroContainers.grupos.length);
const abrir = (c) => router.push(`/containers/${c.id}`);
</script>

<template>
  <aside class="lista-lateral card">
    <div class="linha-entre">
      <h2>Containers</h2>
      <button v-if="auth.pode('containers.operar')" type="button" class="primario pequeno" @click="emit('novo')">+ Novo</button>
    </div>
    <label class="busca">
      <Icone nome="busca" :tamanho="16" />
      <input v-model="busca" placeholder="Buscar por container, navio ou rota…" aria-label="Buscar container" />
    </label>
    <select v-model="filtro" aria-label="Filtrar por status">
      <option value="ativos">Todos os status (ativos)</option>
      <option v-for="s in FLUXO.slice(0, -1)" :key="s" :value="s">{{ ROTULO_STATUS[s] }}</option>
      <option value="ENTREGUE_PORTO">{{ ROTULO_STATUS.ENTREGUE_PORTO }}</option>
      <option value="CANCELADO">{{ ROTULO_STATUS.CANCELADO }}</option>
      <option value="todos">Todos (inclusive encerrados)</option>
    </select>

    <div v-if="erro" class="erro pequeno">{{ erro }}</div>
    <div ref="refItens" class="itens">
      <template v-if="carregando && !lista.length">
        <div v-for="i in 4" :key="i" class="esqueleto"><span></span><span></span></div>
      </template>
      <button
        v-for="c in visiveis" :key="c.id" type="button" class="item" :class="{ ativo: String(c.id) === String(selecionado) }"
        :aria-current="String(c.id) === String(selecionado) ? 'page' : undefined" @click="abrir(c)"
      >
        <span class="linha-entre" style="gap: 8px">
          <span class="linha" style="gap: 8px; min-width: 0">
            <span class="ponto" :class="c.semaforo"></span>
            <span class="numero">{{ c.numero }}</span>
          </span>
          <span class="chip azul">{{ rotuloEtapa(c, c.status) }}</span>
        </span>
        <span class="mudo">{{ ROTULO_TIPO[c.tipo] }}</span>
        <span v-if="rota(c)" class="rota">{{ rota(c) }}</span>
      </button>
      <div v-if="!carregando && !visiveis.length" class="vazio pequeno">
        Nenhum container encontrado{{ filtrando ? " com os filtros de Região / Ponto de Carregamento" : "" }}.
      </div>
    </div>
  </aside>
</template>

<style scoped>
.lista-lateral { display: flex; flex-direction: column; gap: 10px; padding: 16px; position: sticky; top: 12px; max-height: calc(100vh - 110px); }
.lista-lateral h2 { margin: 0 0 4px; font-size: 20px; }
.busca { display: flex; align-items: center; gap: 8px; border: 1px solid var(--borda); border-radius: 8px; padding: 0 10px; background: var(--superficie); color: var(--texto-2); }
.busca input { border: none; padding: 9px 0; flex: 1; min-width: 0; background: transparent; outline: none; }
.lista-lateral select { align-self: flex-start; }
.itens { overflow-y: auto; display: flex; flex-direction: column; gap: 6px; margin: 4px -6px 0; padding: 0 6px; }
.item {
  display: flex; flex-direction: column; align-items: stretch; gap: 3px; text-align: left; white-space: normal;
  padding: 10px 12px; border: 1px solid transparent; border-left: 3px solid transparent; border-radius: 8px; background: transparent;
}
.item:hover:not(:disabled) { background: var(--superficie-2); }
.item.ativo { background: var(--azul-fundo); border-left-color: var(--primaria); }
.numero { font-weight: 700; font-size: 15px; letter-spacing: .01em; }
.rota { font-size: 12px; color: var(--texto); overflow: hidden; text-overflow: ellipsis; }
.esqueleto { display: flex; flex-direction: column; gap: 6px; padding: 12px; }
.esqueleto span { height: 10px; border-radius: 6px; background: var(--superficie-2); }
.esqueleto span:first-child { width: 60%; height: 14px; }
</style>
