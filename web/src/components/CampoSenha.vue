<script setup>
// Campo de senha com botão mostrar/ocultar (olho aberto = mostrar; olho cortado = ocultar).
import { ref } from "vue";

defineProps({
  modelValue: { type: String, default: "" },
  id: { type: String, required: true },
  autocomplete: { type: String, default: "current-password" },
  name: { type: String, default: "password" },
  minlength: { type: Number, default: null },
  obrigatorio: { type: Boolean, default: true },
});
const emit = defineEmits(["update:modelValue"]);
const visivel = ref(false);
const input = ref(null);
defineExpose({ focus: () => input.value?.focus(), ocultar: () => (visivel.value = false) });
</script>

<template>
  <div class="senha-caixa">
    <input
      :id="id" ref="input" :value="modelValue" :name="name" :type="visivel ? 'text' : 'password'" :required="obrigatorio" :minlength="minlength ?? undefined"
      :autocomplete="autocomplete" autocapitalize="none" spellcheck="false" @input="emit('update:modelValue', $event.target.value)"
    />
    <button
      type="button" class="olho" :aria-label="visivel ? 'Ocultar senha' : 'Mostrar senha'" :aria-pressed="visivel"
      :aria-controls="id" :title="visivel ? 'Ocultar senha' : 'Mostrar senha'" @click="visivel = !visivel"
    >
      <svg v-if="!visivel" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
      </svg>
      <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-3.2 4.1" /><path d="M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a10.4 10.4 0 0 0 5.4-1.6" />
        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /><path d="M3 3l18 18" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.senha-caixa { position: relative; display: flex; }
.senha-caixa input { flex: 1; padding-right: 44px; }
.olho {
  position: absolute; right: 4px; top: 50%; transform: translateY(-50%); border: none; background: none; padding: 6px;
  color: var(--texto-2); border-radius: 6px;
}
.olho:hover:not(:disabled) { background: var(--superficie-2); color: var(--texto); }
</style>
