<script setup>
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth.js";
import { rotuloEtapa, ROTULO_TIPO, fmtHoras, fmtTemp, fmtMoeda, fmtFolga, fmtDataHora } from "../formato.js";

const props = defineProps({ c: { type: Object, required: true } });
const router = useRouter();
const auth = useAuthStore();
const abreFicha = computed(() => auth.usuario?.perfil !== "PORTARIA");
const abrir = () => abreFicha.value && router.push(`/containers/${props.c.id}`);

const estadiaPct = computed(() => Math.min(100, props.c.estadia?.percentualConsumido ?? 0));
const textoDemurrage = computed(() => {
  const d = props.c.demurrage;
  if (!d) return null;
  if (d.diasExcedidos > 0) return `${d.diasExcedidos} diária(s) · ${fmtMoeda(d.custo, d.moeda)}`;
  return d.diasRestantes === 0 ? "último dia livre" : `${d.diasRestantes} dia(s) livre(s)`;
});
</script>

<template>
  <div class="tile" :class="[c.semaforo, { consulta: !abreFicha }]" @click="abrir">
    <div class="linha-entre">
      <span class="num mono">{{ c.numero }}</span>
      <span v-if="c.alertas.CRITICO" class="chip vermelho" title="Alertas críticos abertos">⚠ {{ c.alertas.CRITICO }}</span>
      <span v-else-if="c.alertas.ATENCAO" class="chip amarelo" title="Alertas de atenção abertos">{{ c.alertas.ATENCAO }}</span>
    </div>
    <div class="linha-tile mudo">
      <span>{{ ROTULO_TIPO[c.tipo] }} · {{ c.armador }}</span>
      <span v-if="c.posicaoPatio" style="white-space: nowrap">📍 {{ c.posicaoPatio }}</span>
    </div>
    <div class="linha-tile"><span class="chip azul">{{ rotuloEtapa(c, c.status) }}</span></div>
    <div v-if="c.status === 'PROGRAMADO' && c.coletaProgramadaEm" class="linha-tile">
      <span>Coleta</span>
      <span :class="c.atrasoColeta ? `txt-${c.atrasoColeta.situacao}` : ''">
        {{ fmtDataHora(c.coletaProgramadaEm) }}<template v-if="c.atrasoColeta"> · ⏱ atrasada {{ fmtHoras(c.atrasoColeta.horasAtraso) }}</template>
      </span>
    </div>

    <template v-if="c.estadia && c.status !== 'SAIU_FABRICA'">
      <div class="linha-tile">
        <span>Estadia</span>
        <span :class="`txt-${c.estadia.situacao}`">{{ fmtHoras(c.estadia.horasDecorridas) }} / {{ c.estadia.metaHoras }}h</span>
      </div>
      <div class="barra" :class="c.estadia.situacao"><div :style="{ width: `${estadiaPct}%` }"></div></div>
    </template>
    <div v-if="textoDemurrage" class="linha-tile">
      <span>Demurrage</span>
      <span :class="`txt-${c.demurrage.situacao}`">{{ textoDemurrage }}</span>
    </div>
    <div v-if="c.temperatura" class="linha-tile">
      <span>Temperatura</span>
      <span v-if="c.temperatura.ultima" :class="c.temperatura.foraDaFaixa ? 'txt-VENCIDO' : 'txt-OK'">
        {{ fmtTemp(c.temperatura.ultima.temperatura) }}
      </span>
      <span v-else class="mudo">sem leitura</span>
    </div>
    <div v-if="c.temperatura?.semLeitura" class="linha-tile txt-ATENCAO"><span>⏱ leitura atrasada</span></div>
    <div v-if="c.previsao" class="linha-tile" :title="`Entrega prevista: ${fmtDataHora(c.previsao.previsaoEntrega)}`">
      <span>Previsão</span>
      <span :class="`txt-${c.previsao.riscoDemurrage === 'CRITICO' ? 'VENCIDO' : c.previsao.riscoDemurrage}`">
        <template v-if="c.previsao.riscoDemurrage === 'CRITICO'">⚠ ~{{ c.previsao.diasDemurragePrevistos }} diária(s)</template>
        <template v-else>folga {{ fmtFolga(c.previsao.folgaHoras) }}</template>
      </span>
    </div>
    <div v-if="c.previsao?.riscoDeadline === 'CRITICO'" class="linha-tile txt-VENCIDO"><span>⚠ risco de perder o deadline</span></div>
  </div>
</template>

<style scoped>
.tile.consulta { cursor: default; }
</style>
