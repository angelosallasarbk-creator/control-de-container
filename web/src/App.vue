<script setup>
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "./stores/auth.js";
import { api } from "./api.js";
import { ROTULO_ALERTA, ROTULO_PERFIL } from "./formato.js";
import Login from "./pages/Login.vue";
import Icone from "./components/Icone.vue";
import { visaoContainers, definirVisaoContainers } from "./visaoContainers.js";
import FiltrosContainers from "./components/FiltrosContainers.vue";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

// Perfis de campo usam só parte do sistema (a API também bloqueia o resto):
// - Transportador: só as telas do QR; qualquer outra rota vai para "Registrar pelo código".
// - Portaria: telas do QR + Home (consulta); outras rotas voltam à Home.
const TELAS_DO_PERFIL = {
  TRANSPORTADOR: { telas: ["leitura-qr", "leitura-codigo"], inicio: "/leitura" },
  PORTARIA: { telas: ["painel", "leitura-qr", "leitura-codigo"], inicio: "/" },
};
const restricao = computed(() => TELAS_DO_PERFIL[auth.usuario?.perfil] ?? null);
const ehTransportador = computed(() => auth.usuario?.perfil === "TRANSPORTADOR");
const ehPortaria = computed(() => auth.usuario?.perfil === "PORTARIA");
// Só decide com a rota já resolvida: na carga inicial (ex.: QR aberto já logado) route.name ainda
// é indefinido e redirecionaria a leitura do QR por engano.
const foraDoPerfil = computed(() => Boolean(restricao.value && route.name && !restricao.value.telas.includes(route.name)));
watch([restricao, () => route.name], () => {
  if (foraDoPerfil.value) router.replace(restricao.value.inicio);
}, { immediate: true });

// Menu lateral:
// - tela larga: fica ao lado do conteúdo; o ☰ recolhe/expande (preferência lembrada no navegador);
// - tela estreita (≤ 860px): vira gaveta por cima do conteúdo; fecha no ✕, clicando fora ou com Esc.
const CHAVE_MENU_RECOLHIDO = "cc_menu_recolhido";
const telaEstreita = window.matchMedia("(max-width: 860px)");
const estreita = ref(telaEstreita.matches);
const menuAberto = ref(false); // gaveta (tela estreita)
const menuRecolhido = ref(lerPreferencia()); // tela larga

function lerPreferencia() {
  try {
    return localStorage.getItem(CHAVE_MENU_RECOLHIDO) === "1";
  } catch {
    return false;
  }
}
function gravarRecolhido(valor) {
  menuRecolhido.value = valor;
  try {
    localStorage.setItem(CHAVE_MENU_RECOLHIDO, valor ? "1" : "0");
  } catch {
    // sem armazenamento: só não lembra a escolha
  }
}
function alternarMenu() {
  if (estreita.value) {
    menuAberto.value = !menuAberto.value;
    return;
  }
  if (menuFlutuante.value) return fixarMenu();
  gravarRecolhido(!menuRecolhido.value);
}
// Volta ao modo "menu sempre aberto ao lado do conteúdo".
function fixarMenu() {
  menuFlutuante.value = false;
  gravarRecolhido(false);
}

// Menu recolhido (tela larga): passar o mouse na borda esquerda abre o menu por cima do
// conteúdo; clicar fora, Esc ou navegar recolhe de novo. O pequeno atraso evita abrir sem
// querer quando o mouse só cruza a borda.
const ATRASO_HOVER_MS = 150;
const LARGURA_ALCA_PX = 14;
const menuFlutuante = ref(false);
let timerHover = null;
// Ao recolher (Esc, navegação) com o mouse ainda na borda, a alça reaparece debaixo dele e o
// menu reabriria sozinho. Então o hover fica bloqueado até o mouse sair da borda.
let hoverBloqueado = false;
let ultimoX = Infinity;
const aoMoverMouse = (e) => {
  ultimoX = e.clientX;
  if (hoverBloqueado && ultimoX > LARGURA_ALCA_PX) hoverBloqueado = false;
};
function recolherFlutuante() {
  if (!menuFlutuante.value) return;
  menuFlutuante.value = false;
  hoverBloqueado = ultimoX <= LARGURA_ALCA_PX;
}
function aoEntrarNaAlca() {
  clearTimeout(timerHover);
  if (hoverBloqueado) return;
  timerHover = setTimeout(() => (menuFlutuante.value = true), ATRASO_HOVER_MS);
}
function aoSairDaAlca() {
  clearTimeout(timerHover);
  hoverBloqueado = false;
}
// Clique/toque (e Enter no teclado) na alça abre na hora — é o caminho no celular.
function abrirPelaAlca() {
  clearTimeout(timerHover);
  if (estreita.value) menuAberto.value = true;
  else menuFlutuante.value = true;
}
const refLateral = ref(null);
const refAlca = ref(null);
function aoClicarNaPagina(e) {
  if (!menuFlutuante.value) return;
  if (refLateral.value?.contains(e.target) || refAlca.value?.contains(e.target) || e.target.closest?.(".botao-menu")) return;
  recolherFlutuante();
}

const aoMudarLargura = (e) => {
  estreita.value = e.matches;
  menuAberto.value = false;
  menuFlutuante.value = false;
};
const aoTeclar = (e) => {
  if (e.key !== "Escape") return;
  menuAberto.value = false;
  recolherFlutuante();
};
onMounted(() => {
  telaEstreita.addEventListener("change", aoMudarLargura);
  window.addEventListener("keydown", aoTeclar);
  document.addEventListener("mousedown", aoClicarNaPagina);
  document.addEventListener("mousemove", aoMoverMouse, { passive: true });
});
onBeforeUnmount(() => {
  telaEstreita.removeEventListener("change", aoMudarLargura);
  window.removeEventListener("keydown", aoTeclar);
  document.removeEventListener("mousedown", aoClicarNaPagina);
  document.removeEventListener("mousemove", aoMoverMouse);
  clearTimeout(timerHover);
});
const menuVisivel = computed(() => (estreita.value ? menuAberto.value : !menuRecolhido.value || menuFlutuante.value));
// A alça "›" aparece sempre que o menu está escondido.
const mostrarAlca = computed(() => (estreita.value ? !menuAberto.value : menuRecolhido.value && !menuFlutuante.value));
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
  if (ehTransportador.value) return; // sem acesso a alertas
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

// Observa só login/logout (o e-mail): a atualização periódica troca o objeto do usuário e,
// se o watch olhasse o objeto inteiro, reiniciaria o ciclo a cada atualização.
watch(
  () => auth.usuario?.email,
  (email) => {
    clearInterval(timer);
    if (email) {
      atualizarAlertas();
      timer = setInterval(() => {
        atualizarAlertas();
        auth.atualizar(); // permissões alteradas pelo admin aparecem sem relogar
      }, INTERVALO_ALERTAS_MS);
    }
  }
);
watch(() => route.fullPath, () => { menuAberto.value = false; recolherFlutuante(); atualizarAlertas(); });
onBeforeUnmount(() => clearInterval(timer));
// Telas que mudam alertas (ficha, Alertas) pedem para atualizar o sino/faixa na hora.
provide("atualizarAlertas", atualizarAlertas);

// Troca o modelo da tela de Containers (fica lembrado). Tabela sempre volta para /containers.
function trocarVisao(valor) {
  definirVisaoContainers(valor);
  if (valor === "tabela" && route.name !== "containers") router.push("/containers");
}

// Seções do menu recolhíveis (Cadastros, Administração): estado lembrado neste navegador; a
// seção da tela aberta fica sempre expandida para o item ativo não sumir.
const CHAVE_SECOES = "cc_menu_secoes";
const SECAO_DA_ROTA = [
  ["cadastros", ["/cadastros", "/locais"]],
  ["administracao", ["/usuarios", "/integracao", "/configuracoes"]],
];
function lerSecoes() {
  try {
    return JSON.parse(localStorage.getItem(CHAVE_SECOES) || "{}");
  } catch {
    return {};
  }
}
const secoes = ref(lerSecoes());
const secaoDaRota = computed(() => SECAO_DA_ROTA.find(([, prefixos]) => prefixos.some((p) => route.path.startsWith(p)))?.[0]);
const secaoAberta = (nome) => secaoDaRota.value === nome || secoes.value[nome] !== false;
function alternarSecao(nome) {
  secoes.value = { ...secoes.value, [nome]: !secaoAberta(nome) };
  try {
    localStorage.setItem(CHAVE_SECOES, JSON.stringify(secoes.value));
  } catch {
    // sem armazenamento: só não lembra
  }
}

const criticos = computed(() => resumo.value?.criticosNaoReconhecidos ?? []);
</script>

<template>
  <div v-if="auth.usuario === undefined" class="vazio">Carregando…</div>
  <Login v-else-if="auth.usuario === null" />
  <div v-else-if="foraDoPerfil" class="vazio">Abrindo…</div>
  <!-- Celular (QR) e folha de impressão: sem menu/cabeçalho. Depois do login continua na mesma URL. -->
  <router-view v-else-if="route.meta.layout === 'simples'" />
  <div v-else class="shell" :class="{ 'menu-recolhido': menuRecolhido && !estreita }">
    <div v-if="estreita && menuAberto" class="fundo-menu" aria-hidden="true" @click="menuAberto = false"></div>
    <button
      v-if="mostrarAlca" ref="refAlca" type="button" class="alca-menu" aria-label="Abrir menu" aria-controls="menu-lateral"
      title="Passe o mouse aqui (ou clique) para abrir o menu"
      @mouseenter="aoEntrarNaAlca" @mouseleave="aoSairDaAlca" @click="abrirPelaAlca"
    >
      <span class="alca-seta" aria-hidden="true">›</span>
    </button>
    <aside
      id="menu-lateral" ref="refLateral" class="lateral" :class="{ aberta: menuAberto, flutuante: menuFlutuante }"
      :aria-hidden="!menuVisivel" :inert="!menuVisivel || undefined"
    >
      <div class="lateral-marca">
        <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="8" width="28" height="16" rx="2" fill="#4a8fdc" /><path d="M8 11v10M13 11v10M18 11v10M23 11v10" stroke="#fff" stroke-width="2" /></svg>
        <span class="espaco">Controle de Container</span>
        <button v-if="estreita" class="fechar-menu" aria-label="Fechar menu" @click="menuAberto = false">✕</button>
        <!-- Flutuando por cima (tela larga), o menu cobre o ☰; o 📌 o fixa aberto de novo. -->
        <button v-else-if="menuFlutuante" class="fechar-menu" title="Manter menu aberto" aria-label="Manter menu aberto" @click="fixarMenu">📌</button>
      </div>
      <nav>
        <router-link to="/">Home</router-link>
        <router-link v-if="ehPortaria" to="/leitura">Registrar pelo código</router-link>
        <template v-else>
        <router-link to="/containers" :class="{ ativo: route.path.startsWith('/containers') }">Containers</router-link>
        <router-link to="/alertas">
          Alertas
          <span v-if="resumo?.total" class="chip" :class="resumo.criticos ? 'vermelho' : 'amarelo'">{{ resumo.total }}</span>
        </router-link>
        <router-link to="/etiquetas" :class="{ ativo: route.path.startsWith('/etiquetas') }">Etiquetas QR</router-link>
        <router-link to="/leitura">Registrar pelo código</router-link>
        <router-link to="/custos">Custo estimado</router-link>
        <button
          type="button" class="lateral-secao" :aria-expanded="secaoAberta('cadastros')" aria-controls="menu-cadastros"
          @click="alternarSecao('cadastros')"
        >
          <span>Cadastros</span><span class="seta-secao" :class="{ aberta: secaoAberta('cadastros') }" aria-hidden="true">›</span>
        </button>
        <div v-show="secaoAberta('cadastros')" id="menu-cadastros" class="sub-itens">
          <router-link to="/cadastros/regioes">Regiões</router-link>
          <router-link to="/locais">Locais</router-link>
          <router-link to="/cadastros/grupos">Ponto de Carregamento</router-link>
          <router-link to="/cadastros/armadores">Armadores</router-link>
          <router-link to="/cadastros/produtos">Produtos (temperatura)</router-link>
        </div>
        <template v-if="auth.pode('administrar') || auth.pode('auditoria.ver')">
          <button
            type="button" class="lateral-secao" :aria-expanded="secaoAberta('administracao')" aria-controls="menu-administracao"
            @click="alternarSecao('administracao')"
          >
            <span>Administração</span><span class="seta-secao" :class="{ aberta: secaoAberta('administracao') }" aria-hidden="true">›</span>
          </button>
          <div v-show="secaoAberta('administracao')" id="menu-administracao" class="sub-itens">
            <router-link v-if="auth.pode('administrar')" to="/usuarios">Usuários</router-link>
            <router-link v-if="auth.pode('administrar')" to="/integracao">Integração</router-link>
            <router-link to="/configuracoes">Configurações e log</router-link>
          </div>
        </template>
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
        <router-link v-if="!ehPortaria" to="/alertas" class="btn pequeno">Ver alertas</router-link>
      </div>
      <header class="topo">
        <div class="linha">
          <button
            class="botao-menu pequeno" aria-controls="menu-lateral" :aria-expanded="menuVisivel"
            :aria-label="menuVisivel ? 'Recolher menu' : 'Abrir menu'" :title="menuVisivel ? 'Recolher menu' : 'Abrir menu'"
            @click="alternarMenu"
          >☰</button>
          <h1>{{ route.meta.titulo }}</h1>
          <div v-if="['containers', 'ficha'].includes(route.name)" class="seletor-visao" role="group" aria-label="Modelo de visão">
            <button type="button" :class="{ ativo: route.name === 'ficha' || visaoContainers === 'grid' }" title="Lista + detalhe" @click="trocarVisao('grid')">
              <Icone nome="grid" :tamanho="16" /> Grid
            </button>
            <button type="button" :class="{ ativo: route.name === 'containers' && visaoContainers === 'tabela' }" title="Tabela com todos os containers" @click="trocarVisao('tabela')">
              <Icone nome="tabela" :tamanho="16" /> Tabela
            </button>
          </div>
          <FiltrosContainers v-if="['containers', 'ficha'].includes(route.name)" />
        </div>
        <router-link v-if="!ehPortaria" to="/alertas" class="sino" title="Alertas abertos" aria-label="Alertas">
          <span class="btn pequeno" aria-hidden="true">🔔</span>
          <span v-if="resumo?.naoReconhecidos" class="badge">{{ resumo.naoReconhecidos }}</span>
        </router-link>
      </header>
      </div>
      <main class="pagina">
        <!-- key = path (não fullPath): trocar só a query, como a aba de região da Home, não recria a tela.
             meta.chave fixa (ficha do container): trocar de container na lista lateral não recria a lista. -->
        <router-view :key="route.meta.chave ?? route.path" />
      </main>
    </div>
  </div>
</template>
