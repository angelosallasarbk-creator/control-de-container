<script setup>
import { computed, inject, onMounted, reactive, ref } from "vue";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import {
  FLUXO, ROTULO_STATUS, ROTULO_TIPO, ROTULO_ALERTA, ACAO_ETAPA,
  fmtDataHora, fmtHoras, fmtMoeda, fmtTemp, paraInputLocal, deInputLocal, tempoDesde,
} from "../formato.js";
import GraficoTemperatura from "../components/GraficoTemperatura.vue";
import PrevisaoCiclo from "../components/PrevisaoCiclo.vue";
import ReconhecerAlerta from "../components/ReconhecerAlerta.vue";

const props = defineProps({ id: { type: String, required: true } });
const atualizarAlertas = inject("atualizarAlertas", () => {});
const auth = useAuthStore();

const c = ref(null);
const erro = ref(null);
const mensagem = ref(null);
const enviando = ref(false);
const modal = ref(null); // "avancar" | "cancelar" | "editar" | { alerta }

const ORIGEM_LEITURA = { MANUAL: "Manual", INTEGRACAO: "Automática", QRCODE: "QR" };
const CAMPO_DATA = {
  COLETADO: "coletadoEm", NA_FABRICA: "chegadaFabricaEm", EM_OPERACAO: "inicioOperacaoEm",
  LIBERADO: "liberadoEm", SAIU_FABRICA: "saidaFabricaEm", ENTREGUE_PORTO: "entreguePortoEm",
};

async function carregar() {
  try {
    c.value = await api.container(props.id);
    erro.value = null;
  } catch (e) {
    erro.value = e.message;
  }
}
onMounted(carregar);

// Executa uma ação que devolve o container atualizado.
async function executar(fn, sucesso) {
  enviando.value = true;
  erro.value = null;
  try {
    c.value = await fn();
    mensagem.value = sucesso;
    modal.value = null;
    atualizarAlertas();
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
const alertasAbertos = computed(() => (c.value?.alertas ?? []).filter((a) => a.chaveAberta));
const alertasEncerrados = computed(() => (c.value?.alertas ?? []).filter((a) => !a.chaveAberta));
const leiturasDesc = computed(() => [...(c.value?.leituras ?? [])].reverse().slice(0, 30));

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
    `Etapa registrada: ${ROTULO_STATUS[proximo.value]}.`
  );

function desfazer() {
  if (!confirm(`Desfazer a etapa "${ROTULO_STATUS[c.value.status]}"? A data registrada será apagada (fica no log de auditoria).`)) return;
  executar(() => api.desfazer(c.value.id), "Última etapa desfeita.");
}

const motivoCancelamento = ref("");
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
const portos = computed(() => locais.value.filter((l) => l.tipo === "PORTO" && (l.ativo || l.id === c.value?.portoRetiradaId || l.id === c.value?.portoEntregaId)));
const carregamentos = computed(() => locais.value.filter((l) => l.tipo !== "PORTO" && (l.ativo || l.id === c.value?.localCarregamentoId)));
async function abrirEditar() {
  const x = c.value;
  if (!locais.value.length) locais.value = await api.locais().catch(() => []);
  Object.assign(ed, {
    portoRetiradaId: x.portoRetiradaId ?? "", localCarregamentoId: x.localCarregamentoId ?? "", portoEntregaId: x.portoEntregaId ?? "",
    booking: x.booking ?? "", navio: x.navio ?? "", placa: x.placa ?? "", motorista: x.motorista ?? "", lacre: x.lacre ?? "",
    posicaoPatio: x.posicaoPatio ?? "", observacao: x.observacao ?? "", deadline: x.deadline ? paraInputLocal(x.deadline) : "",
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
  <div v-if="erro && !c" class="erro">{{ erro }}</div>
  <div v-if="!c && !erro" class="vazio">Carregando…</div>

  <template v-if="c">
    <div class="linha"><router-link to="/containers">← Containers</router-link></div>

    <div class="card">
      <div class="linha-entre">
        <div>
          <div class="linha">
            <span class="ponto" :class="c.semaforo"></span>
            <span class="mono negrito" style="font-size: 20px">{{ c.numero }}</span>
            <span class="chip azul">{{ ROTULO_STATUS[c.status] }}</span>
            <span class="chip">{{ ROTULO_TIPO[c.tipo] }}</span>
          </div>
          <div class="mudo" style="margin-top: 4px">{{ c.grupo.cliente }} / {{ c.grupo.fabrica }} · {{ c.armador.nome }}<template v-if="c.produto"> · {{ c.produto.nome }}</template></div>
        </div>
        <div class="linha">
          <button v-if="auth.pode('containers.operar') && proximo" class="primario" @click="abrirAvancar">{{ ACAO_ETAPA[proximo] }}</button>
          <button v-if="auth.pode('containers.operar')" @click="abrirEditar">Editar</button>
          <button v-if="auth.pode('containers.corrigir') && c.eventos.length > 1 && c.status !== 'CANCELADO'" @click="desfazer">Desfazer etapa</button>
          <button v-if="auth.pode('containers.corrigir') && !encerrado" class="perigo" @click="motivoCancelamento = ''; modal = 'cancelar'">Cancelar</button>
        </div>
      </div>
      <div v-if="mensagem" class="sucesso" style="margin-top: 12px">{{ mensagem }}</div>
      <div v-if="erro && !modal" class="erro" style="margin-top: 12px">{{ erro }}</div>

      <div class="etapas" style="margin-top: 18px">
        <div
          v-for="(etapa, i) in FLUXO" :key="etapa" class="etapa"
          :class="{ feita: FLUXO.indexOf(c.status) >= i, atual: c.status === etapa }"
        >
          <span class="bolinha"></span>
          <div>{{ ROTULO_STATUS[etapa] }}</div>
          <div class="quando">{{ etapa === "PROGRAMADO" ? fmtDataHora(c.criadoEm) : fmtDataHora(c[CAMPO_DATA[etapa]]) }}</div>
        </div>
      </div>
      <div v-if="c.status === 'CANCELADO'" class="aviso" style="margin-top: 12px">Cancelado em {{ fmtDataHora(c.canceladoEm) }}.</div>
    </div>

    <!-- Prazos -->
    <div class="kpis">
      <div class="kpi" :class="{ amarelo: s.estadia?.situacao === 'ATENCAO', vermelho: s.estadia?.situacao === 'VENCIDO' }">
        <div class="rotulo">Estadia na fábrica (meta {{ c.metaEstadiaHoras }}h)</div>
        <template v-if="s.estadia">
          <div class="valor">{{ fmtHoras(s.estadia.horasDecorridas) }}</div>
          <div class="pequeno" :class="`txt-${s.estadia.situacao}`">
            <template v-if="s.estadia.horasExcedidas > 0">excedeu {{ fmtHoras(s.estadia.horasExcedidas) }}</template>
            <template v-else-if="s.estadia.encerrada">dentro da meta</template>
            <template v-else>faltam {{ fmtHoras(s.estadia.horasRestantes) }} · vence {{ fmtDataHora(s.estadia.limite) }}</template>
          </div>
          <div v-if="s.estadia.custo" class="pequeno txt-VENCIDO">Custo: {{ fmtMoeda(s.estadia.custo) }}</div>
        </template>
        <div v-else class="mudo" style="margin-top: 8px">Começa na chegada à fábrica</div>
      </div>

      <div class="kpi" :class="{ amarelo: s.demurrage?.situacao === 'ATENCAO', vermelho: s.demurrage?.situacao === 'VENCIDO' }">
        <div class="rotulo">Demurrage (free time {{ c.freeTimeDias }} dias)</div>
        <template v-if="s.demurrage">
          <div class="valor">
            <template v-if="s.demurrage.diasExcedidos">{{ fmtMoeda(s.demurrage.custo, s.demurrage.moeda) }}</template>
            <template v-else>{{ s.demurrage.diasRestantes }} dia(s)</template>
          </div>
          <div class="pequeno" :class="`txt-${s.demurrage.situacao}`">
            <template v-if="s.demurrage.diasExcedidos">{{ s.demurrage.diasExcedidos }} diária(s) × {{ fmtMoeda(s.demurrage.valorDiaria, s.demurrage.moeda) }}</template>
            <template v-else-if="s.demurrage.encerrada">entregue dentro do free time</template>
            <template v-else>livres após hoje · último dia livre {{ fmtDataHora(s.demurrage.vencimento) }}</template>
          </div>
          <div v-if="!s.demurrage.encerrada && s.demurrage.custoSeEntregarAmanha" class="pequeno mudo">
            Se entregar amanhã: {{ fmtMoeda(s.demurrage.custoSeEntregarAmanha, s.demurrage.moeda) }}
          </div>
        </template>
        <div v-else class="mudo" style="margin-top: 8px">Começa na coleta no porto</div>
      </div>

      <div class="kpi" :class="{ amarelo: s.deadline?.situacao === 'ATENCAO', vermelho: s.deadline?.situacao === 'VENCIDO' }">
        <div class="rotulo">Deadline do navio</div>
        <template v-if="s.deadline">
          <div class="valor" style="font-size: 18px">{{ fmtDataHora(c.deadline) }}</div>
          <div class="pequeno" :class="`txt-${s.deadline.situacao}`">
            <template v-if="s.deadline.encerrada">{{ s.deadline.situacao === "VENCIDO" ? "entregue após o deadline" : "entregue a tempo" }}</template>
            <template v-else-if="s.deadline.horasRestantes < 0">passou há {{ fmtHoras(s.deadline.horasRestantes) }}</template>
            <template v-else>faltam {{ fmtHoras(s.deadline.horasRestantes) }}</template>
          </div>
        </template>
        <div v-else class="mudo" style="margin-top: 8px">Não informado</div>
      </div>
    </div>

    <!-- Trajeto e previsão do ciclo -->
    <div v-if="!encerrado || c.portoRetirada" class="card">
      <div class="linha-entre" style="margin-bottom: 10px">
        <h2 style="margin: 0">Trajeto e previsão</h2>
        <span class="pequeno">
          <strong>{{ c.portoRetirada?.nome ?? "porto de retirada ?" }}</strong> →
          <strong>{{ c.localCarregamento?.nome ?? "carregamento ?" }}</strong> →
          <strong>{{ c.portoEntrega?.nome ?? "porto de entrega ?" }}</strong>
        </span>
      </div>
      <PrevisaoCiclo v-if="s.previsao" :p="s.previsao" :free-time-dias="c.freeTimeDias" />
      <div v-else-if="encerrado" class="mudo pequeno">Ciclo encerrado.</div>
      <div v-if="auth.pode('containers.operar') && !encerrado && s.previsao && !s.previsao.disponivel" style="margin-top: 8px">
        <button class="pequeno" @click="abrirEditar">Informar trajeto</button>
      </div>
    </div>

    <!-- Alertas abertos -->
    <div v-if="alertasAbertos.length" class="card">
      <h2>Alertas abertos</h2>
      <table>
        <tbody>
          <tr v-for="a in alertasAbertos" :key="a.id">
            <td><span class="chip" :class="a.nivel === 'CRITICO' ? 'vermelho' : 'amarelo'">{{ a.nivel === "CRITICO" ? "Crítico" : "Atenção" }}</span></td>
            <td class="negrito">{{ ROTULO_ALERTA[a.tipo] }}</td>
            <td>{{ a.mensagem }}<div class="mudo pequeno">aberto há {{ tempoDesde(a.abertoEm) }}</div></td>
            <td>
              <span v-if="a.reconhecidoEm" class="pequeno mudo">✔ {{ a.reconhecidoPor }}: {{ a.acaoTomada }}</span>
              <button v-else-if="auth.pode('containers.operar')" class="pequeno" @click="modal = { alerta: a }">Reconhecer</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="dois-col">
      <!-- Temperatura -->
      <div v-if="c.reefer" class="card">
        <div class="linha-entre">
          <h2>Temperatura</h2>
          <span class="mudo pequeno">Setpoint {{ fmtTemp(c.setpoint) }} · faixa {{ fmtTemp(c.tempMin) }} a {{ fmtTemp(c.tempMax) }} · tolerância {{ c.toleranciaMinutos }} min</span>
        </div>
        <div v-if="s.temperatura?.ultima" class="linha" style="margin-bottom: 10px">
          <span style="font-size: 26px; font-weight: 700" :class="s.temperatura.foraDaFaixa ? 'txt-VENCIDO' : 'txt-OK'">{{ fmtTemp(s.temperatura.ultima.temperatura) }}</span>
          <span class="mudo">última leitura há {{ tempoDesde(s.temperatura.ultima.lidaEm) }} ({{ s.temperatura.ultima.origem === "MANUAL" ? "manual" : "automática" }})</span>
        </div>
        <div v-if="s.temperatura?.semLeitura" class="aviso" style="margin-bottom: 10px">Leitura atrasada: sem registro há {{ fmtHoras(s.temperatura.minutosSemLeitura / 60) }}.</div>

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

      <!-- Dados -->
      <div class="card">
        <h2>Dados</h2>
        <dl class="lista-def">
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

        <h3 style="margin-top: 18px">Histórico de etapas</h3>
        <table class="pequeno">
          <tbody>
            <tr v-for="e in c.eventos" :key="e.id">
              <td>{{ fmtDataHora(e.ocorridoEm) }}</td>
              <td class="negrito">{{ ROTULO_STATUS[e.statusPara] }}</td>
              <td>{{ e.usuarioEmail }}<div v-if="e.observacao" class="mudo">{{ e.observacao }}</div></td>
            </tr>
          </tbody>
        </table>

        <template v-if="alertasEncerrados.length">
          <h3 style="margin-top: 18px">Alertas encerrados</h3>
          <table class="pequeno">
            <tbody>
              <tr v-for="a in alertasEncerrados" :key="a.id">
                <td>{{ fmtDataHora(a.abertoEm) }}</td>
                <td><span :class="`txt-${a.nivel}`">{{ ROTULO_ALERTA[a.tipo] }}</span></td>
                <td>{{ a.mensagem }}<div v-if="a.acaoTomada" class="mudo">✔ {{ a.reconhecidoPor }}: {{ a.acaoTomada }}</div></td>
              </tr>
            </tbody>
          </table>
        </template>
      </div>
    </div>

    <!-- Modais -->
    <div v-if="modal === 'avancar'" class="fundo-modal" @mousedown.self="modal = null">
      <form class="modal estreito" @submit.prevent="avancar">
        <h2>{{ ACAO_ETAPA[proximo] }}</h2>
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
            <label>Porto de retirada (vazio)</label>
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
            <label>Porto de entrega (cheio)</label>
            <select v-model="ed.portoEntregaId">
              <option value="">— não informado —</option>
              <option v-for="l in portos" :key="l.id" :value="l.id">{{ l.nome }}{{ l.uf ? ` (${l.uf})` : "" }}</option>
            </select>
          </div>
        </div>
        <div v-if="!portos.length" class="dica pequeno mudo">Nenhum porto cadastrado — <router-link to="/locais">cadastrar em Locais</router-link>.</div>
        <h3 style="margin-bottom: 0">Dados</h3>
        <div class="grade-form">
          <div class="campo"><label>Booking</label><input v-model="ed.booking" maxlength="60" /></div>
          <div class="campo"><label>Navio</label><input v-model="ed.navio" maxlength="120" /></div>
          <div class="campo"><label>Deadline</label><input v-model="ed.deadline" type="datetime-local" /></div>
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
