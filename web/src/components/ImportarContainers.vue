<script setup>
// Upload da planilha de containers: escolhe o arquivo → prévia linha a linha → confirma.
// Só as linhas válidas são gravadas; as com erro ficam de fora (corrija e envie de novo).
import { computed, ref } from "vue";
import { api } from "../api.js";
import { ROTULO_TIPO } from "../formato.js";
import Icone from "./Icone.vue";

const emit = defineEmits(["fechar", "importados"]);
const arquivo = ref(null);
const previa = ref(null);
const resultado = ref(null);
const erro = ref(null);
const enviando = ref(false);
const soErros = ref(false);

const linhas = computed(() => {
  const l = (resultado.value ?? previa.value)?.linhas ?? [];
  return soErros.value ? l.filter((x) => x.erro) : l;
});

async function escolher(ev) {
  const f = ev.target.files?.[0];
  ev.target.value = "";
  previa.value = null;
  resultado.value = null;
  erro.value = null;
  soErros.value = false;
  if (!f) return;
  if (!/\.xlsx$/i.test(f.name)) {
    erro.value = "Escolha a planilha Excel (.xlsx) baixada em \"Baixar modelo\".";
    return;
  }
  arquivo.value = f;
  enviando.value = true;
  try {
    previa.value = await api.importarContainers(f);
    soErros.value = previa.value.comErro > 0 && previa.value.validos === 0;
  } catch (e) {
    erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}

async function confirmar() {
  enviando.value = true;
  erro.value = null;
  try {
    resultado.value = await api.importarContainers(arquivo.value, true);
    if (resultado.value.importados) emit("importados", resultado.value.importados);
  } catch (e) {
    erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}

async function baixarModelo() {
  try {
    await api.baixarModeloContainers();
  } catch (e) {
    erro.value = e.message;
  }
}
</script>

<template>
  <div class="fundo-modal" @mousedown.self="emit('fechar')">
    <div class="modal importar">
      <div class="linha-entre" style="gap: 8px; flex-wrap: wrap">
        <h2 style="margin: 0">Cadastrar containers por planilha</h2>
        <button type="button" class="pequeno" @click="baixarModelo"><Icone nome="download" :tamanho="15" /> Baixar modelo</button>
      </div>
      <p class="mudo pequeno" style="margin: 6px 0 12px">
        Preencha o modelo (uma linha por container) e envie aqui. Primeiro aparece a conferência de cada linha; nada é gravado até você confirmar.
        Só cadastra containers novos — número já ativo no sistema é recusado.
      </p>

      <div v-if="!resultado" class="linha" style="gap: 10px; flex-wrap: wrap">
        <label class="btn" :class="{ primario: !previa }">
          <Icone nome="upload" :tamanho="16" /> {{ previa ? "Escolher outro arquivo" : "Escolher planilha (.xlsx)" }}
          <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden :disabled="enviando" @change="escolher" />
        </label>
        <span v-if="arquivo" class="mudo pequeno">{{ arquivo.name }}</span>
      </div>

      <div v-if="enviando" class="vazio">{{ previa ? "Cadastrando…" : "Conferindo a planilha…" }}</div>
      <div v-if="erro" class="erro" role="alert" style="margin-top: 10px">{{ erro }}</div>

      <template v-if="(previa || resultado) && !enviando">
        <div v-if="resultado" class="sucesso" role="status" style="margin-top: 10px">
          {{ resultado.importados }} container(s) cadastrado(s).<template v-if="resultado.comErro"> {{ resultado.comErro }} linha(s) ficaram de fora — corrija na planilha e envie só essas de novo.</template>
        </div>
        <div v-else class="resumo-previa">
          <span class="chip verde">{{ previa.validos }} pronta(s) para cadastrar</span>
          <span v-if="previa.comErro" class="chip vermelho">{{ previa.comErro }} com erro</span>
          <label v-if="previa.comErro && previa.validos" class="pequeno linha" style="gap: 6px"><input v-model="soErros" type="checkbox" style="width: auto" /> Mostrar só as com erro</label>
        </div>

        <div class="tabela-wrap lista-previa">
          <table class="pequeno">
            <thead><tr><th>Linha</th><th>Container</th><th>Tipo</th><th>Situação</th></tr></thead>
            <tbody>
              <tr v-for="l in linhas" :key="l.linha" :class="{ 'com-erro': l.erro }">
                <td>{{ l.linha }}</td>
                <td class="mono negrito">{{ l.numero || "—" }}</td>
                <td>{{ ROTULO_TIPO[l.tipo] ?? "—" }}</td>
                <td>
                  <span v-if="l.erro" class="txt-VENCIDO">{{ l.erro }}</span>
                  <span v-else-if="l.importado" class="txt-OK">✓ Cadastrado</span>
                  <span v-else class="txt-OK">OK</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <div class="modal-acoes">
        <button type="button" @click="emit('fechar')">{{ resultado ? "Fechar" : "Cancelar" }}</button>
        <button v-if="previa && !resultado" type="button" class="primario" :disabled="enviando || !previa.validos" @click="confirmar">
          Cadastrar {{ previa.validos }} container(s)
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.importar { width: min(760px, 100%); }
.resumo-previa { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
.lista-previa { max-height: 46vh; overflow: auto; margin-top: 10px; border: 1px solid var(--borda); border-radius: 6px; }
.lista-previa table { margin: 0; }
.lista-previa thead th { position: sticky; top: 0; background: #fff; z-index: 1; }
tr.com-erro td { background: var(--vermelho-fundo); }
</style>
