<script setup>
// Página do QR da etiqueta (/q/:token). Quem está lendo?
// - usuário da equipe logado → tela do QR normal;
// - motorista com sessão no celular → tela do QR como motorista (sem usuário);
// - ninguém → acesso do motorista (celular + código SMS) ou, pelo link, o login da equipe.
import { onMounted, ref, watch } from "vue";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import LeituraQR from "./LeituraQR.vue";
import AcessoMotorista from "../components/AcessoMotorista.vue";
import Login from "./Login.vue";

const props = defineProps({ token: { type: String, required: true } });
const auth = useAuthStore();
const motorista = ref(undefined); // undefined = conferindo; null = sem sessão
const modoEquipe = ref(false); // "Sou da equipe": mostra o login com e-mail e senha
const aviso = ref(null);

async function conferirMotorista() {
  try {
    motorista.value = (await api.motoristaEu()).motorista;
  } catch (e) {
    motorista.value = null;
    if (e.status === 403) aviso.value = e.message; // bloqueado
  }
}
onMounted(conferirMotorista);
// Sem usuário da equipe logado, confere a sessão de motorista (a carga do login é assíncrona).
watch(() => auth.usuario, (u) => { if (u) modoEquipe.value = false; });

function entrou(m) {
  aviso.value = null;
  motorista.value = m;
}
async function sair() {
  try {
    await api.motoristaSair();
  } catch {
    // sai localmente mesmo com erro de rede
  }
  motorista.value = null;
}
function sessaoEncerrada(msg) {
  motorista.value = null;
  aviso.value = msg;
}
</script>

<template>
  <div v-if="auth.usuario === undefined || motorista === undefined" class="vazio">Carregando…</div>
  <LeituraQR v-else-if="auth.usuario" :token="token" />
  <LeituraQR v-else-if="motorista" :token="token" :motorista="motorista" @sair="sair" @sessao-encerrada="sessaoEncerrada" />
  <div v-else-if="modoEquipe">
    <Login />
    <p class="voltar-motorista"><button type="button" class="link" @click="modoEquipe = false">← Sou motorista (entrar pelo celular)</button></p>
  </div>
  <AcessoMotorista v-else :aviso="aviso" @entrou="entrou" @equipe="modoEquipe = true" />
</template>

<style scoped>
.voltar-motorista { position: fixed; bottom: 12px; left: 0; right: 0; text-align: center; margin: 0; }
.voltar-motorista .link { background: rgba(255,255,255,.92); border: none; padding: 8px 14px; border-radius: 20px; color: var(--primaria); font-weight: 600; cursor: pointer; }
</style>
