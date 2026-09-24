<script setup>
import { onMounted, ref } from "vue";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import { fmtDataHora } from "../formato.js";

const auth = useAuthStore();
const intervalo = ref(null);
const logs = ref([]);
const erro = ref(null);
const salvo = ref(false);

onMounted(async () => {
  try {
    const [cfg, l] = await Promise.all([api.configuracao(), api.logs()]);
    intervalo.value = cfg.intervaloLeituraMinutos;
    logs.value = l;
  } catch (e) {
    erro.value = e.message;
  }
});

async function salvar() {
  erro.value = null;
  salvo.value = false;
  try {
    const cfg = await api.salvarConfiguracao({ intervaloLeituraMinutos: intervalo.value });
    intervalo.value = cfg.intervaloLeituraMinutos;
    salvo.value = true;
    logs.value = await api.logs();
  } catch (e) {
    erro.value = e.message;
  }
}
</script>

<template>
  <div v-if="erro" class="erro">{{ erro }}</div>
  <div class="card">
    <h2>Regras gerais</h2>
    <form class="filtros" @submit.prevent="salvar">
      <div class="campo" style="min-width: 280px">
        <label>Intervalo máximo entre leituras de temperatura (minutos)</label>
        <input v-model.number="intervalo" type="number" min="0" max="10080" required :disabled="!auth.pode('administrar')" />
        <span class="dica">
          Vale para reefer em ovação ou liberado. Passou disso sem leitura: alerta de Atenção; o dobro: Crítico. 0 desliga.
        </span>
      </div>
      <button v-if="auth.pode('administrar')" type="submit" class="primario">Salvar</button>
    </form>
    <div v-if="salvo" class="sucesso" style="margin-top: 10px">Configuração salva e alertas recalculados.</div>
  </div>

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
