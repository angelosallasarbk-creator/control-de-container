<script setup>
import { nextTick, onMounted, ref } from "vue";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import CampoSenha from "../components/CampoSenha.vue";

// "Lembrar meu login": o navegador guarda SÓ o e-mail (nunca a senha). A sessão lembrada é
// um cookie httpOnly de 30 dias emitido pelo servidor, que o JavaScript da página não lê.
// A senha, se a pessoa quiser, fica com o gerenciador de senhas do próprio navegador.
const CHAVE_EMAIL_LEMBRADO = "cc_login_email";

const auth = useAuthStore();
const modo = ref("entrar"); // "entrar" | "esqueci"
const email = ref("");
const senha = ref("");
const lembrar = ref(false);
const erro = ref(null);
const aviso = ref(null);
const enviando = ref(false);
const refEmail = ref(null);
const refSenha = ref(null);

onMounted(async () => {
  try {
    const salvo = localStorage.getItem(CHAVE_EMAIL_LEMBRADO);
    if (salvo) {
      email.value = salvo;
      lembrar.value = true;
    }
  } catch {
    // sem armazenamento: só não lembra o e-mail
  }
  await nextTick();
  (email.value ? refSenha : refEmail).value?.focus();
});

function guardarEmail() {
  try {
    if (lembrar.value) localStorage.setItem(CHAVE_EMAIL_LEMBRADO, email.value.trim().toLowerCase());
    else localStorage.removeItem(CHAVE_EMAIL_LEMBRADO);
  } catch {
    // sem armazenamento
  }
}

async function entrar() {
  erro.value = null;
  aviso.value = null;
  enviando.value = true;
  try {
    await auth.login(email.value, senha.value, lembrar.value);
    guardarEmail();
  } catch (e) {
    erro.value = e.message;
  } finally {
    // A senha não fica na memória da página depois do envio (nem em caso de erro).
    senha.value = "";
    refSenha.value?.ocultar();
    enviando.value = false;
  }
}

// ---------- Esqueci minha senha ----------
function irPara(novo) {
  modo.value = novo;
  erro.value = null;
  aviso.value = null;
  senha.value = "";
  nextTick(() => (novo === "esqueci" ? refEmail : email.value ? refSenha : refEmail).value?.focus());
}

async function pedirLink() {
  erro.value = null;
  aviso.value = null;
  enviando.value = true;
  try {
    aviso.value = (await api.esqueciSenha(email.value)).mensagem;
  } catch (e) {
    erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}
</script>

<template>
  <div class="login-shell">
    <form class="login-card" method="post" autocomplete="on" @submit.prevent="modo === 'entrar' ? entrar() : pedirLink()">
      <svg width="56" height="56" viewBox="0 0 32 32" style="align-self: center" aria-hidden="true"><rect x="2" y="8" width="28" height="16" rx="2" fill="#1f5fa8" /><path d="M8 11v10M13 11v10M18 11v10M23 11v10" stroke="#fff" stroke-width="2" /></svg>
      <div class="marca">
        <div class="marca-sigla">CCS</div>
        <div class="marca-nome">Container Control Solutions</div>
      </div>
      <div class="login-subtitulo">{{ modo === "entrar" ? "Login" : "Esqueci minha senha" }}</div>
      <div v-if="erro" class="erro" role="alert">{{ erro }}</div>
      <div v-if="aviso" class="sucesso" role="status">{{ aviso }}</div>

      <div class="campo">
        <label for="email">E-mail</label>
        <input id="email" ref="refEmail" v-model="email" name="username" type="email" required autocomplete="username" autocapitalize="none" spellcheck="false" />
      </div>

      <template v-if="modo === 'entrar'">
        <div class="campo">
          <label for="senha">Senha</label>
          <CampoSenha id="senha" ref="refSenha" v-model="senha" />
        </div>
        <div class="linha-entre">
          <label class="lembrar">
            <input v-model="lembrar" type="checkbox" />
            <span>Lembrar meu login</span>
          </label>
          <button type="button" class="link pequeno" @click="irPara('esqueci')">Esqueci minha senha</button>
        </div>
        <button type="submit" class="primario" :disabled="enviando">{{ enviando ? "Entrando…" : "Entrar" }}</button>
        <div class="mudo pequeno" style="text-align: center">
          Lembrar mantém você conectado por 30 dias neste navegador. Não use em computador compartilhado.
        </div>
      </template>

      <template v-else>
        <p class="mudo pequeno" style="margin: 0">Informe o e-mail da sua conta. Enviaremos um link para você criar uma nova senha (válido por 30 minutos).</p>
        <button type="submit" class="primario" :disabled="enviando">{{ enviando ? "Enviando…" : "Enviar link" }}</button>
        <button type="button" class="link pequeno" style="align-self: center" @click="irPara('entrar')">← Voltar para o login</button>
      </template>
    </form>
  </div>
</template>

<style scoped>
.marca { text-align: center; }
.marca-sigla { font-size: 30px; font-weight: 800; letter-spacing: .06em; line-height: 1.1; }
.marca-nome { font-size: 13px; color: var(--texto-2); margin-top: 2px; letter-spacing: .02em; }
.login-subtitulo { text-align: center; font-size: 16px; font-weight: 600; margin-top: 4px; }
.lembrar { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 14px; }
.lembrar input { width: 16px; height: 16px; }
</style>
