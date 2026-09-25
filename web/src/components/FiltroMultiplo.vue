<script setup>
// Lista suspensa com caixas de seleção. v-model = valores marcados (vazio = todos).
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps({
  rotulo: { type: String, required: true },
  opcoes: { type: Array, required: true }, // [{ valor, texto, detalhe? }]
  modelValue: { type: Array, default: () => [] },
  busca: { type: Boolean, default: false },
  todos: { type: String, default: "Todos" }, // texto sem nada marcado (ex.: "Todas" para Região)
});
const emit = defineEmits(["update:modelValue"]);

const aberto = ref(false);
const termo = ref("");
const raiz = ref(null);

const marcados = computed(() => new Set(props.modelValue));
const resumo = computed(() => {
  const n = props.modelValue.length;
  if (!n) return props.todos;
  if (n === 1) return props.opcoes.find((o) => o.valor === props.modelValue[0])?.texto ?? "1 selecionado";
  return `${n} selecionados`;
});
const visiveis = computed(() => {
  const t = termo.value.trim().toLowerCase();
  return t ? props.opcoes.filter((o) => `${o.texto} ${o.detalhe ?? ""}`.toLowerCase().includes(t)) : props.opcoes;
});

function alternar(valor) {
  const s = new Set(props.modelValue);
  s.has(valor) ? s.delete(valor) : s.add(valor);
  emit("update:modelValue", props.opcoes.map((o) => o.valor).filter((v) => s.has(v)));
}
const todos = () => emit("update:modelValue", visiveis.value.map((o) => o.valor));
const limpar = () => emit("update:modelValue", []);

const fecharFora = (e) => {
  if (aberto.value && !raiz.value?.contains(e.target)) aberto.value = false;
};
const fecharEsc = (e) => {
  if (e.key === "Escape") aberto.value = false;
};
onMounted(() => {
  document.addEventListener("mousedown", fecharFora);
  document.addEventListener("keydown", fecharEsc);
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", fecharFora);
  document.removeEventListener("keydown", fecharEsc);
});
</script>

<template>
  <div ref="raiz" class="filtro-multiplo">
    <button
      type="button" class="gatilho" :class="{ ativo: modelValue.length }" :aria-expanded="aberto" aria-haspopup="listbox"
      @click="aberto = !aberto"
    >
      <span class="rotulo">{{ rotulo }}:</span>
      <span class="resumo">{{ resumo }}</span>
      <span class="seta" aria-hidden="true">▾</span>
    </button>
    <div v-if="aberto" class="painel" role="listbox" :aria-label="rotulo" aria-multiselectable="true">
      <input v-if="busca" v-model="termo" class="busca" :placeholder="`Buscar ${rotulo.toLowerCase()}…`" />
      <div class="acoes">
        <button type="button" class="link" @click="todos">Selecionar todos</button>
        <button type="button" class="link" :disabled="!modelValue.length" @click="limpar">Limpar</button>
      </div>
      <div class="opcoes">
        <label v-for="o in visiveis" :key="o.valor" class="opcao">
          <input type="checkbox" :checked="marcados.has(o.valor)" @change="alternar(o.valor)" />
          <span>{{ o.texto }}<span v-if="o.detalhe" class="detalhe">{{ o.detalhe }}</span></span>
        </label>
        <div v-if="!visiveis.length" class="mudo pequeno" style="padding: 8px">Nada encontrado.</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filtro-multiplo { position: relative; }
.gatilho { gap: 6px; padding: 6px 12px; font-size: 13px; max-width: 280px; }
.gatilho.ativo { border-color: var(--primaria); background: var(--azul-fundo); }
.gatilho .rotulo { color: var(--texto-2); }
.gatilho .resumo { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.gatilho .seta { color: var(--texto-2); font-size: 11px; }
.painel {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 30; width: 320px; max-width: 90vw;
  background: var(--superficie); border: 1px solid var(--borda); border-radius: 10px; box-shadow: 0 10px 28px rgba(16, 24, 40, .16);
  padding: 10px; display: flex; flex-direction: column; gap: 8px;
}
.busca { width: 100%; }
.acoes { display: flex; justify-content: space-between; }
.acoes button { font-size: 12px; }
.opcoes { max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; }
.opcao { display: flex; align-items: flex-start; gap: 10px; padding: 7px 6px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.opcao:hover { background: var(--superficie-2); }
.opcao input { margin-top: 2px; width: 16px; height: 16px; flex-shrink: 0; }
.detalhe { display: block; font-size: 11px; color: var(--texto-2); }
</style>
