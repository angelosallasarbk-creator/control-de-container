<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import { ROTULO_STATUS, ROTULO_TIPO, fmtMoeda, fmtDataHora, fmtData } from "../formato.js";
import { resumir, serieTendencia, impactos, emReais, fmtPorMoeda, moedasSemCotacao, totalContainer, somarEm } from "../custos.js";
import GraficoBarras from "../components/GraficoBarras.vue";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

// Cores fixas por significado (validadas para daltonismo como par adjacente).
const COR_ESTADIA = "#2a78d6";
const COR_DEMURRAGE = "#eb6834";

const dados = ref(null);
const erro = ref(null);
const carregando = ref(false);

// ---------- Período ----------
const PRESETS = [
  { chave: "30", rotulo: "Últimos 30 dias" },
  { chave: "90", rotulo: "Últimos 90 dias" },
  { chave: "180", rotulo: "Últimos 6 meses" },
  { chave: "365", rotulo: "Últimos 12 meses" },
  { chave: "mes", rotulo: "Este mês" },
  { chave: "mesAnterior", rotulo: "Mês anterior" },
  { chave: "custom", rotulo: "Personalizado" },
];
const hojeBrasilia = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const somarDias = (dia, n) => new Date(Date.parse(`${dia}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const preset = ref(route.query.periodo ?? "90");
const de = ref(route.query.de ?? "");
const ate = ref(route.query.ate ?? "");

function aplicarPreset() {
  const hoje = hojeBrasilia();
  if (preset.value === "custom") return;
  if (preset.value === "mes") {
    de.value = `${hoje.slice(0, 8)}01`;
    ate.value = hoje;
  } else if (preset.value === "mesAnterior") {
    const fimAnterior = somarDias(`${hoje.slice(0, 8)}01`, -1);
    de.value = `${fimAnterior.slice(0, 8)}01`;
    ate.value = fimAnterior;
  } else {
    ate.value = hoje;
    de.value = somarDias(hoje, -(Number(preset.value) - 1));
  }
}

async function carregar() {
  if (preset.value !== "custom") aplicarPreset();
  if (!de.value || !ate.value) return;
  carregando.value = true;
  try {
    dados.value = await api.custos({ de: de.value, ate: ate.value });
    erro.value = null;
    router.replace({ query: { ...route.query, periodo: preset.value, ...(preset.value === "custom" ? { de: de.value, ate: ate.value } : { de: undefined, ate: undefined }) } });
  } catch (e) {
    erro.value = e.message;
  } finally {
    carregando.value = false;
  }
}
onMounted(carregar);

// ---------- Grupos e abas ----------
const gruposPorId = computed(() => new Map((dados.value?.grupos ?? []).map((g) => [g.id, g])));
const gruposComCusto = computed(() => new Set((dados.value?.containers ?? []).map((c) => c.grupoId)));
// Grupo inativo só aparece se teve operação no período.
const gruposVisiveis = computed(() => (dados.value?.grupos ?? []).filter((g) => g.ativo || g.containersNoPeriodo > 0 || gruposComCusto.value.has(g.id)));
const chaveRegiao = (g) => (g.regiao ? String(g.regiao.id) : "sem");

const abasRegiao = computed(() => {
  if (!dados.value) return [];
  const regioes = new Map(dados.value.regioes.map((r) => [String(r.id), r.nome]));
  for (const g of gruposVisiveis.value) if (g.regiao) regioes.set(String(g.regiao.id), g.regiao.nome);
  const lista = [...regioes].map(([chave, nome]) => ({ chave, nome })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  if (gruposVisiveis.value.some((g) => !g.regiao)) lista.push({ chave: "sem", nome: "Sem região" });
  return [{ chave: "todas", nome: "Todas" }, ...lista].map((a) => {
    const ids = gruposVisiveis.value.filter((g) => a.chave === "todas" || chaveRegiao(g) === a.chave).map((g) => g.id);
    const r = resumir(dados.value, ids);
    return { ...a, ids, rotuloValor: r.totalReais !== null ? fmtMoeda(r.totalReais) : fmtPorMoeda(r.total), temCusto: r.containersComCusto > 0 };
  });
});
const regiaoAtual = computed(() => {
  const pedida = route.query.regiao ?? "todas";
  return abasRegiao.value.some((a) => a.chave === pedida) ? pedida : "todas";
});
const gruposDaRegiao = computed(() => gruposVisiveis.value.filter((g) => regiaoAtual.value === "todas" || chaveRegiao(g) === regiaoAtual.value));

const grupoAtual = computed(() => {
  const pedido = route.query.grupo ?? "geral";
  return gruposDaRegiao.value.some((g) => String(g.id) === pedido) ? pedido : "geral";
});
const selecionar = (query) => router.replace({ query: { ...route.query, ...query } });

const escopoIds = computed(() => (grupoAtual.value === "geral" ? gruposDaRegiao.value.map((g) => g.id) : [Number(grupoAtual.value)]));
const nomeEscopo = computed(() => {
  if (grupoAtual.value !== "geral") {
    const g = gruposPorId.value.get(Number(grupoAtual.value));
    return `${g.cliente} / ${g.fabrica}`;
  }
  return abasRegiao.value.find((a) => a.chave === regiaoAtual.value)?.nome ?? "Todas";
});

// ---------- Números do escopo ----------
const resumo = computed(() => (dados.value ? resumir(dados.value, escopoIds.value) : null));
const consolidado = computed(() => resumo.value?.totalReais !== null && resumo.value?.totalReais !== undefined);
const faltaCotacao = computed(() => (resumo.value ? moedasSemCotacao(resumo.value.total, dados.value.cotacoes) : []));

const tendencia = computed(() => (dados.value ? serieTendencia(dados.value, escopoIds.value) : null));
const graficosTendencia = computed(() => {
  if (!tendencia.value) return [];
  const { baldes } = tendencia.value;
  const rotulos = baldes.map((b) => b.rotulo);
  const cot = dados.value.cotacoes;
  if (consolidado.value) {
    return [{
      titulo: "Custo estimado por período (R$)", moeda: "BRL", rotulos,
      series: [
        { nome: "Estadia", cor: COR_ESTADIA, valores: baldes.map((b) => emReais(b.estadia, cot) ?? 0) },
        { nome: "Demurrage", cor: COR_DEMURRAGE, valores: baldes.map((b) => emReais(b.demurrage, cot) ?? 0) },
      ],
    }];
  }
  // Sem cotação: um gráfico por moeda (nunca dois eixos no mesmo gráfico).
  const graficos = [];
  const moedasEstadia = Object.keys(resumo.value.estadia);
  const moedasDemurrage = Object.keys(resumo.value.demurrage);
  for (const m of new Set([...moedasEstadia, ...moedasDemurrage])) {
    const series = [];
    if (moedasEstadia.includes(m)) series.push({ nome: "Estadia", cor: COR_ESTADIA, valores: baldes.map((b) => b.estadia[m] ?? 0) });
    if (moedasDemurrage.includes(m)) series.push({ nome: "Demurrage", cor: COR_DEMURRAGE, valores: baldes.map((b) => b.demurrage[m] ?? 0) });
    graficos.push({ titulo: `Custo estimado por período (${m})`, moeda: m, rotulos, series });
  }
  return graficos;
});

// Custo por Cliente/Fábrica (visão geral da região)
const porGrupo = computed(() => {
  if (!dados.value || grupoAtual.value !== "geral") return [];
  return gruposDaRegiao.value
    .map((g) => ({ g, r: resumir(dados.value, [g.id]) }))
    .sort((a, b) => (b.r.totalReais ?? 0) - (a.r.totalReais ?? 0) || b.r.estadiaHoras + b.r.diarias - (a.r.estadiaHoras + a.r.diarias));
});
const graficoPorGrupo = computed(() => {
  const comCusto = porGrupo.value.filter((x) => x.r.containersComCusto > 0);
  if (!consolidado.value || comCusto.length < 2) return null;
  return {
    rotulos: comCusto.map((x) => `${x.g.cliente} / ${x.g.fabrica}`),
    series: [
      { nome: "Estadia", cor: COR_ESTADIA, valores: comCusto.map((x) => x.r.estadiaReais ?? 0) },
      { nome: "Demurrage", cor: COR_DEMURRAGE, valores: comCusto.map((x) => x.r.demurrageReais ?? 0) },
    ],
  };
});

const listaImpactos = computed(() => (dados.value ? impactos(dados.value, escopoIds.value, gruposPorId.value) : []));

// ---------- Detalhamento ----------
const ordem = ref("total");
const detalhamento = computed(() => {
  if (!dados.value) return [];
  const ids = new Set(escopoIds.value);
  const cot = dados.value.cotacoes;
  const linhas = dados.value.containers.filter((c) => ids.has(c.grupoId)).map((c) => ({ ...c, totalReais: totalContainer(c, cot), grupo: gruposPorId.value.get(c.grupoId) }));
  const chave = {
    total: (c) => c.totalReais ?? c.estadiaValor + c.demurrageValor,
    estadia: (c) => c.estadiaHoras,
    demurrage: (c) => c.diarias,
  }[ordem.value];
  return linhas.sort((a, b) => chave(b) - chave(a));
});

// Mostra os mais relevantes primeiro; o CSV sempre leva todos.
const LIMITE_INICIAL = 15;
const mostrarTodos = ref(false);
const linhasVisiveis = computed(() => (mostrarTodos.value ? detalhamento.value : detalhamento.value.slice(0, LIMITE_INICIAL)));
watch([escopoIds, ordem], () => (mostrarTodos.value = false));

const fmtH = (h) => (h ? `${String(h).replace(".", ",")}h` : "—");
const fmtDias = (h) => (h === null || h === undefined ? "—" : `${(h / 24).toFixed(1).replace(".", ",")}d`);

function exportarCsv() {
  const num = (v) => (v === null || v === undefined ? "" : String(v).replace(".", ","));
  const cab = ["Container", "Tipo", "Cliente", "Fábrica", "Região", "Armador", "Etapa", "Coleta", "Chegada fábrica", "Saída fábrica", "Entrega porto",
    "Horas além da meta", "Custo estadia", "Moeda estadia", "Diárias demurrage", "Custo demurrage", "Moeda demurrage", "Total estimado (R$)"];
  const linhas = detalhamento.value.map((c) => [
    c.numero, ROTULO_TIPO[c.tipo], c.grupo.cliente, c.grupo.fabrica, c.grupo.regiao?.nome ?? "", c.armador, ROTULO_STATUS[c.status],
    fmtDataHora(c.coletadoEm), fmtDataHora(c.chegadaFabricaEm), fmtDataHora(c.saidaFabricaEm), fmtDataHora(c.entreguePortoEm),
    num(c.estadiaHoras), num(c.estadiaValor), c.estadiaMoeda, c.diarias, num(c.demurrageValor), c.demurrageMoeda, num(c.totalReais),
  ]);
  const csv = [cab, ...linhas].map((l) => l.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `custo-estimado_${dados.value.de}_a_${dados.value.ate}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

watch(preset, (p) => {
  if (p !== "custom") carregar();
});
</script>

<template>
  <div class="card filtros">
    <div class="campo">
      <label>Período</label>
      <select v-model="preset">
        <option v-for="p in PRESETS" :key="p.chave" :value="p.chave">{{ p.rotulo }}</option>
      </select>
    </div>
    <template v-if="preset === 'custom'">
      <div class="campo"><label>De</label><input v-model="de" type="date" /></div>
      <div class="campo"><label>Até</label><input v-model="ate" type="date" /></div>
      <button class="primario" :disabled="carregando" @click="carregar">Aplicar</button>
    </template>
    <span v-if="dados" class="mudo pequeno" style="padding-bottom: 8px">
      {{ fmtData(`${dados.de}T12:00:00Z`) }} a {{ fmtData(`${dados.ate}T12:00:00Z`) }} · custo lançado no dia em que ocorre · containers ativos contam até agora
    </span>
  </div>

  <div v-if="erro" class="erro">{{ erro }}</div>
  <div v-if="!dados && !erro" class="vazio">Calculando custos…</div>

  <template v-if="dados">
    <nav class="abas" role="tablist" aria-label="Regiões">
      <button
        v-for="a in abasRegiao" :key="a.chave" role="tab" class="aba" :class="{ ativa: a.chave === regiaoAtual }"
        :aria-selected="a.chave === regiaoAtual" @click="selecionar({ regiao: a.chave, grupo: 'geral' })"
      >
        {{ a.nome }} <span class="aba-contagem">{{ a.rotuloValor }}</span>
      </button>
    </nav>
    <nav class="abas sub" role="tablist" aria-label="Cliente / Fábrica">
      <button class="aba" :class="{ ativa: grupoAtual === 'geral' }" @click="selecionar({ grupo: 'geral' })">Visão geral</button>
      <button
        v-for="g in gruposDaRegiao" :key="g.id" class="aba" :class="{ ativa: grupoAtual === String(g.id) }"
        @click="selecionar({ grupo: String(g.id) })"
      >
        {{ g.cliente }} / {{ g.fabrica }}
      </button>
    </nav>

    <div v-if="faltaCotacao.length" class="aviso">
      Há custo em {{ faltaCotacao.join(", ") }} sem cotação cadastrada, então os valores aparecem separados por moeda e não somados em R$.
      <router-link v-if="auth.pode('administrar')" to="/configuracoes">Informar cotação em Configurações</router-link>
      <span v-else>Peça a um administrador para informar a cotação em Configurações.</span>
    </div>

    <!-- Indicadores -->
    <div class="kpis">
      <div class="kpi">
        <div class="rotulo">Custo total estimado · {{ nomeEscopo }}</div>
        <div class="valor" style="font-size: 22px">{{ consolidado ? fmtMoeda(resumo.totalReais) : fmtPorMoeda(resumo.total) }}</div>
      </div>
      <div class="kpi">
        <div class="rotulo"><span class="ponto" :style="{ background: COR_ESTADIA }"></span> Estadia</div>
        <div class="valor" style="font-size: 20px">{{ fmtPorMoeda(resumo.estadia) }}</div>
        <div class="pequeno mudo">{{ fmtH(resumo.estadiaHoras) }} além da meta</div>
      </div>
      <div class="kpi">
        <div class="rotulo"><span class="ponto" :style="{ background: COR_DEMURRAGE }"></span> Demurrage</div>
        <div class="valor" style="font-size: 20px">{{ fmtPorMoeda(resumo.demurrage) }}</div>
        <div class="pequeno mudo">{{ resumo.diarias }} diária(s)</div>
      </div>
      <div class="kpi">
        <div class="rotulo">Containers com custo</div>
        <div class="valor">{{ resumo.containersComCusto }} <span class="mudo" style="font-size: 14px">de {{ resumo.containersNoPeriodo }}</span></div>
        <div class="pequeno mudo">que operaram no período</div>
      </div>
    </div>

    <!-- Tendência + impactos -->
    <div class="dois-col">
      <div class="card">
        <template v-for="gr in graficosTendencia" :key="gr.titulo">
          <h2>{{ gr.titulo }}</h2>
          <GraficoBarras :rotulos="gr.rotulos" :series="gr.series" :moeda="gr.moeda" />
        </template>
        <div v-if="!graficosTendencia.length || !resumo.containersComCusto" class="vazio">Nenhum custo estimado neste período. 👍</div>
        <div class="mudo pequeno" style="margin-top: 6px">Agrupado por {{ { dia: "dia", semana: "semana", mes: "mês" }[tendencia.granularidade] }}.</div>
      </div>

      <div class="card">
        <h2>Principais impactos</h2>
        <ul v-if="listaImpactos.length" class="impactos">
          <li v-for="(i, n) in listaImpactos" :key="n" :class="`impacto-${i.nivel}`">{{ i.texto }}</li>
        </ul>
        <div v-else class="vazio">Sem custos no período para analisar.</div>
      </div>
    </div>

    <!-- Por Cliente/Fábrica -->
    <div v-if="grupoAtual === 'geral' && porGrupo.length" class="card">
      <h2>Custo por Cliente / Fábrica</h2>
      <GraficoBarras
        v-if="graficoPorGrupo" :rotulos="graficoPorGrupo.rotulos" :series="graficoPorGrupo.series" horizontal
        :altura="Math.max(140, graficoPorGrupo.rotulos.length * 44 + 60)"
      />
      <div class="tabela-wrap" style="margin-top: 12px">
        <table>
          <thead>
            <tr>
              <th>Cliente / Fábrica</th><th v-if="regiaoAtual === 'todas'">Região</th><th>Containers c/ custo</th>
              <th>Horas além da meta</th><th>Estadia</th><th>Diárias</th><th>Demurrage</th><th>Total</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="{ g, r } in porGrupo" :key="g.id" class="clicavel" @click="selecionar({ grupo: String(g.id) })">
              <td class="negrito">{{ g.cliente }} / {{ g.fabrica }}</td>
              <td v-if="regiaoAtual === 'todas'">{{ g.regiao?.nome ?? "—" }}</td>
              <td>{{ r.containersComCusto }} de {{ r.containersNoPeriodo }}</td>
              <td>{{ fmtH(r.estadiaHoras) }}<span v-if="r.horasSemValor" class="chip amarelo" title="Sem custo/h cadastrado" style="margin-left: 6px">sem R$/h</span></td>
              <td>{{ fmtPorMoeda(r.estadia) }}</td>
              <td>{{ r.diarias }}</td>
              <td>{{ fmtPorMoeda(r.demurrage) }}</td>
              <td class="negrito">{{ r.totalReais !== null ? fmtMoeda(r.totalReais) : fmtPorMoeda(r.total) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Detalhamento -->
    <div class="card">
      <div class="linha-entre" style="margin-bottom: 10px">
        <h2 style="margin: 0">Detalhamento por container ({{ detalhamento.length }})</h2>
        <div class="linha">
          <label class="pequeno mudo">Ordenar por</label>
          <select v-model="ordem" style="width: auto">
            <option value="total">Maior custo</option>
            <option value="estadia">Mais horas além da meta</option>
            <option value="demurrage">Mais diárias</option>
          </select>
          <button :disabled="!detalhamento.length" @click="exportarCsv">Exportar CSV</button>
        </div>
      </div>
      <div class="tabela-wrap">
        <table class="pequeno">
          <thead>
            <tr>
              <th>Container</th><th v-if="grupoAtual === 'geral'">Cliente / Fábrica</th><th>Armador</th><th>Etapa</th>
              <th title="Coleta → chegada na fábrica">Até fábrica</th><th title="Chegada → saída">Na fábrica</th><th title="Saída → entrega no porto">Até porto</th>
              <th>Horas além da meta</th><th>Estadia</th><th>Diárias</th><th>Demurrage</th><th>Total</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in linhasVisiveis" :key="c.id" class="clicavel" @click="router.push(`/containers/${c.id}`)">
              <td class="mono negrito">{{ c.numero }}<div class="mudo">{{ ROTULO_TIPO[c.tipo] }}</div></td>
              <td v-if="grupoAtual === 'geral'">{{ c.grupo.cliente }} / {{ c.grupo.fabrica }}</td>
              <td>{{ c.armador }}</td>
              <td><span class="chip azul">{{ ROTULO_STATUS[c.status] }}</span></td>
              <td>{{ fmtDias(c.tempos.ateFabrica) }}</td>
              <td :class="c.estadiaHoras ? 'txt-VENCIDO' : ''">{{ fmtDias(c.tempos.naFabrica) }}<div class="mudo">meta {{ c.metaEstadiaHoras }}h</div></td>
              <td>{{ fmtDias(c.tempos.atePorto) }}</td>
              <td>{{ fmtH(c.estadiaHoras) }}</td>
              <td>{{ c.semCustoHora && c.estadiaHoras ? "sem R$/h" : fmtMoeda(c.estadiaValor, c.estadiaMoeda) }}</td>
              <td>{{ c.diarias || "—" }}<div v-if="c.diarias" class="mudo">free time {{ c.freeTimeDias }}d</div></td>
              <td>{{ c.diarias ? fmtMoeda(c.demurrageValor, c.demurrageMoeda) : "—" }}</td>
              <td class="negrito">{{ c.totalReais !== null ? fmtMoeda(c.totalReais) : fmtPorMoeda(somarEm(somarEm({}, { [c.estadiaMoeda]: c.estadiaValor }), { [c.demurrageMoeda]: c.demurrageValor })) }}</td>
            </tr>
            <tr v-if="!detalhamento.length"><td colspan="12" class="vazio">Nenhum container gerou custo neste período.</td></tr>
          </tbody>
        </table>
      </div>
      <div v-if="detalhamento.length > LIMITE_INICIAL" style="text-align: center; margin-top: 10px">
        <button class="pequeno" @click="mostrarTodos = !mostrarTodos">
          {{ mostrarTodos ? `Mostrar só os ${LIMITE_INICIAL} maiores` : `Mostrar todos (${detalhamento.length})` }}
        </button>
      </div>
      <div class="mudo pequeno" style="margin-top: 8px">
        Valores estimados a partir das datas registradas e dos parâmetros de cada container (free time, diária, meta e custo/h). Containers cancelados não entram.
      </div>
    </div>
  </template>
</template>
