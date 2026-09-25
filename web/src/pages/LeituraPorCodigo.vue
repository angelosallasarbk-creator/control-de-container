<script setup>
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";

// Reserva ao QR: digita o código curto impresso na etiqueta (CC-XXXXXX) e segue para a
// mesma tela de leitura. Útil com etiqueta riscada/molhada ou QR que não abre.
const router = useRouter();
const auth = useAuthStore();
const transportador = auth.usuario?.perfil === "TRANSPORTADOR";
const codigo = ref("");
const erro = ref(null);
const buscando = ref(false);

async function abrir() {
  erro.value = null;
  buscando.value = true;
  try {
    const { token } = await api.qrPorCodigo(codigo.value);
    router.push(`/q/${token}`);
  } catch (e) {
    erro.value = e.message;
  } finally {
    buscando.value = false;
  }
}
</script>

<template>
  <div class="movel">
    <header class="movel-topo">
      <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="8" width="28" height="16" rx="2" fill="#4a8fdc" /><path d="M8 11v10M13 11v10M18 11v10M23 11v10" stroke="#fff" stroke-width="2" /></svg>
      <span class="espaco">Controle de Container</span>
      <span class="pequeno">{{ auth.usuario?.nome }}</span>
      <button v-if="transportador" type="button" class="pequeno sair" @click="auth.logout()">Sair</button>
    </header>
    <main class="movel-corpo">
      <form class="cartao" @submit.prevent="abrir">
        <h1>Registrar pelo código da etiqueta</h1>
        <p class="mudo" style="margin: 0">Use quando o QR não abrir: digite o código impresso embaixo/ao lado do QR.</p>
        <div v-if="erro" class="erro">{{ erro }}</div>
        <div class="campo">
          <label for="codigo">Código da etiqueta</label>
          <input
            id="codigo" v-model="codigo" class="mono grande-campo" placeholder="CC-7K3F9P" required maxlength="12"
            autocapitalize="characters" autocomplete="off" spellcheck="false" autofocus
          />
        </div>
        <button type="submit" class="primario bloco" :disabled="buscando">{{ buscando ? "Buscando…" : "Abrir etiqueta" }}</button>
        <p v-if="transportador" class="mudo pequeno" style="margin: 0; text-align: center">Aponte a câmera do celular para o QR da etiqueta — ou digite o código acima.</p>
        <router-link v-else to="/" class="btn bloco">Voltar ao sistema</router-link>
      </form>
    </main>
  </div>
</template>

<style scoped>
.movel { min-height: 100vh; background: var(--fundo); display: flex; flex-direction: column; }
.movel-topo { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: var(--lateral); color: #fff; font-weight: 700; }
.movel-corpo { padding: 16px; max-width: 520px; width: 100%; margin: 0 auto; }
.cartao { background: var(--superficie); border: 1px solid var(--borda); border-radius: 12px; padding: 18px; box-shadow: var(--sombra); display: flex; flex-direction: column; gap: 14px; }
.cartao h1 { font-size: 18px; }
.sair { background: transparent; color: #fff; border-color: rgba(255, 255, 255, .5); }
.grande-campo { font-size: 22px; padding: 12px; text-transform: uppercase; letter-spacing: .06em; }
button.bloco, .btn.bloco { width: 100%; justify-content: center; font-size: 18px; padding: 14px; border-radius: 10px; }
</style>
