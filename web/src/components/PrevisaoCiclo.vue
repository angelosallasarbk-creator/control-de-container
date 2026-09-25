<script setup>
import { computed } from "vue";
import { fmtDataHora, fmtHoras, fmtKm, fmtFolga, fmtMoeda } from "../formato.js";

// p = situacao.previsao (backend: estimativa.estimarCiclo) ou resposta de /rotas/estimar.
const props = defineProps({
  p: { type: Object, default: null },
  freeTimeDias: { type: Number, default: null },
  compacto: { type: Boolean, default: false },
});

const COR = { OK: "verde", ATENCAO: "amarelo", CRITICO: "vermelho" };
const TEXTO_RISCO = { OK: "Sem risco", ATENCAO: "Atenção", CRITICO: "Risco alto" };
const FONTE = {
  ORS: "rota de caminhão",
  ESTIMADA: "aproximada (linha reta)",
  HISTORICO: "histórico real",
  META: "meta de estadia",
};

const cicloDias = computed(() => (props.p?.cicloHoras ?? 0) / 24);
// Distância total prevista do ciclo = soma dos trechos rodoviários (vazio + cheio).
const trechosKm = computed(() => (props.p?.trechos ?? []).filter((t) => t.km !== null && t.km !== undefined));
// Soma os km já arredondados de cada trecho, para o total bater com "178 km + 178 km" da tela.
const kmTotal = computed(() => trechosKm.value.reduce((soma, t) => soma + Math.round(Number(t.km)), 0));
const detalheKm = computed(() => trechosKm.value.map((t) => `${t.etapa}: ${fmtKm(t.km)}`).join(" | "));
const kmAproximado = computed(() => trechosKm.value.some((t) => t.fonte === "ESTIMADA"));
</script>

<template>
  <div v-if="p && !p.disponivel" class="aviso pequeno">
    Sem previsão de rota: falta {{ p.faltando.join(", ") }}.
  </div>
  <div v-else-if="p" class="previsao">
    <div class="linha" style="gap: 8px; flex-wrap: wrap">
      <span class="chip" :class="COR[p.riscoDemurrage]">Demurrage: {{ TEXTO_RISCO[p.riscoDemurrage] }}</span>
      <span v-if="p.riscoDeadline" class="chip" :class="COR[p.riscoDeadline]">Deadline: {{ TEXTO_RISCO[p.riscoDeadline] }}</span>
      <span class="mudo pequeno">
        {{ p.hipotetico ? "Simulação: se coletar agora" : "Previsão atualizada com as etapas já registradas" }}
      </span>
    </div>

    <div class="numeros">
      <div>
        <div class="rotulo">Ciclo estimado</div>
        <div class="valor">{{ cicloDias.toFixed(1).replace(".", ",") }} dias</div>
        <div v-if="freeTimeDias !== null" class="pequeno mudo">free time: {{ freeTimeDias }} dias</div>
      </div>
      <div v-if="trechosKm.length">
        <div class="rotulo">Distância total prevista</div>
        <div class="valor">{{ fmtKm(kmTotal) }}</div>
        <div class="pequeno mudo" :title="detalheKm">
          {{ trechosKm.map((t) => fmtKm(t.km)).join(" + ") }}<template v-if="kmAproximado"> · aproximada</template>
        </div>
      </div>
      <div>
        <div class="rotulo">Entrega prevista</div>
        <div class="valor">{{ fmtDataHora(p.previsaoEntrega) }}</div>
        <div class="pequeno mudo">último dia livre: {{ fmtDataHora(p.vencimentoFreeTime) }}</div>
      </div>
      <div>
        <div class="rotulo">Folga até o fim do free time</div>
        <div class="valor" :class="`txt-${p.riscoDemurrage === 'CRITICO' ? 'VENCIDO' : p.riscoDemurrage}`">{{ fmtFolga(p.folgaHoras) }}</div>
        <div v-if="p.diasDemurragePrevistos" class="pequeno txt-VENCIDO">
          ~{{ p.diasDemurragePrevistos }} diária(s) · {{ fmtMoeda(p.custoPrevisto, p.moeda) }}
        </div>
      </div>
      <div v-if="p.folgaDeadlineHoras !== null">
        <div class="rotulo">Folga até o deadline</div>
        <div class="valor" :class="`txt-${p.riscoDeadline === 'CRITICO' ? 'VENCIDO' : p.riscoDeadline}`">{{ fmtFolga(p.folgaDeadlineHoras) }}</div>
        <div v-if="p.limiteColeta" class="pequeno mudo">coletar até {{ fmtDataHora(p.limiteColeta) }}</div>
      </div>
    </div>

    <table v-if="!compacto" class="pequeno">
      <thead><tr><th>Trecho</th><th>Distância / base</th><th>Duração</th><th>De → até</th><th></th></tr></thead>
      <tbody>
        <tr v-for="t in p.trechos" :key="t.etapa">
          <td class="negrito">{{ t.etapa }}</td>
          <td>
            <template v-if="t.km !== null">{{ fmtKm(t.km) }}</template>
            <template v-else-if="t.fonte">{{ fmtHoras(t.horas) }}</template>
            <template v-else>{{ fmtHoras(t.horas) }} (fila na entrega)</template>
            <div v-if="t.fonte" class="mudo">
              {{ FONTE[t.fonte] }}<template v-if="t.fonte === 'HISTORICO'"> ({{ t.amostras }} passagens)</template>
            </div>
          </td>
          <td>{{ fmtHoras(t.duracaoHoras) }}</td>
          <td>{{ fmtDataHora(t.inicio) }} → {{ fmtDataHora(t.fim) }}</td>
          <td><span v-if="t.real" class="chip verde">realizado</span></td>
        </tr>
      </tbody>
    </table>
    <div v-if="!compacto" class="mudo pequeno">
      Duração da estrada = distância pela regra de rodagem das Configurações (km por dia dentro da janela de horário); fora da janela o caminhão fica parado.
    </div>
  </div>
</template>

<style scoped>
.previsao { display: flex; flex-direction: column; gap: 12px; }
.numeros { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.numeros .rotulo { font-size: 12px; color: var(--texto-2); }
.numeros .valor { font-size: 18px; font-weight: 700; margin-top: 2px; }
</style>
