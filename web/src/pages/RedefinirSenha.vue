<script setup>
// Página do link enviado por e-mail ("Esqueci minha senha"): cria a nova senha.
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import CampoSenha from "../components/CampoSenha.vue";

const props = defineProps({ codigo: { type: String, required: true } });
const router = useRouter();
const auth = useAuthStore();
const SENHA_MIN = 8;

const estado = ref("carregando"); // carregando | valido | invalido | concluido
const nome = ref("");
const senha = ref("");
const confirmacao = ref("");
const erro = ref(null);
const enviando = ref(false);

onMounted(async () => {
  try {
    const r = await api.conferirRedefinicao(props.codigo);
    estado.value = r.valido ? "valido" : "invalido";
    nome.value = r.nome ?? "";
  } catch (e) {
    estado.value = "invalido";
    erro.value = e.message;
  }
});

const problema = computed(() => {
  if (senha.value && senha.value.length < SENHA_MIN) return `A senha deve ter pelo menos ${SENHA_MIN} caracteres.`;
  if (confirmacao.value && confirmacao.value !== senha.value) return "As senhas não conferem.";
  return null;
});

async function salvar() {
  erro.value = null;
  if (problema.value || senha.value !== confirmacao.value) {
    erro.value = problema.value ?? "As senhas não conferem.";
    return;
  }
  enviando.value = true;
  try {
    await api.redefinirSenha(props.codigo, senha.value);
    estado.value = "concluido";
  } catch (e) {
    erro.value = e.message;
  } finally {
    // A senha não fica na memória da página depois do envio.
    senha.value = "";
    confirmacao.value = "";
    enviando.value = false;
  }
}

// Sessões antigas caíram com a redefinição: volta ao login limpo.
async function irParaLogin() {
  if (auth.usuario) await auth.logout();
  auth.usuario = null;
  router.replace("/");
}
</script>

<template>
  <div class="login-shell">
    <form class="login-card" autocomplete="on" @submit.prevent="salvar">
      <div class="marca">
        <div class="marca-sigla">CCS</div>
        <div class="marca-nome">Container Control Solutions</div>
      </div>
      <div class="login-subtitulo">Criar nova senha</div>

      <div v-if="estado === 'carregando'" class="vazio">Conferindo o link…</div>

      <template v-else-if="estado === 'invalido'">
        <div class="erro" role="alert">Este link é inválido, já foi usado ou expirou.</div>
        <p class="mudo pequeno" style="margin: 0">Peça um novo na tela de login, em "Esqueci minha senha". O link vale por 30 minutos e só pode ser usado uma vez.</p>
        <button type="button" class="primario" @click="irParaLogin">Ir para o login</button>
      </template>

      <template v-else-if="estado === 'concluido'">
        <div class="sucesso" role="status">Senha redefinida! Por segurança, todas as sessões abertas da sua conta foram encerradas.</div>
        <button type="button" class="primario" @click="irParaLogin">Entrar com a nova senha</button>
      </template>

      <template v-else>
        <p class="mudo" style="margin: 0">Olá, <strong>{{ nome }}</strong>. Escolha uma nova senha.</p>
        <div v-if="erro" class="erro" role="alert">{{ erro }}</div>
        <div class="campo">
          <label for="nova-senha">Nova senha</label>
          <CampoSenha id="nova-senha" v-model="senha" autocomplete="new-password" name="new-password" :minlength="SENHA_MIN" />
          <span class="dica">Mínimo de {{ SENHA_MIN }} caracteres.</span>
        </div>
        <div class="campo">
          <label for="confirmar-senha">Confirmar nova senha</label>
          <CampoSenha id="confirmar-senha" v-model="confirmacao" autocomplete="new-password" name="confirm-password" :minlength="SENHA_MIN" />
          <span v-if="problema" class="dica txt-VENCIDO">{{ problema }}</span>
        </div>
        <button type="submit" class="primario" :disabled="enviando || !!problema">{{ enviando ? "Salvando…" : "Salvar nova senha" }}</button>
      </template>
    </form>
  </div>
</template>

<style scoped>
.marca { text-align: center; }
.marca-sigla { font-size: 30px; font-weight: 800; letter-spacing: .06em; line-height: 1.1; }
.marca-nome { font-size: 13px; color: var(--texto-2); margin-top: 2px; letter-spacing: .02em; }
.login-subtitulo { text-align: center; font-size: 16px; font-weight: 600; margin-top: 4px; }
</style>
