<script setup>
// Página do link do SMS de rastreamento: pega a posição GPS do celular e envia. Sem login —
// o código do link autentica, só vale para o responsável atual e só uma vez.
// Reforço opcional (o SMS continua sendo o principal): depois de enviar, a pessoa pode deixar a
// página aberta "acompanhando" até a entrega no destino — o celular manda a posição a cada 5 min. Para
// sozinho se a página for minimizada/fechada ou a tela bloquear (limite dos navegadores).
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api.js";
import { melhorPosicao } from "../geolocalizacao.js";

const props = defineProps({ codigo: { type: String, required: true } });

const estado = ref("carregando"); // carregando | valido | invalido | enviando | concluido
const numero = ref("");
const mensagem = ref("");
const erro = ref(null);
const precisao = ref(null);
const podeLocalizar = typeof window !== "undefined" && window.isSecureContext && "geolocation" in navigator;

// Acompanhamento: 1 posição a cada 5 min (em rodovia ≈ 7 km entre pontos — suficiente como reforço,
// com pouco tráfego e bateria). Ao voltar para a página manda na hora, respeitando 1 por minuto.
const ENVIO_A_CADA_MS = 5 * 60 * 1000;
const INTERVALO_MINIMO_MS = 60 * 1000; // o servidor recusa mais de 1 por minuto
const PRECISAO_MAXIMA_M = 1000; // leituras piores que isso não são enviadas
const podeAcompanhar = ref(false);
const acompanhando = ref(false);
const statusAcomp = ref("");
const erroAcomp = ref(null);
const enviosAcomp = ref(0);
const ultimoEnvioEm = ref(null);
const telaLigada = ref(false);
let watchId = null;
let timer = null;
let wakeLock = null;
let ultimaLeitura = null;
let ultimaEnviada = null;
let enviandoAgora = false;

onMounted(async () => {
  try {
    const r = await api.conferirPedidoPosicao(props.codigo);
    if (r.valido) {
      numero.value = r.numero;
      estado.value = "valido";
    } else {
      mensagem.value = r.mensagem;
      estado.value = r.respondida ? "concluido" : "invalido";
      if (r.podeAcompanhar) {
        podeAcompanhar.value = true;
        numero.value = r.numero;
      }
    }
  } catch (e) {
    mensagem.value = e.message;
    estado.value = "invalido";
  }
});

const MSG_PERMISSAO = "O celular não liberou a localização. Permita o acesso à localização para este site e tente de novo.";

async function enviar() {
  erro.value = null;
  estado.value = "enviando";
  try {
    // Até 15 s acompanhando o GPS e fica com a leitura mais precisa (para antes se chegar a ±30 m).
    const pos = await melhorPosicao({ alvoM: 30, tempoMaxMs: 15000 }).catch((e) => {
      throw new Error(e.code === 1 ? MSG_PERMISSAO : "Não foi possível obter a posição (sem sinal de GPS?). Vá para um lugar aberto e tente de novo.");
    });
    precisao.value = pos.precisaoM;
    const r = await api.enviarPosicao(props.codigo, pos);
    mensagem.value = r.mensagem;
    estado.value = "concluido";
    podeAcompanhar.value = true;
    ultimaEnviada = { ...pos, em: Date.now() };
  } catch (e) {
    erro.value = e.message;
    estado.value = e.status === 409 ? "invalido" : "valido";
    if (e.status === 409) mensagem.value = e.message;
  }
}

// ---------- Acompanhamento (reforço) ----------
const fmtHora = (ms) => (ms ? new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "");
const textoUltimoEnvio = computed(() => (ultimoEnvioEm.value ? `Última posição enviada às ${fmtHora(ultimoEnvioEm.value)}` : "Aguardando a primeira posição…"));

async function manterTelaLigada() {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      telaLigada.value = true;
      wakeLock.addEventListener("release", () => { telaLigada.value = false; });
    }
  } catch {
    telaLigada.value = false; // sem suporte/bateria fraca: segue sem manter a tela ligada
  }
}

function deveEnviar(agora, forcar) {
  if (!ultimaLeitura || ultimaLeitura.precisaoM > PRECISAO_MAXIMA_M) return false;
  if (!ultimaEnviada) return true;
  const desde = agora - ultimaEnviada.em;
  if (desde < INTERVALO_MINIMO_MS) return false;
  return forcar || desde >= ENVIO_A_CADA_MS;
}

async function talvezEnviar(forcar = false) {
  const agora = Date.now();
  if (enviandoAgora || !acompanhando.value || !deveEnviar(agora, forcar)) return;
  enviandoAgora = true;
  const pos = { latitude: ultimaLeitura.latitude, longitude: ultimaLeitura.longitude, precisaoM: ultimaLeitura.precisaoM };
  try {
    await api.acompanharPosicao(props.codigo, pos);
    ultimaEnviada = { ...pos, em: agora };
    ultimoEnvioEm.value = agora;
    enviosAcomp.value++;
    erroAcomp.value = null;
  } catch (e) {
    if (e.status === 429) ultimaEnviada = { ...pos, em: agora }; // já tinha posição recente: espera o próximo ciclo
    else if (e.status === 409) { parar(); erroAcomp.value = e.message; podeAcompanhar.value = false; }
    else erroAcomp.value = "Sem conexão agora — tentando de novo em instantes.";
  } finally {
    enviandoAgora = false;
  }
}

function aoVoltarParaPagina() {
  if (!acompanhando.value) return;
  if (document.visibilityState === "visible") {
    statusAcomp.value = "Acompanhando";
    manterTelaLigada();
    talvezEnviar(true); // voltou: manda a posição atual (respeitando 1 por minuto)
  } else {
    statusAcomp.value = "Pausado (página minimizada)";
  }
}

function iniciar() {
  erroAcomp.value = null;
  acompanhando.value = true;
  statusAcomp.value = "Acompanhando";
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      ultimaLeitura = { latitude: p.coords.latitude, longitude: p.coords.longitude, precisaoM: Math.round(p.coords.accuracy) };
      talvezEnviar();
    },
    (e) => {
      if (e.code === 1) { parar(); erroAcomp.value = MSG_PERMISSAO; }
    },
    { enableHighAccuracy: true, maximumAge: 30000 }
  );
  // Parado no mesmo lugar o GPS quase não manda leituras novas: confere o relógio a cada 30 s.
  timer = setInterval(() => talvezEnviar(), 30000);
  document.addEventListener("visibilitychange", aoVoltarParaPagina);
  manterTelaLigada();
}

function parar() {
  acompanhando.value = false;
  statusAcomp.value = "";
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", aoVoltarParaPagina);
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  telaLigada.value = false;
}

onBeforeUnmount(parar);
</script>

<template>
  <div class="login-shell">
    <div class="login-card">
      <div class="marca">
        <div class="marca-sigla">CCS</div>
        <div class="marca-nome">Container Control Solutions</div>
      </div>
      <div class="login-subtitulo">Enviar posição do container</div>

      <div v-if="estado === 'carregando'" class="vazio">Conferindo o link…</div>

      <template v-else-if="estado === 'invalido'">
        <div class="erro" role="alert">{{ mensagem || "Link inválido." }}</div>
      </template>

      <template v-else-if="estado === 'concluido'">
        <div class="sucesso" role="status">{{ mensagem }}</div>
        <p v-if="precisao !== null" class="mudo pequeno" style="margin: 0; text-align: center">Precisão aproximada: {{ precisao }} m</p>

        <div v-if="podeAcompanhar && podeLocalizar" class="acomp">
          <template v-if="!acompanhando">
            <div class="negrito">Quer acompanhar a viagem pela página? <span class="mudo">(opcional)</span></div>
            <p class="pequeno" style="margin: 0">
              Com esta página <strong>aberta</strong>, o celular envia a posição do container <strong>{{ numero }}</strong> a cada 5 minutos. Se a página for <strong>minimizada, fechada ou a tela bloquear</strong>, o envio para — os SMS continuam chegando normalmente.
              Vale até a entrega do container no destino.
            </p>
            <button type="button" class="primario grande" @click="iniciar">Acompanhar com a página aberta</button>
          </template>
          <template v-else>
            <div role="status" aria-live="polite">
              <span class="chip verde">{{ statusAcomp }}</span>
              <span class="pequeno"> {{ textoUltimoEnvio }}</span>
              <span v-if="enviosAcomp" class="mudo pequeno"> · {{ enviosAcomp }} {{ enviosAcomp === 1 ? "envio" : "envios" }}</span>
            </div>
            <p class="mudo pequeno" style="margin: 0">
              Deixe esta página aberta na tela{{ telaLigada ? " (a tela vai ficar ligada)" : "" }}. Se minimizar, ao voltar o envio continua.
            </p>
            <button type="button" class="grande" @click="parar">Parar acompanhamento</button>
          </template>
          <div v-if="erroAcomp" class="erro" role="alert">{{ erroAcomp }}</div>
        </div>
        <div v-else-if="erroAcomp" class="erro" role="alert">{{ erroAcomp }}</div>
      </template>

      <template v-else>
        <p style="margin: 0; text-align: center">Container <strong class="numero">{{ numero }}</strong></p>
        <div v-if="!podeLocalizar" class="erro" role="alert">Este navegador não permite pegar a localização. Abra o link no navegador do celular (Chrome ou Safari).</div>
        <div v-if="erro" class="erro" role="alert">{{ erro }}</div>
        <button type="button" class="primario grande" :disabled="!podeLocalizar || estado === 'enviando'" @click="enviar">
          {{ estado === "enviando" ? "Pegando a posição…" : "Enviar minha posição" }}
        </button>
        <p class="mudo pequeno" style="margin: 0">Toque no botão perto do container. O celular vai pedir permissão para usar a localização: toque em <strong>Permitir</strong>.</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.marca { text-align: center; }
.marca-sigla { font-size: 30px; font-weight: 800; letter-spacing: .06em; line-height: 1.1; }
.marca-nome { font-size: 13px; color: var(--texto-2); margin-top: 2px; letter-spacing: .02em; }
.login-subtitulo { text-align: center; font-size: 16px; font-weight: 600; margin-top: 4px; }
.numero { font-size: 20px; letter-spacing: .04em; }
.grande { justify-content: center; padding: 14px; font-size: 16px; white-space: normal; text-align: center; }
.acomp { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--borda); padding-top: 14px; margin-top: 4px; }
</style>
