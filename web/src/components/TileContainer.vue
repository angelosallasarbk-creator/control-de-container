<script setup>
import { computed } from "vue";
import { ROTULO_STATUS, ROTULO_TIPO, fmtHoras, fmtTemp, fmtMoeda } from "../formato.js";

const props = defineProps({ c: { type: Object, required: true } });

const estadiaPct = computed(() => Math.min(100, props.c.estadia?.percentualConsumido ?? 0));
const textoDemurrage = computed(() => {
  const d = props.c.demurrage;
  if (!d) return null;
  if (d.diasExcedidos > 0) return `${d.diasExcedidos} diária(s) · ${fmtMoeda(d.custo, d.moeda)}`;
  return d.diasRestantes === 0 ? "último dia livre" : `${d.diasRestantes} dia(s) livre(s)`;
});
</script>

<template>
  <div class="tile" :class="c.semaforo" @click="$router.push(`/containers/${c.id}`)">
    <div class="linha-entre">
      <span class="num mono">{{ c.numero }}</span>
      <span v-if="c.alertas.CRITICO" class="chip vermelho" title="Alertas críticos abertos">⚠ {{ c.alertas.CRITICO }}</span>
      <span v-else-if="c.alertas.ATENCAO" class="chip amarelo" title="Alertas de atenção abertos">{{ c.alertas.ATENCAO }}</span>
    </div>
    <div class="linha-tile mudo">
      <span>{{ ROTULO_TIPO[c.tipo] }} · {{ c.armador }}</span>
      <span v-if="c.posicaoPatio">📍 {{ c.posicaoPatio }}</span>
    </div>
    <div class="linha-tile"><span class="chip azul">{{ ROTULO_STATUS[c.status] }}</span></div>

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
  </div>
</template>
