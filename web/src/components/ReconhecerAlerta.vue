<script setup>
import { ref } from "vue";
import { api } from "../api.js";
import { ROTULO_ALERTA } from "../formato.js";

const props = defineProps({ alerta: { type: Object, required: true } });
const emit = defineEmits(["fechar", "reconhecido"]);
const acao = ref("");
const erro = ref(null);
const enviando = ref(false);

async function salvar() {
  enviando.value = true;
  erro.value = null;
  try {
    emit("reconhecido", await api.reconhecerAlerta(props.alerta.id, acao.value));
  } catch (e) {
    erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}
</script>

<template>
  <div class="fundo-modal" @mousedown.self="emit('fechar')">
    <form class="modal estreito" @submit.prevent="salvar">
      <h2>Reconhecer alerta · {{ ROTULO_ALERTA[alerta.tipo] }}</h2>
      <div class="mudo">{{ alerta.mensagem }}</div>
      <div v-if="erro" class="erro">{{ erro }}</div>
      <div class="campo">
        <label>Ação tomada *</label>
        <textarea v-model="acao" rows="3" required maxlength="1000" placeholder="Ex.: acionei a doca 3 para priorizar a ovação"></textarea>
        <span class="dica">O alerta continua aberto enquanto a condição existir; reconhecer registra que alguém está tratando.</span>
      </div>
      <div class="modal-acoes">
        <button type="button" @click="emit('fechar')">Cancelar</button>
        <button type="submit" class="primario" :disabled="enviando">Registrar</button>
      </div>
    </form>
  </div>
</template>
