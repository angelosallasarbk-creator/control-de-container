<script setup>
// Lista da esquerda da visão "lista + detalhe": ativos por padrão, filtro de status e busca
// por container, navio ou rota. Clicar abre o container à direita (mesma URL /containers/:id).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth.js";
import { api } from "../api.js";
import { FLUXO, ROTULO_STATUS, ROTULO_TIPO, rotuloEtapa } from "../formato.js";
import { filtroContainers } from "../filtroContainers.js";
import Icone from "./Icone.vue";
import MarcaQr from "./MarcaQr.vue";
import Paginacao from "./Paginacao.vue";
import { usePaginacaoServidor } from "../composables/usePaginacaoServidor.js";

const props = defineProps({ selecionado: { type: [Number, String], default: null } });
const emit = defineEmits(["carregada", "filtrada", "novo", "upload"]);
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

// Lista paginada no servidor (v3.10): busca, status, filtros do cabeçalho e página rodam no banco; só a
// página chega ao navegador. Ordem: crítico primeiro, mais recente primeiro (a ordem do servidor).
// `localizar` faz o servidor devolver a página onde está o container aberto (link, tabela, filtro).
let sequencia = 0;
async function carregar({ localizar = false } = {}) {
  const minha = ++sequencia; // descarta resposta de consulta mais antiga (digitação rápida, cliques seguidos)
  carregando.value = true;
  try {
    const r = await api.listaContainers({
      ...parametros(filtro.value), busca: busca.value.trim(),
      regioes: filtroContainers.regioes.join(","), grupos: filtroContainers.grupos.join(","), semQr: filtroContainers.semQr ? "1" : "",
      ordem: "semaforo", dir: "asc", pagina: pag.pagina.value, limite: pag.porPagina.value,
      localizar: localizar && props.selecionado ? String(props.selecionado) : "",
    });
    if (minha !== sequencia) return null;
    lista.value = r.itens;
    pag.aplicar(r);
    erro.value = null;
    rolarAteSelecionado();
    return r.itens;
  } catch (e) {
    if (minha === sequencia) erro.value = e.message;
    return null;
  } finally {
    if (minha === sequencia) carregando.value = false;
  }
}
// Filtro, busca ou status mudou: primeira página (ou a do container aberto, se ele continua na lista).
async function refazer() {
  pag.voltarAoInicio();
  return carregar({ localizar: true });
}
const pag = usePaginacaoServidor("lista-lateral", () => carregar());

onMounted(async () => {
  const itens = await refazer();
  if (itens) emit("carregada", itens);
});
watch(filtro, (f) => {
  try {
    localStorage.setItem(CHAVE_FILTRO, f);
  } catch {
    // sem armazenamento: só não lembra o filtro
  }
  refazer();
});
let atraso = null;
watch(busca, () => {
  clearTimeout(atraso);
  atraso = setTimeout(refazer, 350);
});
onBeforeUnmount(() => clearTimeout(atraso));
// Mudou o filtro do cabeçalho: a ficha decide se troca o container aberto.
watch(() => [filtroContainers.regioes, filtroContainers.grupos, filtroContainers.semQr], async () => {
  const itens = await refazer();
  if (itens) emit("filtrada", itens);
}, { deep: true });
// Depois de uma ação na ficha (avançar etapa etc.): recarrega a página atual sem pular de página.
defineExpose({ carregar: () => carregar() });

// Mantém o container aberto visível na lista (ex.: veio da tabela ou de um link).
async function rolarAteSelecionado() {
  await nextTick();
  refItens.value?.querySelector(".item.ativo")?.scrollIntoView({ block: "nearest" });
}
// Container aberto que não está na página atual (link, tabela): o servidor acha a página dele.
watch(() => props.selecionado, (id) => {
  if (id && !lista.value.some((c) => String(c.id) === String(id))) carregar({ localizar: true });
  else rolarAteSelecionado();
});

const rota = (c) => [c.portoRetirada?.nome, c.localCarregamento?.nome, c.portoEntrega?.nome].filter(Boolean).join(" → ");
const filtrando = computed(() => filtroContainers.regioes.length || filtroContainers.grupos.length || filtroContainers.semQr);
const abrir = (c) => router.push(`/containers/${c.id}`);
</script>

<template>
  <aside class="lista-lateral card">
    <div class="linha-entre">
      <h2>Containers</h2>
      <span v-if="auth.pode('containers.operar')" class="linha" style="gap: 6px">
        <button type="button" class="pequeno" title="Cadastrar vários containers por planilha" @click="emit('upload')"><Icone nome="upload" :tamanho="15" /> Upload</button>
        <button type="button" class="primario pequeno" @click="emit('novo')">+ Novo</button>
      </span>
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
        v-for="c in lista" :key="c.id" type="button" class="item" :class="{ ativo: String(c.id) === String(selecionado) }"
        :aria-current="String(c.id) === String(selecionado) ? 'page' : undefined" @click="abrir(c)"
      >
        <span class="linha-entre" style="gap: 8px">
          <span class="linha" style="gap: 8px; min-width: 0">
            <span class="ponto" :class="c.semaforo"></span>
            <span class="numero"><MarcaQr v-if="c.qrVinculado" /> {{ c.numero }}</span>
          </span>
          <span class="chip azul">{{ rotuloEtapa(c, c.status) }}</span>
        </span>
        <span class="mudo">{{ ROTULO_TIPO[c.tipo] }}</span>
        <span v-if="rota(c)" class="rota">{{ rota(c) }}</span>
      </button>
      <div v-if="!carregando && !lista.length" class="vazio pequeno">
        Nenhum container encontrado{{ filtrando ? " com os filtros do cabeçalho" : "" }}.
      </div>
    </div>
    <Paginacao :p="pag" compacto />
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
