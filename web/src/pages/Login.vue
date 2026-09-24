<script setup>
import { ref } from "vue";
import { useAuthStore } from "../stores/auth.js";

const auth = useAuthStore();
const email = ref("");
const senha = ref("");
const erro = ref(null);
const enviando = ref(false);

async function entrar() {
  erro.value = null;
  enviando.value = true;
  try {
    await auth.login(email.value, senha.value);
  } catch (e) {
    erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}
</script>

<template>
  <div class="login-shell">
    <form class="login-card" @submit.prevent="entrar">
      <svg width="56" height="56" viewBox="0 0 32 32" style="align-self: center" aria-hidden="true"><rect x="2" y="8" width="28" height="16" rx="2" fill="#1f5fa8" /><path d="M8 11v10M13 11v10M18 11v10M23 11v10" stroke="#fff" stroke-width="2" /></svg>
      <div class="login-titulo">Controle de Container</div>
      <div class="mudo" style="text-align: center">Entre com sua conta para continuar</div>
      <div v-if="erro" class="erro">{{ erro }}</div>
      <div class="campo">
        <label for="email">E-mail</label>
        <input id="email" v-model="email" type="email" required autofocus autocomplete="username" />
      </div>
      <div class="campo">
        <label for="senha">Senha</label>
        <input id="senha" v-model="senha" type="password" required autocomplete="current-password" />
      </div>
      <button type="submit" class="primario" :disabled="enviando">{{ enviando ? "Entrando…" : "Entrar" }}</button>
      <div class="mudo pequeno" style="text-align: center">Esqueceu a senha? Peça a um administrador para redefinir.</div>
    </form>
  </div>
</template>
