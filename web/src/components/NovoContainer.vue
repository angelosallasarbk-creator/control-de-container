<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { api } from "../api.js";
import { ROTULO_TIPO, paraInputLocal, deInputLocal, fmtTemp, fmtMoeda } from "../formato.js";
import PrevisaoCiclo from "./PrevisaoCiclo.vue";

const emit = defineEmits(["fechar", "criado"]);

const grupos = ref([]);
const armadores = ref([]);
const produtos = ref([]);
const tiposOperacao = ref([]);
const erro = ref(null);
const enviando = ref(false);
const pedirConfirmacaoDigito = ref(false);

const f = reactive({
  numero: "", tipo: "REEFER_40", tipoOperacaoId: "", grupoId: "", armadorId: "", produtoId: "",
  portoRetiradaId: "", localCarregamentoId: "", portoEntregaId: "",
  booking: "", navio: "", deadline: "", placa: "", motorista: "", lacre: "", posicaoPatio: "", observacao: "",
  jaColetado: false, coletadoEm: paraInputLocal(), coletaProgramadaEm: "",
});
const locais = ref([]);

onMounted(async () => {
  try {
    [grupos.value, armadores.value, produtos.value, locais.value, tiposOperacao.value] = await Promise.all([
      api.listar("grupos", { ativos: 1 }),
      api.listar("armadores", { ativos: 1 }),
      api.listar("produtos", { ativos: 1 }),
      api.locais({ ativos: 1 }),
      api.tiposOperacao({ ativos: "1" }),
    ]);
    const padrao = tiposOperacao.value.find((t) => t.padrao) ?? tiposOperacao.value[0];
    if (padrao) f.tipoOperacaoId = padrao.id;
  } catch (e) {
    erro.value = e.message;
  }
});

// Tipo de Operação: define as etapas e o tipo de local de cada ponto do trajeto.
const tipoOperacao = computed(() => tiposOperacao.value.find((t) => t.id === Number(f.tipoOperacaoId)) ?? null);
const etapaDoTipo = (acao) => tipoOperacao.value?.etapas.find((e) => e.acao === acao) ?? null;
const temOperacao = computed(() => !tipoOperacao.value || Boolean(etapaDoTipo("CHEGADA")));
// Locais que atendem a etapa (tipo específico, função ou qualquer um); sem tipo: o padrão de sempre.
function locaisDaEtapa(acao, funcaoPadrao) {
  const e = etapaDoTipo(acao);
  const semParada = locais.value.filter((l) => l.tipo.funcao !== "PARADA");
  if (!tipoOperacao.value) return semParada.filter((l) => l.tipo.funcao === funcaoPadrao);
  if (e?.tipoLocalId) return semParada.filter((l) => l.tipo.id === e.tipoLocalId);
  if (e?.funcaoLocal) return semParada.filter((l) => l.tipo.funcao === e.funcaoLocal);
  return semParada;
}
const portos = computed(() => locaisDaEtapa("COLETA", "RETIRADA_ENTREGA"));
const entregas = computed(() => locaisDaEtapa("ENTREGA", "RETIRADA_ENTREGA"));
const carregamentos = computed(() => locaisDaEtapa("CHEGADA", "CARREGAMENTO"));
const nomeEtapa = (acao, padrao) => etapaDoTipo(acao)?.nome || padrao;
// Passagens (pontos de parada) do fluxo que entram sozinhas no trajeto.
const passagens = computed(() => (tipoOperacao.value?.etapas ?? []).filter((e) => e.acao === "PASSAGEM" && e.localSugerido));

// Trocou o tipo: aplica os locais sugeridos e limpa os que não servem mais.
watch(tipoOperacao, (t) => {
  if (!t) return;
  for (const [campo, acao, lista] of [["portoRetiradaId", "COLETA", portos], ["localCarregamentoId", "CHEGADA", carregamentos], ["portoEntregaId", "ENTREGA", entregas]]) {
    const sugerido = etapaDoTipo(acao)?.localSugeridoId;
    if (sugerido) f[campo] = sugerido;
    else if (f[campo] && !lista.value.some((l) => l.id === Number(f[campo]))) f[campo] = "";
  }
  if (!temOperacao.value) f.localCarregamentoId = "";
  else if (!f.localCarregamentoId && grupo.value?.localId && carregamentos.value.some((l) => l.id === grupo.value.localId)) f.localCarregamentoId = grupo.value.localId;
});

// Local de carregamento vem do Ponto de Carregamento escolhido (pode ser trocado, ex.: armazém).
watch(() => f.grupoId, () => {
  if (!temOperacao.value || etapaDoTipo("CHEGADA")?.localSugeridoId) return;
  if (grupo.value?.localId && carregamentos.value.some((l) => l.id === grupo.value.localId)) f.localCarregamentoId = grupo.value.localId;
});
// Local de entrega costuma ser o mesmo da retirada: preenche se ainda estiver vazio (e servir).
watch(() => f.portoRetiradaId, (novo) => {
  if (novo && !f.portoEntregaId && entregas.value.some((l) => l.id === Number(novo))) f.portoEntregaId = novo;
});

// Simulação "se coletar agora" assim que o trajeto estiver completo.
const simulacao = ref(null);
const simulando = ref(false);
let seqSimulacao = 0;
watch(
  () => [f.tipoOperacaoId, f.portoRetiradaId, f.localCarregamentoId, f.portoEntregaId, f.grupoId, f.armadorId, f.deadline],
  async () => {
    if (!f.portoRetiradaId || (temOperacao.value && !f.localCarregamentoId) || !f.portoEntregaId) {
      simulacao.value = null;
      return;
    }
    const seq = ++seqSimulacao;
    simulando.value = true;
    try {
      const r = await api.estimarRota({
        tipoOperacaoId: f.tipoOperacaoId || undefined,
        portoRetiradaId: f.portoRetiradaId, localCarregamentoId: temOperacao.value ? f.localCarregamentoId : undefined, portoEntregaId: f.portoEntregaId,
        grupoId: f.grupoId, armadorId: f.armadorId, deadline: deInputLocal(f.deadline),
      });
      if (seq === seqSimulacao) simulacao.value = r;
    } catch (e) {
      if (seq === seqSimulacao) simulacao.value = { disponivel: false, faltando: [e.message] };
    } finally {
      if (seq === seqSimulacao) simulando.value = false;
    }
  }
);

const reefer = computed(() => f.tipo.startsWith("REEFER"));
const ROTULO_ACAO_CURTO = { COLETA: "Coleta", CHEGADA: "Chegada", INICIO_OPERACAO: "Operação", LIBERACAO: "Liberação", SAIDA: "Saída", ENTREGA: "Entrega" };
const grupo = computed(() => grupos.value.find((g) => g.id === Number(f.grupoId)));
const armador = computed(() => armadores.value.find((a) => a.id === Number(f.armadorId)));
const produto = computed(() => produtos.value.find((p) => p.id === Number(f.produtoId)));
const faltamCadastros = computed(() => !grupos.value.length || !armadores.value.length);

async function salvar(confirmarDigito = false) {
  erro.value = null;
  enviando.value = true;
  try {
    const criado = await api.criarContainer({
      numero: f.numero,
      tipo: f.tipo,
      tipoOperacaoId: Number(f.tipoOperacaoId) || undefined,
      grupoId: Number(f.grupoId) || null,
      armadorId: Number(f.armadorId) || null,
      produtoId: reefer.value ? Number(f.produtoId) || null : null,
      portoRetiradaId: Number(f.portoRetiradaId) || null,
      localCarregamentoId: temOperacao.value ? Number(f.localCarregamentoId) || null : null,
      portoEntregaId: Number(f.portoEntregaId) || null,
      booking: f.booking, navio: f.navio, placa: f.placa, motorista: f.motorista, lacre: f.lacre,
      posicaoPatio: f.posicaoPatio, observacao: f.observacao,
      deadline: deInputLocal(f.deadline),
      coletadoEm: f.jaColetado ? deInputLocal(f.coletadoEm) : null,
      coletaProgramadaEm: f.jaColetado ? null : deInputLocal(f.coletaProgramadaEm),
      confirmarDigito,
    });
    emit("criado", criado);
  } catch (e) {
    if (e.codigo === "DIGITO_INVALIDO") pedirConfirmacaoDigito.value = true;
    else erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}
</script>

<template>
  <div class="fundo-modal" @mousedown.self="emit('fechar')">
    <form class="modal" @submit.prevent="salvar(false)">
      <h2>Novo container</h2>
      <div v-if="faltamCadastros" class="aviso">
        Antes de cadastrar containers, cadastre pelo menos um <router-link to="/cadastros/grupos">Ponto de Carregamento</router-link> e um
        <router-link to="/cadastros/armadores">Armador</router-link>.
      </div>
      <div v-if="erro" class="erro">{{ erro }}</div>
      <div v-if="pedirConfirmacaoDigito" class="aviso">
        O dígito verificador de <strong class="mono">{{ f.numero.toUpperCase() }}</strong> não confere com o padrão ISO 6346 — normalmente é erro de digitação.
        Confira o número na porta do container.
        <div class="linha" style="margin-top: 8px">
          <button type="button" class="pequeno" @click="pedirConfirmacaoDigito = false">Vou corrigir</button>
          <button type="button" class="pequeno perigo" @click="pedirConfirmacaoDigito = false; salvar(true)">O número está correto, cadastrar assim</button>
        </div>
      </div>

      <div class="grade-form">
        <div v-if="tiposOperacao.length" class="campo">
          <label for="nc-tipo-op">Tipo de operação *</label>
          <select id="nc-tipo-op" v-model="f.tipoOperacaoId" required>
            <option v-for="t in tiposOperacao" :key="t.id" :value="t.id">{{ t.nome }}</option>
          </select>
          <span v-if="tipoOperacao" class="dica">{{ tipoOperacao.etapas.filter((e) => e.acao !== "PASSAGEM").map((e) => e.nome || ROTULO_ACAO_CURTO[e.acao]).join(" → ") }}</span>
        </div>
        <div class="campo">
          <label>Número do container *</label>
          <input v-model="f.numero" class="mono" placeholder="ABCU1234567" required maxlength="15" @input="pedirConfirmacaoDigito = false" />
        </div>
        <div class="campo">
          <label>Tipo *</label>
          <select v-model="f.tipo" required>
            <option v-for="(rotulo, valor) in ROTULO_TIPO" :key="valor" :value="valor">{{ rotulo }}</option>
          </select>
        </div>
        <div class="campo">
          <label>Ponto de Carregamento *</label>
          <select v-model="f.grupoId" required>
            <option value="" disabled>Selecione…</option>
            <option v-for="g in grupos" :key="g.id" :value="g.id">{{ g.cliente }} / {{ g.fabrica }}</option>
          </select>
          <span v-if="grupo" class="dica">Meta de estadia: {{ grupo.metaEstadiaHoras }}h</span>
        </div>
        <div class="campo">
          <label>Armador *</label>
          <select v-model="f.armadorId" required>
            <option value="" disabled>Selecione…</option>
            <option v-for="a in armadores" :key="a.id" :value="a.id">{{ a.nome }}</option>
          </select>
          <span v-if="armador" class="dica">Free time {{ armador.freeTimeDias }} dias · {{ fmtMoeda(armador.valorDiaria, armador.moeda) }}/dia</span>
        </div>
        <div v-if="reefer" class="campo">
          <label>Produto (faixa de temperatura) *</label>
          <select v-model="f.produtoId" required>
            <option value="" disabled>Selecione…</option>
            <option v-for="p in produtos" :key="p.id" :value="p.id">{{ p.nome }}</option>
          </select>
          <span v-if="produto" class="dica">Setpoint {{ fmtTemp(produto.setpoint) }} · faixa {{ fmtTemp(produto.tempMin) }} a {{ fmtTemp(produto.tempMax) }}</span>
        </div>
      </div>

      <h3 style="margin-bottom: 0">Trajeto</h3>
      <div class="grade-form">
        <div class="campo">
          <label for="nc-retirada">{{ nomeEtapa("COLETA", "Local de retirada (vazio)") }}</label>
          <select id="nc-retirada" v-model="f.portoRetiradaId">
            <option value="">— não informado —</option>
            <option v-for="l in portos" :key="l.id" :value="l.id">{{ l.nome }}{{ l.uf ? ` (${l.uf})` : "" }}</option>
          </select>
        </div>
        <div v-if="temOperacao" class="campo">
          <label for="nc-carregamento">{{ nomeEtapa("CHEGADA", "Local de carregamento") }}</label>
          <select id="nc-carregamento" v-model="f.localCarregamentoId">
            <option value="">— não informado —</option>
            <option v-for="l in carregamentos" :key="l.id" :value="l.id">{{ l.nome }}{{ l.uf ? ` (${l.uf})` : "" }}</option>
          </select>
        </div>
        <div class="campo">
          <label for="nc-entrega">{{ nomeEtapa("ENTREGA", "Local de entrega (cheio)") }}</label>
          <select id="nc-entrega" v-model="f.portoEntregaId">
            <option value="">— não informado —</option>
            <option v-for="l in entregas" :key="l.id" :value="l.id">{{ l.nome }}{{ l.uf ? ` (${l.uf})` : "" }}</option>
          </select>
        </div>
      </div>
      <div v-if="passagens.length" class="dica pequeno">Pontos de parada do fluxo: {{ passagens.map((e) => e.localSugerido.nome).join(", ") }} (entram no trajeto; dá para ajustar depois em "Editar trajeto").</div>
      <div v-if="!portos.length" class="dica pequeno mudo">Nenhum local de retirada/entrega (porto, terminal…) cadastrado — <router-link to="/locais">cadastrar em Locais</router-link>. O trajeto é opcional, mas sem ele não há previsão de risco.</div>
      <div v-if="simulando" class="mudo pequeno">Calculando rota…</div>
      <div v-else-if="simulacao" class="card" style="background: var(--superficie-2); box-shadow: none">
        <PrevisaoCiclo :p="simulacao" :free-time-dias="armador?.freeTimeDias ?? null" compacto />
      </div>

      <div class="grade-form">
        <div class="campo"><label>Booking</label><input v-model="f.booking" maxlength="60" /></div>
        <div class="campo"><label>Navio</label><input v-model="f.navio" maxlength="120" /></div>
        <div class="campo"><label>Deadline (cut-off)</label><input v-model="f.deadline" type="datetime-local" /></div>
        <div class="campo"><label>Placa</label><input v-model="f.placa" maxlength="20" /></div>
        <div class="campo"><label>Motorista</label><input v-model="f.motorista" maxlength="120" /></div>
        <div class="campo"><label>Lacre</label><input v-model="f.lacre" maxlength="60" /></div>
        <div class="campo"><label>Posição no pátio</label><input v-model="f.posicaoPatio" maxlength="40" placeholder="ex.: A-03" /></div>
      </div>
      <div class="campo"><label>Observação</label><textarea v-model="f.observacao" rows="2" maxlength="1000"></textarea></div>

      <label class="linha"><input v-model="f.jaColetado" type="checkbox" /> O container já foi coletado (inicia a contagem de demurrage)</label>
      <div v-if="f.jaColetado" class="campo" style="max-width: 260px">
        <label>Data/hora da coleta</label>
        <input v-model="f.coletadoEm" type="datetime-local" required />
      </div>
      <div v-else class="campo" style="max-width: 320px">
        <label>Coleta programada para</label>
        <input v-model="f.coletaProgramadaEm" type="datetime-local" />
        <span class="dica">Se passar deste horário sem a coleta registrada, o sistema abre o alerta "Atraso na coleta".</span>
      </div>

      <div class="modal-acoes">
        <button type="button" @click="emit('fechar')">Cancelar</button>
        <button type="submit" class="primario" :disabled="enviando || faltamCadastros">{{ enviando ? "Salvando…" : "Cadastrar" }}</button>
      </div>
    </form>
  </div>
</template>
