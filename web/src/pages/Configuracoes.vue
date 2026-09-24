<script setup>
import { onMounted, reactive, ref } from "vue";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import { fmtDataHora } from "../formato.js";

const auth = useAuthStore();
const cfg = reactive({ intervaloLeituraMinutos: null, cotacaoUSD: 0, cotacaoEUR: 0 });
const logs = ref([]);
const erro = ref(null);
const salvo = ref(false);

onMounted(async () => {
  try {
    const [c, l] = await Promise.all([api.configuracao(), api.logs()]);
    Object.assign(cfg, c);
    logs.value = l;
  } catch (e) {
    erro.value = e.message;
  }
});

async function salvar() {
  erro.value = null;
  salvo.value = false;
  try {
    Object.assign(cfg, await api.salvarConfiguracao({ ...cfg }));
    salvo.value = true;
    logs.value = await api.logs();
  } catch (e) {
    erro.value = e.message;
  }
}
</script>

<template>
  <div v-if="erro" class="erro">{{ erro }}</div>
  <form class="card" @submit.prevent="salvar">
    <h2>Regras gerais</h2>
    <div class="grade-form">
      <div class="campo">
        <label>Intervalo máximo entre leituras de temperatura (minutos)</label>
        <input v-model.number="cfg.intervaloLeituraMinutos" type="number" min="0" max="10080" required :disabled="!auth.pode('administrar')" />
        <span class="dica">Vale para reefer em ovação ou liberado. Passou disso sem leitura: alerta de Atenção; o dobro: Crítico. 0 desliga.</span>
      </div>
      <div class="campo">
        <label>Cotação do dólar (R$ por US$ 1)</label>
        <input v-model="cfg.cotacaoUSD" type="number" min="0" step="0.0001" :disabled="!auth.pode('administrar')" />
        <span class="dica">Usada só para somar tudo em R$ no Custo estimado. 0 = não informada (valores ficam separados por moeda).</span>
      </div>
      <div class="campo">
        <label>Cotação do euro (R$ por € 1)</label>
        <input v-model="cfg.cotacaoEUR" type="number" min="0" step="0.0001" :disabled="!auth.pode('administrar')" />
        <span class="dica">Só se algum armador cobrar em euro.</span>
      </div>
    </div>
    <div v-if="auth.pode('administrar')" style="margin-top: 12px"><button type="submit" class="primario">Salvar</button></div>
    <div v-if="salvo" class="sucesso" style="margin-top: 10px">Configuração salva e alertas recalculados.</div>
  </form>

  <div class="card tabela-wrap">
    <h2>Log de auditoria (últimos 300 registros)</h2>
    <table class="pequeno">
      <thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Descrição</th></tr></thead>
      <tbody>
        <tr v-for="l in logs" :key="l.id">
          <td style="white-space: nowrap">{{ fmtDataHora(l.criadoEm) }}</td>
          <td>{{ l.usuarioEmail }}</td>
          <td>{{ l.acao }}</td>
          <td>{{ l.descricao }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
