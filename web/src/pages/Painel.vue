<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api.js";
import { fmtMoeda, fmtDataHora } from "../formato.js";
import TileContainer from "../components/TileContainer.vue";

const dados = ref(null);
const erro = ref(null);
const filtroGrupo = ref("");
const soProblemas = ref(false);
const ATUALIZAR_MS = 60000;
let timer = null;

// Fases do pátio: onde o container está fisicamente.
const FASES = [
  { chave: "chegando", titulo: "A caminho da fábrica", status: ["PROGRAMADO", "COLETADO"] },
  { chave: "fabrica", titulo: "Na fábrica", status: ["NA_FABRICA", "EM_OPERACAO", "LIBERADO"] },
  { chave: "porto", titulo: "A caminho do porto", status: ["SAIU_FABRICA"] },
];

async function carregar() {
  try {
    dados.value = await api.painel();
    erro.value = null;
  } catch (e) {
    erro.value = e.message;
  }
}

onMounted(() => {
  carregar();
  timer = setInterval(carregar, ATUALIZAR_MS);
});
onBeforeUnmount(() => clearInterval(timer));

const moedas = (obj) => Object.entries(obj ?? {}).map(([m, v]) => fmtMoeda(v, m)).join(" + ") || fmtMoeda(0, "USD");
const naFabrica = computed(() => ["NA_FABRICA", "EM_OPERACAO", "LIBERADO"].reduce((s, st) => s + (dados.value?.totais.porStatus[st] ?? 0), 0));

const grupos = computed(() => {
  if (!dados.value) return [];
  return dados.value.grupos
    .filter((g) => !filtroGrupo.value || String(g.id) === filtroGrupo.value)
    .map((g) => {
      const visiveis = g.containers.filter((c) => !soProblemas.value || c.semaforo !== "VERDE");
      return {
        ...g,
        fases: FASES.map((f) => ({ ...f, containers: visiveis.filter((c) => f.status.includes(c.status)) })).filter((f) => f.containers.length),
      };
    })
    .filter((g) => !soProblemas.value || g.fases.length);
});
</script>

<template>
  <div v-if="erro" class="erro">{{ erro }}</div>
  <div v-if="!dados && !erro" class="vazio">Carregando pátio…</div>
  <template v-if="dados">
    <div class="kpis">
      <div class="kpi"><div class="rotulo">Containers ativos</div><div class="valor">{{ dados.totais.ativos }}</div></div>
      <div class="kpi"><div class="rotulo">Na fábrica agora</div><div class="valor">{{ naFabrica }}</div></div>
      <div class="kpi vermelho"><div class="rotulo">Em situação crítica</div><div class="valor">{{ dados.totais.semaforo.VERMELHO }}</div></div>
      <div class="kpi amarelo"><div class="rotulo">Em atenção</div><div class="valor">{{ dados.totais.semaforo.AMARELO }}</div></div>
      <div class="kpi" :class="{ vermelho: Object.keys(dados.totais.custoDemurrage).length }">
        <div class="rotulo">Demurrage acumulada (ativos)</div>
        <div class="valor" style="font-size: 18px">{{ moedas(dados.totais.custoDemurrage) }}</div>
      </div>
      <div v-if="dados.totais.custoEstadia" class="kpi vermelho">
        <div class="rotulo">Estadia excedida (custo)</div>
        <div class="valor" style="font-size: 18px">{{ fmtMoeda(dados.totais.custoEstadia) }}</div>
      </div>
    </div>

    <div class="linha-entre">
      <div class="filtros">
        <div class="campo">
          <label>Cliente / Fábrica</label>
          <select v-model="filtroGrupo">
            <option value="">Todos</option>
            <option v-for="g in dados.grupos" :key="g.id" :value="String(g.id)">{{ g.cliente }} / {{ g.fabrica }}</option>
          </select>
        </div>
        <label class="linha pequeno" style="gap: 6px; padding-bottom: 8px"><input v-model="soProblemas" type="checkbox" /> Só atenção/crítico</label>
      </div>
      <span class="mudo pequeno">Atualizado {{ fmtDataHora(dados.geradoEm) }} · atualiza sozinho a cada minuto</span>
    </div>

    <div v-if="!grupos.length" class="card vazio">
      Nenhum container ativo{{ soProblemas ? " com problema" : "" }}.
      <router-link v-if="!soProblemas" to="/containers">Cadastrar container</router-link>
    </div>

    <section v-for="g in grupos" :key="g.id" class="card">
      <div class="grupo-cabecalho">
        <div>
          <div class="grupo-titulo">{{ g.cliente }} / {{ g.fabrica }}</div>
          <div class="mudo pequeno">Meta de estadia: {{ g.metaEstadiaHoras }}h · {{ g.containers.length }} container(s) ativo(s)</div>
        </div>
        <div class="contadores">
          <span class="chip verde"><span class="ponto VERDE"></span>{{ g.semaforo.VERDE }}</span>
          <span class="chip amarelo"><span class="ponto AMARELO"></span>{{ g.semaforo.AMARELO }}</span>
          <span class="chip vermelho"><span class="ponto VERMELHO"></span>{{ g.semaforo.VERMELHO }}</span>
          <span v-if="Object.keys(g.custoDemurrage).length" class="chip vermelho">Demurrage {{ moedas(g.custoDemurrage) }}</span>
        </div>
      </div>
      <div v-if="!g.fases.length" class="mudo pequeno">Sem containers ativos neste grupo.</div>
      <div v-for="f in g.fases" :key="f.chave" style="margin-top: 10px">
        <h3>{{ f.titulo }} <span class="mudo">({{ f.containers.length }})</span></h3>
        <div class="tiles">
          <TileContainer v-for="c in f.containers" :key="c.id" :c="c" />
        </div>
      </div>
    </section>
  </template>
</template>
