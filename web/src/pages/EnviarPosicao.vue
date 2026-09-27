<script setup>
// Página do link do SMS de rastreamento: pega a posição GPS do celular e envia. Sem login —
// o código do link autentica, só vale para o responsável atual e só uma vez.
import { onMounted, ref } from "vue";
import { api } from "../api.js";

const props = defineProps({ codigo: { type: String, required: true } });

const estado = ref("carregando"); // carregando | valido | invalido | enviando | concluido
const numero = ref("");
const mensagem = ref("");
const erro = ref(null);
const precisao = ref(null);
const podeLocalizar = typeof window !== "undefined" && window.isSecureContext && "geolocation" in navigator;

onMounted(async () => {
  try {
    const r = await api.conferirPedidoPosicao(props.codigo);
    if (r.valido) {
      numero.value = r.numero;
      estado.value = "valido";
    } else {
      mensagem.value = r.mensagem;
      estado.value = r.respondida ? "concluido" : "invalido";
    }
  } catch (e) {
    mensagem.value = e.message;
    estado.value = "invalido";
  }
});

function lerPosicao() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, precisaoM: Math.round(p.coords.accuracy) }),
      (e) => reject(new Error(
        e.code === 1
          ? "O celular não liberou a localização. Permita o acesso à localização para este site e tente de novo."
          : "Não foi possível obter a posição (sem sinal de GPS?). Vá para um lugar aberto e tente de novo."
      )),
      // Posição exata e atual: GPS de alta precisão, sem reaproveitar posição antiga.
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  });
}

async function enviar() {
  erro.value = null;
  estado.value = "enviando";
  try {
    const pos = await lerPosicao();
    precisao.value = pos.precisaoM;
    const r = await api.enviarPosicao(props.codigo, pos);
    mensagem.value = r.mensagem;
    estado.value = "concluido";
  } catch (e) {
    erro.value = e.message;
    estado.value = e.status === 409 ? "invalido" : "valido";
    if (e.status === 409) mensagem.value = e.message;
  }
}
</script>

<template>
  <div class="login-shell">
    <div class="login-card">
      <div class="marca">
        <div class="marca-sigla">C.C.S</div>
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
.grande { justify-content: center; padding: 14px; font-size: 16px; }
</style>
