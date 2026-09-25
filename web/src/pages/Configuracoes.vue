<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import { fmtDataHora, minutosParaHora, horaParaMinutos } from "../formato.js";

const auth = useAuthStore();
const cfg = reactive({ intervaloLeituraMinutos: null, cotacaoUSD: 0, cotacaoEUR: 0 });
// Janela de rodagem editada como "HH:MM" e gravada em minutos desde 00:00.
const inicioRodagem = ref("05:00");
const fimRodagem = ref("22:00");
const logs = ref([]);
const erro = ref(null);
const salvo = ref(false);

function aplicar(c) {
  Object.assign(cfg, c);
  inicioRodagem.value = minutosParaHora(c.rodagemInicioMin);
  fimRodagem.value = minutosParaHora(c.rodagemFimMin);
}

onMounted(async () => {
  try {
    const [c, l] = await Promise.all([api.configuracao(), api.logs()]);
    aplicar(c);
    logs.value = l;
  } catch (e) {
    erro.value = e.message;
  }
});

const janelaHoras = computed(() => (horaParaMinutos(fimRodagem.value) - horaParaMinutos(inicioRodagem.value)) / 60);
const mediaKmH = computed(() => (janelaHoras.value > 0 ? cfg.kmPorDia / janelaHoras.value : 0));

async function salvar() {
  erro.value = null;
  salvo.value = false;
  try {
    aplicar(await api.salvarConfiguracao({ ...cfg, rodagemInicioMin: horaParaMinutos(inicioRodagem.value), rodagemFimMin: horaParaMinutos(fimRodagem.value) }));
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

    <h2 style="margin-top: 20px">Previsão de rota</h2>
    <div class="mudo pequeno" style="margin: -6px 0 10px">
      Usada para prever a entrega no porto e o risco de demurrage. O caminhão só roda dentro da janela de horário (todos os dias,
      inclusive fim de semana e feriado) e faz no máximo os km por dia informados; fora da janela fica parado.
    </div>
    <div class="grade-form">
      <div class="campo">
        <label>Rodagem: início</label>
        <input v-model="inicioRodagem" type="time" required :disabled="!auth.pode('administrar')" />
      </div>
      <div class="campo">
        <label>Rodagem: fim</label>
        <input v-model="fimRodagem" type="time" required :disabled="!auth.pode('administrar')" />
      </div>
      <div class="campo">
        <label>Km máximos por dia</label>
        <input v-model.number="cfg.kmPorDia" type="number" min="50" max="2000" step="10" required :disabled="!auth.pode('administrar')" />
        <span class="dica">Janela de {{ janelaHoras }}h → média de {{ mediaKmH.toFixed(1).replace(".", ",") }} km/h rodando.</span>
      </div>
      <div class="campo">
        <label>Fila / gate padrão no porto (h)</label>
        <input v-model.number="cfg.filaPortoHorasPadrao" type="number" min="0" max="240" step="0.5" required :disabled="!auth.pode('administrar')" />
        <span class="dica">Cada porto pode ter o seu tempo em Locais.</span>
      </div>
      <div class="campo">
        <label>Alertar risco com folga menor que (h)</label>
        <input v-model.number="cfg.riscoFolgaHoras" type="number" min="0" max="720" step="1" required :disabled="!auth.pode('administrar')" />
        <span class="dica">Folga negativa = demurrage prevista (Crítico).</span>
      </div>
      <div class="campo">
        <label>Fator da estimativa em linha reta</label>
        <input v-model.number="cfg.fatorLinhaReta" type="number" min="1" max="3" step="0.05" required :disabled="!auth.pode('administrar')" />
        <span class="dica">Só quando o serviço de rota não responde: distância em linha reta × fator.</span>
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
