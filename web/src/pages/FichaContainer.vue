<script setup>
// Visão "lista + detalhe": lista de containers à esquerda; à direita cabeçalho, faixas de
// alerta, indicadores do ciclo e abas (Visão geral, Etapas, Trajeto, Temperatura, Histórico).
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import {
  FLUXO, ROTULO_TIPO, ROTULO_ALERTA, rotuloEtapa, acaoEtapa, ehRetiradaEntrega, kmDoCiclo,
  fmtDataHora, fmtHoras, fmtKm, fmtFolga, fmtMoeda, fmtTemp, paraInputLocal, deInputLocal, tempoDesde,
} from "../formato.js";
import GraficoTemperatura from "../components/GraficoTemperatura.vue";
import PrevisaoCiclo from "../components/PrevisaoCiclo.vue";
import ReconhecerAlerta from "../components/ReconhecerAlerta.vue";
import ListaContainersLateral from "../components/ListaContainersLateral.vue";
import Icone from "../components/Icone.vue";
import NovoContainer from "../components/NovoContainer.vue";
import imagemContainer from "../assets/container.png";

// Sem id (/containers no modelo Grid): em tela larga abre o primeiro da lista; em tela estreita
// mostra a lista para escolher.
const props = defineProps({ id: { type: String, default: null } });
const router = useRouter();
const telaLarga = window.matchMedia("(min-width: 1101px)");
function aoCarregarLista(lista) {
  if (!props.id && telaLarga.matches && lista.length) router.replace(`/containers/${lista[0].id}`);
}
const novoAberto = ref(false);
function criado(x) {
  novoAberto.value = false;
  refLista.value?.carregar();
  if (x?.id) router.push(`/containers/${x.id}`);
}
const atualizarAlertas = inject("atualizarAlertas", () => {});
const auth = useAuthStore();

const c = ref(null);
const erro = ref(null);
const mensagem = ref(null);
const enviando = ref(false);
const modal = ref(null); // "avancar" | "cancelar" | "editar" | { alerta }
const refLista = ref(null);

const ORIGEM_LEITURA = { MANUAL: "Manual", INTEGRACAO: "Automática", QRCODE: "QR" };
const CAMPO_DATA = {
  COLETADO: "coletadoEm", NA_FABRICA: "chegadaFabricaEm", EM_OPERACAO: "inicioOperacaoEm",
  LIBERADO: "liberadoEm", SAIU_FABRICA: "saidaFabricaEm", ENTREGUE_PORTO: "entreguePortoEm",
};

async function carregar() {
  if (!props.id) return;
  try {
    c.value = await api.container(props.id);
    erro.value = null;
  } catch (e) {
    erro.value = e.message;
  }
}
onMounted(carregar);
// Trocar de container na lista não recria a tela (a lista mantém rolagem e filtro).
watch(() => props.id, () => {
  c.value = null;
  mensagem.value = null;
  modal.value = null;
  menuAberto.value = false;
  carregar();
});

// Executa uma ação que devolve o container atualizado.
async function executar(fn, sucesso) {
  enviando.value = true;
  erro.value = null;
  try {
    c.value = await fn();
    mensagem.value = sucesso;
    modal.value = null;
    atualizarAlertas();
    refLista.value?.carregar();
    setTimeout(() => (mensagem.value = null), 4000);
  } catch (e) {
    erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}

const encerrado = computed(() => ["ENTREGUE_PORTO", "CANCELADO"].includes(c.value?.status));
const proximo = computed(() => {
  const i = FLUXO.indexOf(c.value?.status);
  return i >= 0 && i < FLUXO.length - 1 ? FLUXO[i + 1] : null;
});
const s = computed(() => c.value?.situacao ?? {});
const p = computed(() => (s.value.previsao?.disponivel ? s.value.previsao : null));
const km = computed(() => kmDoCiclo(p.value));
const alertasAbertos = computed(() => (c.value?.alertas ?? []).filter((a) => a.chaveAberta));
const alertasEncerrados = computed(() => (c.value?.alertas ?? []).filter((a) => !a.chaveAberta));
const leiturasDesc = computed(() => [...(c.value?.leituras ?? [])].reverse().slice(0, 30));
const rota = computed(() => [c.value?.portoRetirada?.nome, c.value?.localCarregamento?.nome, c.value?.portoEntrega?.nome].filter(Boolean));
const RISCO = { OK: { texto: "Sem risco", cor: "verde" }, ATENCAO: { texto: "Atenção", cor: "amarelo" }, CRITICO: { texto: "Risco alto", cor: "vermelho" } };

// ----- Faixas de alerta no topo (o que exige ação agora) -----
const faixas = computed(() => {
  if (!c.value) return [];
  const x = s.value;
  const lista = [];
  if (x.atrasoColeta?.atrasada) {
    lista.push({
      nivel: x.atrasoColeta.situacao === "VENCIDO" ? "critico" : "atencao", icone: "relogio",
      // Sem local de retirada não há nome do tipo ("Coleta ferroviária"): usa "Coleta".
      titulo: `${c.value.rotulosEtapa?.COLETADO ?? "Coleta"} atrasada há ${fmtHoras(x.atrasoColeta.horasAtraso)}`,
      texto: `Programada para ${fmtDataHora(c.value.coletaProgramadaEm)}, ainda não registrada.`,
    });
  }
  const t = x.temperatura;
  if (t?.foraDaFaixa && t.ultima) {
    lista.push({
      nivel: t.nivelTemperatura === "ATENCAO" ? "atencao" : "critico", icone: "termometro",
      titulo: `Temperatura fora da faixa: ${fmtTemp(t.ultima.temperatura)}`,
      texto: `Última leitura há ${tempoDesde(t.ultima.lidaEm)} (${ORIGEM_LEITURA[t.ultima.origem]?.toLowerCase() ?? "—"}). Faixa aceita: ${fmtTemp(t.tempMin)} a ${fmtTemp(t.tempMax)} (setpoint ${fmtTemp(t.setpoint)}).`,
    });
  }
  if (t?.semLeitura) {
    lista.push({ nivel: t.nivelSemLeitura === "CRITICO" ? "critico" : "atencao", icone: "termometro", titulo: "Leitura de temperatura atrasada", texto: `Sem registro há ${fmtHoras(t.minutosSemLeitura / 60)}.` });
  }
  if (x.estadia && !x.estadia.encerrada && x.estadia.situacao !== "OK") {
    lista.push({
      nivel: x.estadia.situacao === "VENCIDO" ? "critico" : "atencao", icone: "armazem",
      titulo: x.estadia.situacao === "VENCIDO" ? `Meta de estadia estourada em ${fmtHoras(x.estadia.horasExcedidas)}` : `Meta de estadia vence em ${fmtHoras(x.estadia.horasRestantes)}`,
      texto: `Meta ${x.estadia.metaHoras}h · na fábrica há ${fmtHoras(x.estadia.horasDecorridas)}${x.estadia.custo ? ` · custo ${fmtMoeda(x.estadia.custo)}` : ""}.`,
    });
  }
  if (x.demurrage && !x.demurrage.encerrada && x.demurrage.situacao !== "OK") {
    lista.push({
      nivel: x.demurrage.situacao === "VENCIDO" ? "critico" : "atencao", icone: "folga",
      titulo: x.demurrage.situacao === "VENCIDO" ? `Demurrage: ${x.demurrage.diasExcedidos} diária(s) · ${fmtMoeda(x.demurrage.custo, x.demurrage.moeda)}` : "Free time terminando",
      texto: `Último dia livre: ${fmtDataHora(x.demurrage.vencimento)}.`,
    });
  }
  if (x.deadline && !x.deadline.encerrada && x.deadline.situacao !== "OK") {
    lista.push({
      nivel: x.deadline.situacao === "VENCIDO" ? "critico" : "atencao", icone: "navio",
      titulo: x.deadline.horasRestantes < 0 ? `Deadline do navio passou há ${fmtHoras(x.deadline.horasRestantes)}` : `Deadline do navio em ${fmtHoras(x.deadline.horasRestantes)}`,
      texto: `Cut-off: ${fmtDataHora(c.value.deadline)}.`,
    });
  }
  return lista;
});

// ----- Abas (a escolhida fica lembrada neste navegador) -----
const CHAVE_ABA = "cc_ficha_aba";
const abas = computed(() => [
  { chave: "geral", nome: "Visão geral" },
  { chave: "etapas", nome: "Etapas" },
  { chave: "trajeto", nome: "Trajeto" },
  ...(c.value?.reefer ? [{ chave: "temperatura", nome: "Temperatura" }] : []),
  { chave: "historico", nome: "Histórico" },
]);
const abaEscolhida = ref((() => {
  try {
    return localStorage.getItem(CHAVE_ABA) || "geral";
  } catch {
    return "geral";
  }
})());
const aba = computed(() => (abas.value.some((a) => a.chave === abaEscolhida.value) ? abaEscolhida.value : "geral"));
function irPara(chave) {
  abaEscolhida.value = chave;
  try {
    localStorage.setItem(CHAVE_ABA, chave);
  } catch {
    // sem armazenamento: só não lembra a aba
  }
}

// ----- Etapas: Planejado (plano congelado) × ETA (previsão atualizada) × Realizado -----
// Tolerância (Configurações → Geral): realizado até X min depois do planejado ainda conta como "no prazo".
const TOLERANCIA_MIN = computed(() => c.value?.toleranciaPlanejadoMinutos ?? 60);
const ETA_DA_ETAPA = {
  COLETADO: (x) => x.coletaSimulada,
  NA_FABRICA: (x) => x.previsaoChegadaFabrica,
  SAIU_FABRICA: (x) => x.previsaoSaidaFabrica,
  ENTREGUE_PORTO: (x) => x.previsaoEntrega,
};
const minutosEntre = (a, b) => (new Date(a) - new Date(b)) / 60000;
const etapas = computed(() => {
  if (!c.value) return [];
  const atual = FLUXO.indexOf(c.value.status);
  const cancelado = c.value.status === "CANCELADO";
  const agora = new Date();
  return FLUXO.map((etapa, i) => {
    const realizado = etapa === "PROGRAMADO" ? c.value.criadoEm : c.value[CAMPO_DATA[etapa]];
    const feita = Boolean(realizado) && (cancelado || i <= atual);
    // Sem plano congelado (sem trajeto completo), a coleta programada vale como planejado da coleta.
    const planejado = c.value.planejamento?.[etapa] ?? (etapa === "COLETADO" ? c.value.coletaProgramadaEm : null);
    const eta = !feita && !cancelado && p.value && ETA_DA_ETAPA[etapa] ? ETA_DA_ETAPA[etapa](p.value) : null;
    let situacao = "futura";
    let desvioMin = null;
    if (feita) {
      desvioMin = planejado ? minutosEntre(realizado, planejado) : null;
      situacao = desvioMin !== null && desvioMin > TOLERANCIA_MIN.value ? "atrasou" : "ok";
    } else if (!cancelado && planejado && minutosEntre(agora, planejado) > TOLERANCIA_MIN.value) {
      situacao = "pendenteAtrasada";
      desvioMin = minutosEntre(agora, planejado);
    } else if (!cancelado && i === atual + 1) {
      situacao = "pendente";
    }
    const etaDesvioMin = eta && planejado ? minutosEntre(eta, planejado) : null;
    return {
      etapa, nome: rotuloEtapa(c.value, etapa), planejado, eta, realizado, feita, situacao, desvioMin, etaDesvioMin,
      atual: i === atual,
    };
  });
});
const fmtDesvio = (min) => `+${fmtHoras(min / 60)}`;

// ----- Visão geral: "Situação da operação" (etapa atual → próxima, com prazo e atraso) -----
const proximaEtapa = computed(() => (proximo.value ? etapas.value.find((e) => e.etapa === proximo.value) : null));
const temperaturaAtual = computed(() => (c.value?.reefer ? s.value.temperatura ?? null : null));

// ----- Menu "⋮" -----
const menuAberto = ref(false);
const fecharMenu = (e) => {
  if (!e.target.closest?.(".menu-acoes")) menuAberto.value = false;
};
onMounted(() => document.addEventListener("click", fecharMenu));
onBeforeUnmount(() => document.removeEventListener("click", fecharMenu));
const podeDesfazer = computed(() => auth.pode("containers.corrigir") && c.value?.eventos.length > 1 && c.value.status !== "CANCELADO");
const podeCancelar = computed(() => auth.pode("containers.corrigir") && !encerrado.value);

// ----- Avançar etapa -----
const av = reactive({ ocorridoEm: "", observacao: "" });
function abrirAvancar() {
  av.ocorridoEm = paraInputLocal();
  av.observacao = "";
  erro.value = null;
  modal.value = "avancar";
}
const avancar = () =>
  executar(
    () => api.avancar(c.value.id, { statusPara: proximo.value, ocorridoEm: deInputLocal(av.ocorridoEm), observacao: av.observacao }),
    `Etapa registrada: ${rotuloEtapa(c.value, proximo.value)}.`
  );

function desfazer() {
  menuAberto.value = false;
  if (!confirm(`Desfazer a etapa "${rotuloEtapa(c.value, c.value.status)}"? A data registrada será apagada (fica no log de auditoria).`)) return;
  executar(() => api.desfazer(c.value.id), "Última etapa desfeita.");
}

const motivoCancelamento = ref("");
function abrirCancelar() {
  menuAberto.value = false;
  motivoCancelamento.value = "";
  erro.value = null;
  modal.value = "cancelar";
}
const cancelar = () => executar(() => api.cancelar(c.value.id, motivoCancelamento.value), "Container cancelado.");

// ----- Temperatura -----
// Campo sem segundos: sem edição, grava o instante exato (evita colisão de leituras no mesmo minuto).
const leitura = reactive({ temperatura: "", lidaEm: paraInputLocal(), editado: false });
function registrarLeitura() {
  const lidaEm = leitura.editado ? deInputLocal(leitura.lidaEm) : new Date().toISOString();
  executar(
    () => api.registrarLeitura(c.value.id, { temperatura: leitura.temperatura, lidaEm }),
    "Leitura registrada."
  ).then(() => {
    if (!erro.value) {
      leitura.temperatura = "";
      leitura.lidaEm = paraInputLocal();
      leitura.editado = false;
    }
  });
}

// ----- Edição -----
const ed = reactive({});
const locais = ref([]);
const portos = computed(() => locais.value.filter((l) => ehRetiradaEntrega(l) && (l.ativo || l.id === c.value?.portoRetiradaId || l.id === c.value?.portoEntregaId)));
const carregamentos = computed(() => locais.value.filter((l) => !ehRetiradaEntrega(l) && (l.ativo || l.id === c.value?.localCarregamentoId)));
async function abrirEditar() {
  const x = c.value;
  if (!locais.value.length) locais.value = await api.locais().catch(() => []);
  Object.assign(ed, {
    portoRetiradaId: x.portoRetiradaId ?? "", localCarregamentoId: x.localCarregamentoId ?? "", portoEntregaId: x.portoEntregaId ?? "",
    booking: x.booking ?? "", navio: x.navio ?? "", placa: x.placa ?? "", motorista: x.motorista ?? "", lacre: x.lacre ?? "",
    posicaoPatio: x.posicaoPatio ?? "", observacao: x.observacao ?? "", deadline: x.deadline ? paraInputLocal(x.deadline) : "",
    coletaProgramadaEm: x.coletaProgramadaEm ? paraInputLocal(x.coletaProgramadaEm) : "",
    metaEstadiaHoras: x.metaEstadiaHoras, custoEstadiaPorHora: x.custoEstadiaPorHora ?? "", freeTimeDias: x.freeTimeDias,
    setpoint: x.setpoint, tempMin: x.tempMin, tempMax: x.tempMax, toleranciaMinutos: x.toleranciaMinutos,
  });
  erro.value = null;
  modal.value = "editar";
}
function salvarEdicao() {
  const x = c.value;
  const dados = {
    booking: ed.booking, navio: ed.navio, placa: ed.placa, motorista: ed.motorista, lacre: ed.lacre,
    posicaoPatio: ed.posicaoPatio, observacao: ed.observacao, deadline: deInputLocal(ed.deadline),
  };
  // Programação da coleta só faz sentido enquanto o container ainda não foi coletado.
  if (x.status === "PROGRAMADO") dados.coletaProgramadaEm = deInputLocal(ed.coletaProgramadaEm);
  for (const campo of ["portoRetiradaId", "localCarregamentoId", "portoEntregaId"]) {
    if (String(ed[campo] ?? "") !== String(x[campo] ?? "")) dados[campo] = ed[campo] === "" ? null : Number(ed[campo]);
  }
  // Prazos só vão se mudaram (operador não pode alterá-los).
  for (const campo of ["metaEstadiaHoras", "freeTimeDias", "setpoint", "tempMin", "tempMax", "toleranciaMinutos"]) {
    if (ed[campo] !== undefined && ed[campo] !== null && String(ed[campo]) !== String(x[campo])) dados[campo] = ed[campo];
  }
  // Custo/h pode ser apagado (volta a "sem valor"); vazio = null.
  if (String(ed.custoEstadiaPorHora ?? "") !== String(x.custoEstadiaPorHora ?? "")) {
    dados.custoEstadiaPorHora = ed.custoEstadiaPorHora === "" ? null : ed.custoEstadiaPorHora;
  }
  executar(() => api.editarContainer(x.id, dados), "Dados atualizados.");
}

function reconhecido() {
  modal.value = null;
  carregar();
  atualizarAlertas();
}
</script>

<template>
  <div class="mestre-detalhe">
    <ListaContainersLateral ref="refLista" :selecionado="id" :class="{ 'so-largo': id }" @carregada="aoCarregarLista" @novo="novoAberto = true" />

    <section v-if="!id" class="detalhe so-largo">
      <div class="card vazio">Selecione um container na lista.</div>
    </section>
    <section v-else class="detalhe">
      <router-link to="/containers" class="so-estreito voltar"><Icone nome="voltar" :tamanho="16" /> Containers</router-link>
      <div v-if="erro && !c" class="erro">{{ erro }}</div>
      <div v-if="!c && !erro" class="card vazio">Carregando…</div>

      <template v-if="c">
        <!-- Cabeçalho -->
        <div class="card cabecalho">
          <div class="cab-linha">
            <img class="ilustracao" :src="imagemContainer" width="100" height="49" alt="" />
            <div class="identificacao">
              <div class="linha" style="gap: 10px; flex-wrap: wrap">
                <h1 class="numero">{{ c.numero }}</h1>
                <span class="chip azul chip-grande">{{ rotuloEtapa(c, c.status) }}</span>
                <span class="chip chip-grande">{{ ROTULO_TIPO[c.tipo] }}</span>
              </div>
              <div class="rota-cab">
                <template v-if="rota.length">{{ rota.join(" → ") }}</template>
                <template v-else>Trajeto não informado</template>
              </div>
              <div class="mudo pequeno">{{ c.grupo.cliente }} / {{ c.grupo.fabrica }} · {{ c.armador.nome }}<template v-if="c.produto"> · {{ c.produto.nome }}</template></div>
            </div>
            <div class="acoes">
              <button v-if="auth.pode('containers.operar') && proximo" class="primario" @click="abrirAvancar">
                <Icone nome="caminhao" :tamanho="18" /> {{ acaoEtapa(c, proximo) }}
              </button>
              <button v-if="auth.pode('containers.operar')" @click="abrirEditar">Editar</button>
              <div v-if="podeDesfazer || podeCancelar" class="menu-acoes">
                <button type="button" aria-label="Mais ações" :aria-expanded="menuAberto" @click="menuAberto = !menuAberto"><Icone nome="mais" :tamanho="18" /></button>
                <div v-if="menuAberto" class="menu-lista" role="menu">
                  <button v-if="podeDesfazer" type="button" role="menuitem" @click="desfazer">Desfazer última etapa</button>
                  <button v-if="podeCancelar" type="button" role="menuitem" class="perigo" @click="abrirCancelar">Cancelar container</button>
                </div>
              </div>
            </div>
          </div>
          <div v-if="mensagem" class="sucesso">{{ mensagem }}</div>
          <div v-if="erro && !modal" class="erro">{{ erro }}</div>
          <div v-if="c.status === 'CANCELADO'" class="aviso">Cancelado em {{ fmtDataHora(c.canceladoEm) }}.</div>

          <!-- Faixas de alerta -->
          <div v-if="faixas.length" class="faixas">
            <div v-for="(f, i) in faixas" :key="i" class="faixa" :class="f.nivel">
              <Icone :nome="f.icone" :tamanho="26" />
              <div>
                <div class="faixa-titulo">{{ f.titulo }}</div>
                <div class="faixa-texto">{{ f.texto }}</div>
              </div>
            </div>
          </div>

          <!-- Indicadores do ciclo -->
          <div class="indicadores">
            <div class="ind">
              <Icone nome="relogio" />
              <div><div class="rotulo">Ciclo estimado</div><div class="valor">{{ p ? `${(p.cicloHoras / 24).toFixed(1).replace(".", ",")} dias` : "—" }}</div></div>
            </div>
            <div class="ind">
              <Icone nome="local" />
              <div>
                <div class="rotulo">Distância total prevista</div>
                <div class="valor">{{ km.trechos.length ? fmtKm(km.total) : "—" }}</div>
                <div v-if="km.trechos.length" class="sub">{{ km.trechos.map((t) => fmtKm(t.km)).join(" + ") }}<template v-if="km.aproximado"> · aproximada</template></div>
              </div>
            </div>
            <div class="ind">
              <Icone nome="calendario" />
              <div>
                <div class="rotulo">ETA (previsão)</div>
                <div class="valor">{{ p ? fmtDataHora(p.previsaoEntrega) : c.entreguePortoEm ? fmtDataHora(c.entreguePortoEm) : "—" }}</div>
                <div v-if="p" class="sub">Último dia livre: {{ fmtDataHora(p.vencimentoFreeTime) }}</div>
                <div v-else-if="c.entreguePortoEm" class="sub">entregue</div>
                <div v-else class="sub">sem trajeto completo</div>
              </div>
            </div>
            <div class="ind">
              <Icone nome="folga" />
              <div>
                <div class="rotulo">Folga até o fim do free time</div>
                <template v-if="p">
                  <div class="linha" style="gap: 6px">
                    <span class="valor" :class="`txt-${p.riscoDemurrage === 'CRITICO' ? 'VENCIDO' : p.riscoDemurrage}`">{{ fmtFolga(p.folgaHoras) }}</span>
                    <span class="chip" :class="RISCO[p.riscoDemurrage].cor">{{ RISCO[p.riscoDemurrage].texto }}</span>
                  </div>
                  <div class="sub">free time: {{ c.freeTimeDias }} dias</div>
                </template>
                <template v-else-if="s.demurrage">
                  <div class="valor" :class="`txt-${s.demurrage.situacao}`">
                    {{ s.demurrage.diasExcedidos ? fmtMoeda(s.demurrage.custo, s.demurrage.moeda) : `${s.demurrage.diasRestantes} dia(s)` }}
                  </div>
                  <div class="sub">free time: {{ c.freeTimeDias }} dias</div>
                </template>
                <template v-else><div class="valor">—</div><div class="sub">free time: {{ c.freeTimeDias }} dias</div></template>
              </div>
            </div>
            <div class="ind">
              <Icone nome="armazem" />
              <div>
                <div class="rotulo">Estadia na fábrica (meta)</div>
                <template v-if="s.estadia">
                  <div class="valor" :class="`txt-${s.estadia.situacao}`">{{ fmtHoras(s.estadia.horasDecorridas) }} / {{ c.metaEstadiaHoras }}h</div>
                  <div class="sub">{{ s.estadia.encerrada ? "encerrada" : s.estadia.horasExcedidas > 0 ? `excedeu ${fmtHoras(s.estadia.horasExcedidas)}` : `faltam ${fmtHoras(s.estadia.horasRestantes)}` }}</div>
                </template>
                <div v-else class="valor">{{ c.metaEstadiaHoras }}h</div>
              </div>
            </div>
            <div class="ind">
              <Icone nome="navio" />
              <div>
                <div class="rotulo">Deadline do navio</div>
                <template v-if="s.deadline">
                  <div class="valor" :class="`txt-${s.deadline.situacao}`">{{ fmtDataHora(c.deadline) }}</div>
                  <div class="sub">
                    {{ s.deadline.encerrada ? (s.deadline.situacao === "VENCIDO" ? "entregue após o deadline" : "entregue a tempo") : s.deadline.horasRestantes < 0 ? `passou há ${fmtHoras(s.deadline.horasRestantes)}` : `faltam ${fmtHoras(s.deadline.horasRestantes)}` }}
                  </div>
                </template>
                <div v-else class="valor normal">Não informado</div>
              </div>
            </div>
          </div>

          <nav class="abas-ficha" role="tablist" aria-label="Seções do container">
            <button
              v-for="a in abas" :key="a.chave" type="button" role="tab" :aria-selected="aba === a.chave" :class="{ ativa: aba === a.chave }"
              @click="irPara(a.chave)"
            >
              {{ a.nome }}<span v-if="a.chave === 'geral' && alertasAbertos.length" class="chip" :class="alertasAbertos.some((x) => x.nivel === 'CRITICO') ? 'vermelho' : 'amarelo'">{{ alertasAbertos.length }}</span>
            </button>
          </nav>
        </div>

        <!-- Visão geral -->
        <div v-if="aba === 'geral'" class="geral">
          <div class="coluna">
            <div class="card situacao-op">
              <h2 style="margin-bottom: 2px">Situação da operação</h2>
              <p class="mudo" style="margin: 0 0 12px">Acompanhe o estágio atual e a próxima etapa programada.</p>
              <div class="sit-caixa">
                <div class="sit-trilha">
                  <div class="sit-passo">
                    <span class="sit-ponto cheio"></span>
                    <div><div class="sit-rotulo">Etapa atual</div><div class="sit-nome">{{ rotuloEtapa(c, c.status) }}</div></div>
                  </div>
                  <div v-if="proximaEtapa" class="sit-passo">
                    <span class="sit-ponto"></span>
                    <div><div class="sit-rotulo">Próxima etapa</div><div class="sit-nome">{{ proximaEtapa.nome }}</div></div>
                  </div>
                  <div v-else class="sit-passo">
                    <span class="sit-ponto"></span>
                    <div><div class="sit-rotulo">Próxima etapa</div><div class="sit-nome mudo">{{ c.status === "CANCELADO" ? "Cancelado" : "Ciclo encerrado" }}</div></div>
                  </div>
                </div>

                <dl v-if="proximaEtapa" class="sit-detalhes">
                  <dt>{{ proximaEtapa.planejado ? "Programada para" : "Prevista para" }}</dt>
                  <dd>
                    <Icone nome="calendario" :tamanho="16" />
                    {{ proximaEtapa.planejado ? fmtDataHora(proximaEtapa.planejado) : proximaEtapa.eta ? fmtDataHora(proximaEtapa.eta) : "—" }}
                  </dd>
                  <dt>Situação</dt>
                  <dd><span class="chip amarelo">Pendente</span></dd>
                  <dt>Atraso</dt>
                  <dd>
                    <span v-if="proximaEtapa.situacao === 'pendenteAtrasada'" class="chip laranja"><Icone nome="relogio" :tamanho="14" /> Atraso de {{ fmtHoras(proximaEtapa.desvioMin / 60) }}</span>
                    <span v-else-if="proximaEtapa.planejado" class="chip verde">No prazo</span>
                    <span v-else class="mudo">—</span>
                  </dd>
                  <dd v-if="auth.pode('containers.operar')" class="sit-acao">
                    <button class="primario" @click="abrirAvancar"><Icone nome="caminhao" :tamanho="18" /> {{ acaoEtapa(c, proximo) }}</button>
                  </dd>
                </dl>
                <div v-else class="sit-detalhes mudo">
                  {{ c.status === "CANCELADO" ? `Cancelado em ${fmtDataHora(c.canceladoEm)}.` : `Entregue em ${fmtDataHora(c.entreguePortoEm)}.` }}
                </div>

                <div v-if="c.reefer" class="sit-temp">
                  <div class="sit-temp-linha">
                    <span class="sit-floco"><Icone nome="floco" :tamanho="34" /></span>
                    <div>
                      <div class="sit-temp-rotulo">Temperatura</div>
                      <div class="sit-temp-valor" :class="temperaturaAtual?.foraDaFaixa ? 'txt-VENCIDO' : temperaturaAtual?.ultima ? 'txt-OK' : 'mudo'">
                        {{ temperaturaAtual?.ultima ? fmtTemp(temperaturaAtual.ultima.temperatura) : "—" }}
                      </div>
                    </div>
                  </div>
                  <span v-if="temperaturaAtual?.foraDaFaixa" class="sit-faixa fora"><Icone nome="exclamacao" :tamanho="18" /> Fora da faixa</span>
                  <span v-else-if="temperaturaAtual?.ultima" class="sit-faixa dentro"><Icone nome="ok" :tamanho="18" /> Dentro da faixa</span>
                  <span v-else class="mudo pequeno">Sem leitura</span>
                  <div class="mudo pequeno">
                    Faixa {{ fmtTemp(c.tempMin) }} a {{ fmtTemp(c.tempMax) }}<template v-if="temperaturaAtual?.ultima"> · há {{ tempoDesde(temperaturaAtual.ultima.lidaEm) }}</template>
                  </div>
                </div>
              </div>
            </div>

            <div class="card">
              <h2>Alertas abertos</h2>
              <table v-if="alertasAbertos.length">
                <tbody>
                  <tr v-for="a in alertasAbertos" :key="a.id">
                    <td><span class="chip" :class="a.nivel === 'CRITICO' ? 'vermelho' : 'amarelo'">{{ a.nivel === "CRITICO" ? "Crítico" : "Atenção" }}</span></td>
                    <td class="negrito">{{ ROTULO_ALERTA[a.tipo] }}</td>
                    <td>{{ a.mensagem }}<div class="mudo pequeno">aberto há {{ tempoDesde(a.abertoEm) }}</div></td>
                    <td style="text-align: right">
                      <span v-if="a.reconhecidoEm" class="pequeno mudo">✔ {{ a.reconhecidoPor }}: {{ a.acaoTomada }}</span>
                      <button v-else-if="auth.pode('containers.operar')" class="pequeno" @click="modal = { alerta: a }">Reconhecer</button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-else class="mudo">Nenhum alerta aberto.</div>
            </div>

            <div class="card">
              <h2>Prazos</h2>
              <dl class="lista-def">
                <dt>Estadia na fábrica</dt>
                <dd>
                  <template v-if="s.estadia">
                    {{ fmtHoras(s.estadia.horasDecorridas) }} de {{ c.metaEstadiaHoras }}h
                    <span :class="`txt-${s.estadia.situacao}`">· {{ s.estadia.horasExcedidas > 0 ? `excedeu ${fmtHoras(s.estadia.horasExcedidas)}` : s.estadia.encerrada ? "dentro da meta" : `vence ${fmtDataHora(s.estadia.limite)}` }}</span>
                    <div v-if="s.estadia.custo" class="txt-VENCIDO">Custo: {{ fmtMoeda(s.estadia.custo) }}</div>
                  </template>
                  <span v-else class="mudo">meta {{ c.metaEstadiaHoras }}h · começa na chegada</span>
                </dd>
                <dt>Demurrage</dt>
                <dd>
                  <template v-if="s.demurrage">
                    <template v-if="s.demurrage.diasExcedidos">{{ s.demurrage.diasExcedidos }} diária(s) × {{ fmtMoeda(s.demurrage.valorDiaria, s.demurrage.moeda) }} = <strong class="txt-VENCIDO">{{ fmtMoeda(s.demurrage.custo, s.demurrage.moeda) }}</strong></template>
                    <template v-else-if="s.demurrage.encerrada">entregue dentro do free time</template>
                    <template v-else>{{ s.demurrage.diasRestantes }} dia(s) livre(s) · último dia {{ fmtDataHora(s.demurrage.vencimento) }}</template>
                    <div v-if="!s.demurrage.encerrada && s.demurrage.custoSeEntregarAmanha" class="mudo">Se entregar amanhã: {{ fmtMoeda(s.demurrage.custoSeEntregarAmanha, s.demurrage.moeda) }}</div>
                  </template>
                  <span v-else class="mudo">free time {{ c.freeTimeDias }} dias · começa na coleta</span>
                </dd>
                <dt>Deadline do navio</dt>
                <dd>{{ c.deadline ? fmtDataHora(c.deadline) : "Não informado" }}</dd>
                <dt>Coleta programada</dt>
                <dd>{{ c.coletaProgramadaEm ? fmtDataHora(c.coletaProgramadaEm) : "—" }}</dd>
              </dl>
            </div>
          </div>

          <div class="card">
            <h2>Dados</h2>
            <dl class="lista-def">
              <dt>Ponto de Carregamento</dt><dd>{{ c.grupo.cliente }} / {{ c.grupo.fabrica }}</dd>
              <dt>Armador</dt><dd>{{ c.armador.nome }}</dd>
              <dt v-if="c.produto">Produto</dt><dd v-if="c.produto">{{ c.produto.nome }}</dd>
              <dt>Booking</dt><dd>{{ c.booking || "—" }}</dd>
              <dt>Navio</dt><dd>{{ c.navio || "—" }}</dd>
              <dt>Placa / Motorista</dt><dd>{{ c.placa || "—" }} · {{ c.motorista || "—" }}</dd>
              <dt>Lacre</dt><dd>{{ c.lacre || "—" }}</dd>
              <dt>Posição no pátio</dt><dd>{{ c.posicaoPatio || "—" }}</dd>
              <dt>Observação</dt><dd style="white-space: pre-wrap">{{ c.observacao || "—" }}</dd>
              <dt>Cadastrado por</dt><dd>{{ c.criadoPor }} em {{ fmtDataHora(c.criadoEm) }}</dd>
              <dt>Etiqueta QR</dt>
              <dd>
                <template v-if="c.etiquetas?.length">
                  <div v-for="e in c.etiquetas" :key="e.id">
                    <span class="mono negrito">{{ e.codigo }}</span>
                    <span class="chip" :class="e.status === 'CANCELADA' ? 'vermelho' : 'verde'" style="margin-left: 6px">{{ e.status === "CANCELADA" ? "cancelada" : "ativa" }}</span>
                    <span class="mudo pequeno"> · ligada {{ fmtDataHora(e.vinculadaEm) }} por {{ e.vinculadaPor }}</span>
                    <div v-if="e.motivoCancelamento" class="mudo pequeno">{{ e.motivoCancelamento }}</div>
                  </div>
                </template>
                <span v-else class="mudo">nenhuma — <router-link to="/etiquetas">gerar etiquetas</router-link></span>
              </dd>
            </dl>
          </div>
        </div>

        <!-- Etapas -->
        <div v-if="aba === 'etapas'" class="card">
          <h2 style="margin-bottom: 2px">Fluxo de etapas</h2>
          <p class="mudo" style="margin: 0 0 14px">Acompanhe o status e os horários de cada etapa da operação.</p>
          <div class="tabela-wrap">
            <table class="fluxo">
              <thead><tr><th>Etapa</th><th>Planejado</th><th>ETA</th><th>Realizado</th></tr></thead>
              <tbody>
                <tr v-for="(e, i) in etapas" :key="e.etapa" :class="{ feita: e.feita, atual: e.atual }">
                  <td>
                    <span class="marco" :class="{ feita: e.feita, atrasada: e.situacao === 'pendenteAtrasada', ultimo: i === etapas.length - 1 }"></span>
                    <span class="nome-etapa">{{ e.nome }}</span>
                    <span v-if="e.situacao === 'pendenteAtrasada'" class="chip amarelo" style="margin-left: 8px">Atrasada</span>
                  </td>
                  <td>{{ e.planejado ? fmtDataHora(e.planejado) : "—" }}</td>
                  <td>
                    <template v-if="e.eta">
                      <span :class="e.etaDesvioMin > TOLERANCIA_MIN ? 'txt-VENCIDO' : ''">{{ fmtDataHora(e.eta) }}</span>
                      <div v-if="e.etaDesvioMin > TOLERANCIA_MIN" class="pequeno txt-VENCIDO">{{ fmtDesvio(e.etaDesvioMin) }} do planejado</div>
                    </template>
                    <template v-else>—</template>
                  </td>
                  <td class="realizado" :class="`r-${e.situacao}`">
                    <span class="r-conteudo">
                      <span v-if="e.feita">
                        {{ fmtDataHora(e.realizado) }}
                        <div v-if="e.situacao === 'atrasou'" class="pequeno">{{ fmtDesvio(e.desvioMin) }} do planejado</div>
                      </span>
                      <span v-else-if="e.situacao === 'pendenteAtrasada'">Pendente<div class="pequeno">{{ fmtDesvio(e.desvioMin) }} do planejado</div></span>
                      <span v-else-if="e.situacao === 'pendente'" class="mudo">Pendente</span>
                      <span v-else>—</span>
                      <Icone v-if="e.situacao === 'ok'" nome="ok" :tamanho="22" />
                      <Icone v-else-if="e.situacao === 'atrasou' || e.situacao === 'pendenteAtrasada'" nome="relogio" :tamanho="22" />
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="mudo pequeno" style="margin: 10px 0 0">
            <template v-if="c.planejamento">
              <strong>Planejado</strong>: primeira previsão do ciclo, gravada em {{ fmtDataHora(c.planejamento.geradoEm) }} e que não muda mais.
            </template>
            <template v-else><strong>Planejado</strong>: é gravado na primeira previsão completa (precisa do trajeto com retirada, carregamento e entrega).</template>
            <strong>ETA</strong>: previsão atualizada com o que já aconteceu. <strong>Realizado</strong>: o que foi registrado — verde no prazo, vermelho com mais de {{ fmtHoras(TOLERANCIA_MIN / 60) }} de atraso sobre o planejado
            (tolerância em Configurações → Geral).
          </p>
        </div>

        <!-- (fim da aba Etapas) -->
        <!-- Trajeto -->
        <div v-if="aba === 'trajeto'" class="card">
          <div class="linha-entre" style="margin-bottom: 10px; flex-wrap: wrap; gap: 8px">
            <h2 style="margin: 0">Trajeto e previsão</h2>
            <span class="pequeno">
              <strong>{{ c.portoRetirada?.nome ?? "retirada ?" }}</strong> →
              <strong>{{ c.localCarregamento?.nome ?? "carregamento ?" }}</strong> →
              <strong>{{ c.portoEntrega?.nome ?? "entrega ?" }}</strong>
            </span>
          </div>
          <PrevisaoCiclo v-if="s.previsao" :p="s.previsao" :free-time-dias="c.freeTimeDias" sem-numeros />
          <div v-else-if="encerrado" class="mudo">Ciclo encerrado.</div>
          <div v-if="auth.pode('containers.operar') && !encerrado && s.previsao && !s.previsao.disponivel" style="margin-top: 8px">
            <button class="pequeno" @click="abrirEditar">Informar trajeto</button>
          </div>
        </div>

        <!-- Temperatura -->
        <div v-if="aba === 'temperatura'" class="card">
          <div class="linha-entre" style="flex-wrap: wrap; gap: 8px">
            <h2>Temperatura</h2>
            <span class="mudo pequeno">Setpoint {{ fmtTemp(c.setpoint) }} · faixa {{ fmtTemp(c.tempMin) }} a {{ fmtTemp(c.tempMax) }} · tolerância {{ c.toleranciaMinutos }} min</span>
          </div>
          <div v-if="s.temperatura?.ultima" class="linha" style="margin-bottom: 10px">
            <span style="font-size: 26px; font-weight: 700" :class="s.temperatura.foraDaFaixa ? 'txt-VENCIDO' : 'txt-OK'">{{ fmtTemp(s.temperatura.ultima.temperatura) }}</span>
            <span class="mudo">última leitura há {{ tempoDesde(s.temperatura.ultima.lidaEm) }} ({{ ORIGEM_LEITURA[s.temperatura.ultima.origem]?.toLowerCase() }})</span>
          </div>

          <form v-if="auth.pode('containers.operar') && !encerrado" class="filtros" style="margin-bottom: 12px" @submit.prevent="registrarLeitura">
            <div class="campo" style="min-width: 110px; max-width: 130px">
              <label>Temperatura (°C)</label>
              <input v-model="leitura.temperatura" inputmode="decimal" placeholder="-18,0" required />
            </div>
            <div class="campo">
              <label>Horário da leitura</label>
              <input v-model="leitura.lidaEm" type="datetime-local" required @input="leitura.editado = true" />
            </div>
            <button type="submit" class="primario" :disabled="enviando">Registrar leitura</button>
          </form>

          <GraficoTemperatura v-if="c.leituras.length" :leituras="c.leituras" :temp-min="c.tempMin" :temp-max="c.tempMax" :setpoint="c.setpoint" />
          <div v-else class="vazio">Nenhuma leitura registrada.</div>

          <details v-if="c.leituras.length" style="margin-top: 10px">
            <summary class="pequeno">Ver leituras ({{ c.leituras.length }})</summary>
            <table class="pequeno">
              <thead><tr><th>Horário</th><th>Temperatura</th><th>Origem</th><th>Registro</th></tr></thead>
              <tbody>
                <tr v-for="l in leiturasDesc" :key="l.id">
                  <td>{{ fmtDataHora(l.lidaEm) }}</td>
                  <td :class="l.temperatura < c.tempMin || l.temperatura > c.tempMax ? 'txt-VENCIDO' : ''">{{ fmtTemp(l.temperatura) }}</td>
                  <td>
                    {{ ORIGEM_LEITURA[l.origem] }}<template v-if="l.etiqueta"> <span class="mono">{{ l.etiqueta.codigo }}</span></template> · {{ l.fonte }}
                    <a
                      v-if="l.latitude !== null" :href="`https://www.openstreetmap.org/?mlat=${l.latitude}&mlon=${l.longitude}#map=18/${l.latitude}/${l.longitude}`"
                      target="_blank" rel="noopener" :title="`Local da leitura (precisão ~${l.precisaoM ?? '?'} m)`"
                    >📍</a>
                  </td>
                  <td>
                    <span v-if="l.lancadaComAtraso" class="chip amarelo" :title="`Digitada ${fmtHoras(l.atrasoMin / 60)} depois do horário informado`">lançada com atraso</span>
                    <span v-else class="mudo">{{ fmtDataHora(l.registradaEm) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </details>
        </div>

        <!-- Histórico -->
        <div v-if="aba === 'historico'" class="card">
          <h2>Histórico de etapas</h2>
          <table class="pequeno">
            <thead><tr><th>Quando</th><th>Etapa</th><th>Quem / observação</th></tr></thead>
            <tbody>
              <tr v-for="e in c.eventos" :key="e.id">
                <td>{{ fmtDataHora(e.ocorridoEm) }}</td>
                <td class="negrito">{{ rotuloEtapa(c, e.statusPara) }}</td>
                <td>{{ e.usuarioEmail }}<div v-if="e.observacao" class="mudo">{{ e.observacao }}</div></td>
              </tr>
            </tbody>
          </table>

          <h2 style="margin-top: 22px">Alertas encerrados</h2>
          <table v-if="alertasEncerrados.length" class="pequeno">
            <tbody>
              <tr v-for="a in alertasEncerrados" :key="a.id">
                <td>{{ fmtDataHora(a.abertoEm) }}</td>
                <td><span :class="`txt-${a.nivel}`">{{ ROTULO_ALERTA[a.tipo] }}</span></td>
                <td>{{ a.mensagem }}<div v-if="a.acaoTomada" class="mudo">✔ {{ a.reconhecidoPor }}: {{ a.acaoTomada }}</div></td>
              </tr>
            </tbody>
          </table>
          <div v-else class="mudo">Nenhum alerta encerrado.</div>
        </div>
      </template>
    </section>
  </div>

  <NovoContainer v-if="novoAberto" @fechar="novoAberto = false" @criado="criado" />

  <!-- Modais -->
  <template v-if="c">
    <div v-if="modal === 'avancar'" class="fundo-modal" @mousedown.self="modal = null">
      <form class="modal estreito" @submit.prevent="avancar">
        <h2>{{ acaoEtapa(c, proximo) }}</h2>
        <div v-if="erro" class="erro">{{ erro }}</div>
        <div class="campo">
          <label>Quando aconteceu *</label>
          <input v-model="av.ocorridoEm" type="datetime-local" required />
          <span class="dica">Pode ser informado retroativamente. Os prazos são calculados a partir deste horário.</span>
        </div>
        <div class="campo"><label>Observação</label><textarea v-model="av.observacao" rows="2" maxlength="1000"></textarea></div>
        <div class="modal-acoes">
          <button type="button" @click="modal = null">Voltar</button>
          <button type="submit" class="primario" :disabled="enviando">Confirmar</button>
        </div>
      </form>
    </div>

    <div v-if="modal === 'cancelar'" class="fundo-modal" @mousedown.self="modal = null">
      <form class="modal estreito" @submit.prevent="cancelar">
        <h2>Cancelar container {{ c.numero }}</h2>
        <div v-if="erro" class="erro">{{ erro }}</div>
        <div class="aviso">O container sai do pátio e deixa de gerar alertas. O histórico é mantido.</div>
        <div class="campo"><label>Motivo *</label><textarea v-model="motivoCancelamento" rows="3" required maxlength="1000"></textarea></div>
        <div class="modal-acoes">
          <button type="button" @click="modal = null">Voltar</button>
          <button type="submit" class="perigo" :disabled="enviando">Cancelar container</button>
        </div>
      </form>
    </div>

    <div v-if="modal === 'editar'" class="fundo-modal" @mousedown.self="modal = null">
      <form class="modal" @submit.prevent="salvarEdicao">
        <h2>Editar {{ c.numero }}</h2>
        <div v-if="erro" class="erro">{{ erro }}</div>
        <h3 style="margin-bottom: 0">Trajeto</h3>
        <div class="grade-form">
          <div class="campo">
            <label>Local de retirada (vazio)</label>
            <select v-model="ed.portoRetiradaId">
              <option value="">— não informado —</option>
              <option v-for="l in portos" :key="l.id" :value="l.id">{{ l.nome }}{{ l.uf ? ` (${l.uf})` : "" }}</option>
            </select>
          </div>
          <div class="campo">
            <label>Local de carregamento</label>
            <select v-model="ed.localCarregamentoId">
              <option value="">— não informado —</option>
              <option v-for="l in carregamentos" :key="l.id" :value="l.id">{{ l.nome }}{{ l.uf ? ` (${l.uf})` : "" }}</option>
            </select>
          </div>
          <div class="campo">
            <label>Local de entrega (cheio)</label>
            <select v-model="ed.portoEntregaId">
              <option value="">— não informado —</option>
              <option v-for="l in portos" :key="l.id" :value="l.id">{{ l.nome }}{{ l.uf ? ` (${l.uf})` : "" }}</option>
            </select>
          </div>
        </div>
        <div v-if="!portos.length" class="dica pequeno mudo">Nenhum local de retirada/entrega (porto, terminal…) cadastrado — <router-link to="/locais">cadastrar em Locais</router-link>.</div>
        <h3 style="margin-bottom: 0">Dados</h3>
        <div class="grade-form">
          <div class="campo"><label>Booking</label><input v-model="ed.booking" maxlength="60" /></div>
          <div class="campo"><label>Navio</label><input v-model="ed.navio" maxlength="120" /></div>
          <div class="campo"><label>Deadline</label><input v-model="ed.deadline" type="datetime-local" /></div>
          <div v-if="c.status === 'PROGRAMADO'" class="campo"><label>Coleta programada para</label><input v-model="ed.coletaProgramadaEm" type="datetime-local" /></div>
          <div class="campo"><label>Placa</label><input v-model="ed.placa" maxlength="20" /></div>
          <div class="campo"><label>Motorista</label><input v-model="ed.motorista" maxlength="120" /></div>
          <div class="campo"><label>Lacre</label><input v-model="ed.lacre" maxlength="60" /></div>
          <div class="campo"><label>Posição no pátio</label><input v-model="ed.posicaoPatio" maxlength="40" /></div>
        </div>
        <div class="campo"><label>Observação</label><textarea v-model="ed.observacao" rows="2" maxlength="1000"></textarea></div>
        <template v-if="auth.pode('containers.prazos')">
          <h3>Prazos deste container</h3>
          <div class="dica mudo pequeno">Copiados do cadastro na criação. Altere só se houve negociação específica (ex.: free time estendido pelo armador).</div>
          <div class="grade-form">
            <div class="campo"><label>Meta de estadia (h)</label><input v-model.number="ed.metaEstadiaHoras" type="number" min="1" /></div>
            <div class="campo"><label>Custo por hora excedida (R$)</label><input v-model="ed.custoEstadiaPorHora" type="number" min="0" step="0.01" placeholder="sem valor" /></div>
            <div class="campo"><label>Free time (dias)</label><input v-model.number="ed.freeTimeDias" type="number" min="0" /></div>
            <template v-if="c.reefer">
              <div class="campo"><label>Setpoint (°C)</label><input v-model.number="ed.setpoint" type="number" step="0.1" /></div>
              <div class="campo"><label>Mínima (°C)</label><input v-model.number="ed.tempMin" type="number" step="0.1" /></div>
              <div class="campo"><label>Máxima (°C)</label><input v-model.number="ed.tempMax" type="number" step="0.1" /></div>
              <div class="campo"><label>Tolerância (min)</label><input v-model.number="ed.toleranciaMinutos" type="number" min="0" /></div>
            </template>
          </div>
        </template>
        <div class="modal-acoes">
          <button type="button" @click="modal = null">Voltar</button>
          <button type="submit" class="primario" :disabled="enviando">Salvar</button>
        </div>
      </form>
    </div>

    <ReconhecerAlerta v-if="modal?.alerta" :alerta="modal.alerta" @fechar="modal = null" @reconhecido="reconhecido" />
  </template>
</template>

<style scoped>
.mestre-detalhe { display: grid; grid-template-columns: 330px minmax(0, 1fr); gap: 16px; align-items: start; }
.detalhe { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.so-estreito { display: none; }

/* Cabeçalho */
.cabecalho { display: flex; flex-direction: column; gap: 14px; padding-bottom: 0; }
.cab-linha { display: flex; gap: 16px; align-items: flex-start; }
.ilustracao { flex-shrink: 0; margin-top: 2px; width: 100px; height: auto; }
.identificacao { flex: 1; min-width: 0; }
.numero { font-size: 28px; font-weight: 800; letter-spacing: .01em; margin: 0; }
.chip-grande { font-size: 13px; padding: 4px 12px; }
.rota-cab { font-size: 17px; color: var(--texto-2); margin-top: 4px; }
.acoes { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.acoes > button.primario { padding: 10px 18px; font-size: 15px; font-weight: 600; }
.acoes > button:not(.primario) { padding: 10px 16px; }
.menu-acoes { position: relative; }
.menu-acoes > button { padding: 10px; }
.menu-lista { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; background: var(--superficie); border: 1px solid var(--borda); border-radius: 8px; box-shadow: 0 8px 24px rgba(16, 24, 40, .14); min-width: 220px; padding: 4px; display: flex; flex-direction: column; }
.menu-lista button { border: none; background: none; justify-content: flex-start; padding: 9px 12px; }
.menu-lista button:hover { background: var(--superficie-2); }

/* Faixas de alerta */
.faixas { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.faixa { display: flex; gap: 14px; align-items: flex-start; padding: 14px 16px; border-radius: 10px; border: 1px solid; }
.faixa.atencao { background: var(--amarelo-fundo); border-color: #f1d49a; color: var(--amarelo); }
.faixa.critico { background: var(--vermelho-fundo); border-color: #f4b4b4; color: var(--vermelho); }
.faixa-titulo { font-weight: 700; font-size: 16px; }
.faixa-texto { color: var(--texto); margin-top: 2px; }

/* Indicadores */
.indicadores { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 8px; }
.ind { display: flex; gap: 8px; align-items: flex-start; border: 1px solid var(--borda); border-radius: 10px; padding: 11px 10px; color: var(--primaria); }
.ind > div { color: var(--texto); min-width: 0; }
.ind .rotulo { font-size: 12px; color: var(--texto-2); }
.ind .valor { font-size: 18px; font-weight: 700; margin-top: 2px; line-height: 1.25; }
.ind .valor.normal { font-size: 16px; font-weight: 500; }
.ind .sub { font-size: 12px; color: var(--texto-2); margin-top: 2px; }

/* Abas */
.abas-ficha { display: flex; gap: 4px; border-top: 1px solid var(--borda); margin: 0 -18px; padding: 0 12px; overflow-x: auto; }
.abas-ficha button { border: none; border-bottom: 3px solid transparent; border-radius: 0; background: none; padding: 12px 16px; font-size: 15px; color: var(--texto); gap: 6px; }
.abas-ficha button:hover:not(:disabled) { background: none; color: var(--primaria); }
.abas-ficha button.ativa { color: var(--primaria); border-bottom-color: var(--primaria); font-weight: 700; }

/* Situação da operação — o layout acompanha a largura do próprio quadro (container query),
   que varia com o menu lateral e a coluna da Visão geral, não só com a tela. */
.situacao-op { container-type: inline-size; }
.sit-caixa { display: grid; grid-template-columns: minmax(170px, auto) minmax(0, 1fr) auto; gap: 0; border: 1px solid var(--borda); border-radius: 10px; background: var(--superficie-2); }
.sit-caixa > * { padding: 16px 18px; }
.sit-caixa > * + * { border-left: 1px solid var(--borda); }
.sit-trilha { display: flex; flex-direction: column; gap: 22px; position: relative; }
.sit-passo { display: flex; gap: 12px; align-items: flex-start; position: relative; }
.sit-ponto { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #8a97a8; background: var(--superficie); margin-top: 12px; flex-shrink: 0; position: relative; z-index: 1; }
.sit-ponto.cheio { background: var(--primaria); border-color: var(--primaria); }
.sit-passo:first-child .sit-ponto::after { content: ""; position: absolute; left: 4px; top: 12px; width: 2px; height: 48px; background: var(--primaria); }
.sit-rotulo { font-size: 12px; color: var(--texto-2); }
.sit-nome { font-size: 17px; font-weight: 700; }
.sit-detalhes { display: grid; grid-template-columns: auto 1fr; gap: 10px 16px; align-items: center; margin: 0; align-content: start; }
.sit-detalhes dt { font-size: 13px; color: var(--texto-2); white-space: nowrap; }
.sit-detalhes dd { margin: 0; display: flex; align-items: center; gap: 6px; }
.sit-acao { grid-column: 1 / -1; margin-top: 4px !important; }
.chip.laranja { background: #fde7cf; color: #b45309; display: inline-flex; align-items: center; gap: 4px; }
.sit-temp { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; min-width: 210px; }
.sit-temp-linha { display: flex; gap: 12px; align-items: center; }
.sit-floco { color: var(--primaria); display: inline-flex; padding: 8px; border: 1px solid var(--borda); border-radius: 10px; background: var(--superficie); }
.sit-temp-rotulo { font-size: 13px; font-weight: 700; color: var(--texto-2); }
.sit-temp-valor { font-size: 28px; font-weight: 800; line-height: 1.1; }
.sit-faixa { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; font-weight: 600; }
.sit-faixa.fora { background: var(--vermelho-fundo); color: var(--vermelho); border: 1px solid #f4b4b4; }
.sit-faixa.dentro { background: var(--verde-fundo); color: var(--verde); border: 1px solid #b7e2c7; }

/* Visão geral */
.geral { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 14px; align-items: start; }
.coluna { display: flex; flex-direction: column; gap: 14px; }

/* Fluxo de etapas: linha do tempo vertical na primeira coluna */
.fluxo { border: 1px solid var(--borda); border-radius: 8px; }
.fluxo th { background: var(--superficie-2); }
.fluxo td:first-child { position: relative; padding-left: 44px; }
.fluxo td:not(:first-child), .fluxo th:not(:first-child) { border-left: 1px solid var(--borda); }
.marco { position: absolute; left: 16px; top: 50%; width: 14px; height: 14px; margin-top: -7px; border-radius: 50%; border: 2px solid #9aa6b5; background: var(--superficie); z-index: 1; }
.marco.feita { background: var(--primaria); border-color: var(--primaria); }
.marco.atrasada { border-color: var(--amarelo); background: var(--superficie); }
.marco::after { content: ""; position: absolute; left: 4px; top: 12px; width: 2px; height: 34px; background: #c7d0db; }
.marco.feita::after { background: var(--primaria); }
.marco.ultimo::after { display: none; }
.fluxo tr.atual .nome-etapa { font-weight: 700; }
/* Realizado × Planejado: verde = no prazo (até 1h de tolerância); vermelho = atrasou ou está atrasado */
.realizado .r-conteudo { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.realizado.r-ok { background: var(--verde-fundo); color: var(--verde); }
.realizado.r-ok .r-conteudo > span:first-child { color: var(--texto); }
.realizado.r-atrasou, .realizado.r-pendenteAtrasada { background: var(--vermelho-fundo); color: var(--vermelho); }
.nome-etapa { font-weight: 500; }

@container (max-width: 760px) {
  /* Temperatura desce para baixo */
  .sit-caixa { grid-template-columns: minmax(160px, auto) minmax(0, 1fr); }
  .sit-temp { grid-column: 1 / -1; border-left: none !important; border-top: 1px solid var(--borda); flex-direction: row; flex-wrap: wrap; align-items: center; gap: 12px 18px; }
}
@container (max-width: 560px) {
  /* Tudo empilhado */
  .sit-caixa { grid-template-columns: 1fr; }
  .sit-caixa > * + * { border-left: none !important; border-top: 1px solid var(--borda); }
  .sit-temp { grid-column: auto; }
}
@media (max-width: 1100px) {
  .mestre-detalhe { grid-template-columns: 1fr; }
  .so-largo { display: none; }
  .so-estreito { display: inline-flex; align-items: center; gap: 4px; }
  .geral { grid-template-columns: 1fr; }
}
@media (max-width: 700px) {
  .cab-linha { flex-wrap: wrap; }
  .ilustracao { display: none; }
  .acoes { justify-content: flex-start; width: 100%; }
  .numero { font-size: 22px; }
  .rota-cab { font-size: 14px; }
}
</style>
