<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useAuthStore } from "./stores/auth.js";
import { api } from "./api.js";
import { ROTULO_ALERTA, ROTULO_PERFIL } from "./formato.js";
import Login from "./pages/Login.vue";

const auth = useAuthStore();
const route = useRoute();
const menuAberto = ref(false);
const resumo = ref(null);
const INTERVALO_ALERTAS_MS = 30000;
let timer = null;
let criticosVistos = null;

onMounted(() => auth.carregar());

// Beep curto quando surge um alerta crítico novo (navegadores só tocam depois de alguma interação).
function bipar() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch {
    // sem som disponível; o aviso visual continua
  }
}

async function atualizarAlertas() {
  try {
    const r = await api.resumoAlertas();
    const ids = new Set(r.criticosNaoReconhecidos.map((a) => a.id));
    if (criticosVistos && [...ids].some((id) => !criticosVistos.has(id))) bipar();
    criticosVistos = ids;
    resumo.value = r;
  } catch (e) {
    if (e.status === 401) auth.usuario = null;
  }
}

watch(
  () => auth.usuario,
  (u) => {
    clearInterval(timer);
    if (u) {
      atualizarAlertas();
      timer = setInterval(atualizarAlertas, INTERVALO_ALERTAS_MS);
    }
  }
);
watch(() => route.fullPath, () => { menuAberto.value = false; atualizarAlertas(); });
onBeforeUnmount(() => clearInterval(timer));

const criticos = computed(() => resumo.value?.criticosNaoReconhecidos ?? []);
</script>

<template>
  <div v-if="auth.usuario === undefined" class="vazio">Carregando…</div>
  <Login v-else-if="auth.usuario === null" />
  <div v-else class="shell">
    <aside class="lateral" :class="{ aberta: menuAberto }">
      <div class="lateral-marca">
        <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="8" width="28" height="16" rx="2" fill="#4a8fdc" /><path d="M8 11v10M13 11v10M18 11v10M23 11v10" stroke="#fff" stroke-width="2" /></svg>
        Controle de Container
      </div>
      <nav>
        <router-link to="/">Pátio</router-link>
        <router-link to="/containers" :class="{ ativo: route.path.startsWith('/containers') }">Containers</router-link>
        <router-link to="/alertas">
          Alertas
          <span v-if="resumo?.total" class="chip" :class="resumo.criticos ? 'vermelho' : 'amarelo'">{{ resumo.total }}</span>
        </router-link>
        <router-link to="/custos">Custo estimado</router-link>
        <div class="lateral-secao">Cadastros</div>
        <router-link to="/cadastros/regioes">Regiões</router-link>
        <router-link to="/locais">Locais (fábricas e portos)</router-link>
        <router-link to="/cadastros/grupos">Cliente / Fábrica</router-link>
        <router-link to="/cadastros/armadores">Armadores</router-link>
        <router-link to="/cadastros/produtos">Produtos (temperatura)</router-link>
        <template v-if="auth.pode('cadastros')">
          <div class="lateral-secao">Administração</div>
          <router-link v-if="auth.pode('administrar')" to="/usuarios">Usuários</router-link>
          <router-link v-if="auth.pode('administrar')" to="/integracao">Integração</router-link>
          <router-link to="/configuracoes">Configurações e log</router-link>
        </template>
      </nav>
      <div class="lateral-rodape">
        <div class="negrito" style="color: #fff">{{ auth.usuario.nome }}</div>
        <div>{{ ROTULO_PERFIL[auth.usuario.perfil] }}</div>
        <button class="pequeno" @click="auth.logout()">Sair</button>
      </div>
    </aside>

    <div class="conteudo">
      <!-- Faixa de críticos + título ficam fixos no topo; só o conteúdo da página rola. -->
      <div class="cabecalho-fixo">
      <div v-if="criticos.length" class="faixa-critica">
        <span>
          <strong class="so-desktop">{{ criticos.length }} alerta(s) crítico(s) sem reconhecimento</strong>
          <strong class="so-celular">⚠ {{ criticos.length }} alerta(s) crítico(s)</strong>
          <span class="faixa-detalhe"> —
            {{ criticos.slice(0, 3).map((a) => `${a.container.numero} (${ROTULO_ALERTA[a.tipo]})`).join(", ") }}{{ criticos.length > 3 ? "…" : "" }}</span>
        </span>
        <router-link to="/alertas"><button class="pequeno">Ver alertas</button></router-link>
      </div>
      <header class="topo">
        <div class="linha">
          <button class="botao-menu pequeno" @click="menuAberto = !menuAberto" aria-label="Menu">☰</button>
          <h1>{{ route.meta.titulo }}</h1>
        </div>
        <router-link to="/alertas" class="sino" title="Alertas abertos">
          <button class="pequeno" aria-label="Alertas">🔔</button>
          <span v-if="resumo?.naoReconhecidos" class="badge">{{ resumo.naoReconhecidos }}</span>
        </router-link>
      </header>
      </div>
      <main class="pagina">
        <!-- key = path (não fullPath): trocar só a query, como a aba de região do Pátio, não recria a tela. -->
        <router-view :key="route.path" @alertas-mudaram="atualizarAlertas" />
      </main>
    </div>
  </div>
</template>
