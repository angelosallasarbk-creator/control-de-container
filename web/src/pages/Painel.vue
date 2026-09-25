<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api.js";
import { fmtMoeda, fmtDataHora } from "../formato.js";
import TileContainer from "../components/TileContainer.vue";

const route = useRoute();
const router = useRouter();
const dados = ref(null);
const erro = ref(null);
const filtroGrupo = ref("");
const soProblemas = ref(false);
const ATUALIZAR_MS = 60000;
const CHAVE_ABA = "cc_painel_aba";
let timer = null;

// Fases do pátio: onde o container está fisicamente.
const FASES = [
  { chave: "chegando", titulo: "A caminho da fábrica", status: ["PROGRAMADO", "COLETADO"] },
  { chave: "fabrica", titulo: "Na fábrica", status: ["NA_FABRICA", "EM_OPERACAO", "LIBERADO"] },
  { chave: "porto", titulo: "A caminho do porto", status: ["SAIU_FABRICA"] },
];
const STATUS_NA_FABRICA = FASES[1].status;

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

// ---------- Abas por região ----------
// "todas" + uma aba por região + "sem" (fábricas ainda sem região, para nada sumir do pátio).
const chaveRegiao = (g) => (g.regiao ? String(g.regiao.id) : "sem");

const abas = computed(() => {
  if (!dados.value) return [];
  const regioes = new Map(dados.value.regioes.map((r) => [String(r.id), r.nome]));
  // Região inativa que ainda tem fábrica vinculada também aparece.
  for (const g of dados.value.grupos) if (g.regiao) regioes.set(String(g.regiao.id), g.regiao.nome);
  const lista = [...regioes].map(([chave, nome]) => ({ chave, nome })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  if (dados.value.grupos.some((g) => !g.regiao)) lista.push({ chave: "sem", nome: "Sem região" });
  const resumo = (chave) => {
    const grupos = dados.value.grupos.filter((g) => chave === "todas" || chaveRegiao(g) === chave);
    return {
      ativos: grupos.reduce((s, g) => s + g.containers.length, 0),
      vermelhos: grupos.reduce((s, g) => s + g.semaforo.VERMELHO, 0),
      amarelos: grupos.reduce((s, g) => s + g.semaforo.AMARELO, 0),
    };
  };
  return [{ chave: "todas", nome: "Todas" }, ...lista].map((a) => ({ ...a, ...resumo(a.chave) }));
});

function lerAbaSalva() {
  try {
    return localStorage.getItem(CHAVE_ABA);
  } catch {
    return null;
  }
}
const abaAtual = computed(() => {
  const pedida = route.query.regiao ?? lerAbaSalva() ?? "todas";
  return abas.value.some((a) => a.chave === pedida) ? pedida : "todas";
});
function selecionarAba(chave) {
  filtroGrupo.value = "";
  try {
    localStorage.setItem(CHAVE_ABA, chave);
  } catch {
    // sem armazenamento local: a aba só não fica lembrada
  }
  router.replace({ query: { ...route.query, regiao: chave } });
}
watch(abaAtual, () => (filtroGrupo.value = ""));

const gruposDaAba = computed(() =>
  (dados.value?.grupos ?? []).filter((g) => abaAtual.value === "todas" || chaveRegiao(g) === abaAtual.value)
);

// ---------- Indicadores da aba ----------
const somarMoedas = (lista) => {
  const total = {};
  for (const obj of lista) for (const [m, v] of Object.entries(obj)) total[m] = Math.round(((total[m] ?? 0) + v) * 100) / 100;
  return total;
};
const moedas = (obj) => Object.entries(obj ?? {}).map(([m, v]) => fmtMoeda(v, m)).join(" + ") || fmtMoeda(0, "USD");

const indicadores = computed(() => {
  const gs = gruposDaAba.value;
  const soma = (fn) => gs.reduce((s, g) => s + fn(g), 0);
  return {
    ativos: soma((g) => g.containers.length),
    naFabrica: soma((g) => STATUS_NA_FABRICA.reduce((s, st) => s + (g.porStatus[st] ?? 0), 0)),
    vermelhos: soma((g) => g.semaforo.VERMELHO),
    amarelos: soma((g) => g.semaforo.AMARELO),
    custoDemurrage: somarMoedas(gs.map((g) => g.custoDemurrage)),
    custoEstadia: Math.round(soma((g) => g.custoEstadia) * 100) / 100,
  };
});

// ---------- Grupos exibidos ----------
const grupos = computed(() =>
  gruposDaAba.value
    .filter((g) => !filtroGrupo.value || String(g.id) === filtroGrupo.value)
    .map((g) => {
      const visiveis = g.containers.filter((c) => !soProblemas.value || c.semaforo !== "VERDE");
      return {
        ...g,
        fases: FASES.map((f) => ({ ...f, containers: visiveis.filter((c) => f.status.includes(c.status)) })).filter((f) => f.containers.length),
      };
    })
    .filter((g) => !soProblemas.value || g.fases.length)
);
</script>

<template>
  <div v-if="erro" class="erro">{{ erro }}</div>
  <div v-if="!dados && !erro" class="vazio">Carregando pátio…</div>
  <template v-if="dados">
    <nav class="abas" role="tablist" aria-label="Regiões">
      <button
        v-for="a in abas" :key="a.chave" role="tab" class="aba"
        :class="{ ativa: a.chave === abaAtual }" :aria-selected="a.chave === abaAtual"
        @click="selecionarAba(a.chave)"
      >
        {{ a.nome }}
        <span class="aba-contagem">{{ a.ativos }}</span>
        <span v-if="a.vermelhos" class="chip vermelho" title="Containers em situação crítica">{{ a.vermelhos }}</span>
        <span v-else-if="a.amarelos" class="chip amarelo" title="Containers em atenção">{{ a.amarelos }}</span>
      </button>
      <router-link v-if="abas.length <= 1" to="/cadastros/regioes" class="pequeno" style="align-self: center; margin-left: 8px">
        Cadastre regiões para separar o pátio em abas
      </router-link>
    </nav>

    <div class="kpis">
      <div class="kpi"><div class="rotulo">Containers ativos</div><div class="valor">{{ indicadores.ativos }}</div></div>
      <div class="kpi"><div class="rotulo">Na fábrica agora</div><div class="valor">{{ indicadores.naFabrica }}</div></div>
      <div class="kpi vermelho"><div class="rotulo">Em situação crítica</div><div class="valor">{{ indicadores.vermelhos }}</div></div>
      <div class="kpi amarelo"><div class="rotulo">Em atenção</div><div class="valor">{{ indicadores.amarelos }}</div></div>
      <div class="kpi" :class="{ vermelho: Object.keys(indicadores.custoDemurrage).length }">
        <div class="rotulo">Demurrage acumulada (ativos)</div>
        <div class="valor" style="font-size: 18px">{{ moedas(indicadores.custoDemurrage) }}</div>
      </div>
      <div v-if="indicadores.custoEstadia" class="kpi vermelho">
        <div class="rotulo">Estadia excedida (custo)</div>
        <div class="valor" style="font-size: 18px">{{ fmtMoeda(indicadores.custoEstadia) }}</div>
      </div>
    </div>

    <div class="linha-entre">
      <div class="filtros">
        <div class="campo">
          <label>Ponto de Carregamento</label>
          <select v-model="filtroGrupo">
            <option value="">Todos</option>
            <option v-for="g in gruposDaAba" :key="g.id" :value="String(g.id)">{{ g.cliente }} / {{ g.fabrica }}</option>
          </select>
        </div>
        <label class="linha pequeno" style="gap: 6px; padding-bottom: 8px"><input v-model="soProblemas" type="checkbox" /> Só atenção/crítico</label>
      </div>
      <span class="mudo pequeno">Atualizado {{ fmtDataHora(dados.geradoEm) }} · atualiza sozinho a cada minuto</span>
    </div>

    <div v-if="!grupos.length" class="card vazio">
      <template v-if="!gruposDaAba.length">Nenhuma fábrica vinculada a esta região. Vincule em <router-link to="/cadastros/grupos">Ponto de Carregamento</router-link>.</template>
      <template v-else>
        Nenhum container ativo{{ soProblemas ? " com problema" : "" }}.
        <router-link v-if="!soProblemas" to="/containers">Cadastrar container</router-link>
      </template>
    </div>

    <section v-for="g in grupos" :key="g.id" class="card">
      <div class="grupo-cabecalho">
        <div>
          <div class="grupo-titulo">{{ g.cliente }} / {{ g.fabrica }}</div>
          <div class="mudo pequeno">
            <template v-if="abaAtual === 'todas'">{{ g.regiao?.nome ?? "Sem região" }} · </template>
            Meta de estadia: {{ g.metaEstadiaHoras }}h · {{ g.containers.length }} container(s) ativo(s)
          </div>
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
