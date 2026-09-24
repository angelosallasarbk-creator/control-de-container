<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { api } from "../api.js";
import { ROTULO_TIPO, paraInputLocal, deInputLocal, fmtTemp, fmtMoeda } from "../formato.js";

const emit = defineEmits(["fechar", "criado"]);

const grupos = ref([]);
const armadores = ref([]);
const produtos = ref([]);
const erro = ref(null);
const enviando = ref(false);
const pedirConfirmacaoDigito = ref(false);

const f = reactive({
  numero: "", tipo: "REEFER_40", grupoId: "", armadorId: "", produtoId: "",
  booking: "", navio: "", deadline: "", placa: "", motorista: "", lacre: "", posicaoPatio: "", observacao: "",
  jaColetado: false, coletadoEm: paraInputLocal(),
});

onMounted(async () => {
  try {
    [grupos.value, armadores.value, produtos.value] = await Promise.all([
      api.listar("grupos", { ativos: 1 }),
      api.listar("armadores", { ativos: 1 }),
      api.listar("produtos", { ativos: 1 }),
    ]);
  } catch (e) {
    erro.value = e.message;
  }
});

const reefer = computed(() => f.tipo.startsWith("REEFER"));
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
      grupoId: Number(f.grupoId) || null,
      armadorId: Number(f.armadorId) || null,
      produtoId: reefer.value ? Number(f.produtoId) || null : null,
      booking: f.booking, navio: f.navio, placa: f.placa, motorista: f.motorista, lacre: f.lacre,
      posicaoPatio: f.posicaoPatio, observacao: f.observacao,
      deadline: deInputLocal(f.deadline),
      coletadoEm: f.jaColetado ? deInputLocal(f.coletadoEm) : null,
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
        Antes de cadastrar containers, cadastre pelo menos um <router-link to="/cadastros/grupos">Cliente / Fábrica</router-link> e um
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
          <label>Cliente / Fábrica *</label>
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
        <div class="campo"><label>Booking</label><input v-model="f.booking" maxlength="60" /></div>
        <div class="campo"><label>Navio</label><input v-model="f.navio" maxlength="120" /></div>
        <div class="campo"><label>Deadline (cut-off)</label><input v-model="f.deadline" type="datetime-local" /></div>
        <div class="campo"><label>Placa</label><input v-model="f.placa" maxlength="20" /></div>
        <div class="campo"><label>Motorista</label><input v-model="f.motorista" maxlength="120" /></div>
        <div class="campo"><label>Lacre</label><input v-model="f.lacre" maxlength="60" /></div>
        <div class="campo"><label>Posição no pátio</label><input v-model="f.posicaoPatio" maxlength="40" placeholder="ex.: A-03" /></div>
      </div>
      <div class="campo"><label>Observação</label><textarea v-model="f.observacao" rows="2" maxlength="1000"></textarea></div>

      <label class="linha"><input v-model="f.jaColetado" type="checkbox" /> O container já foi coletado no porto (inicia a contagem de demurrage)</label>
      <div v-if="f.jaColetado" class="campo" style="max-width: 260px">
        <label>Data/hora da coleta</label>
        <input v-model="f.coletadoEm" type="datetime-local" required />
      </div>

      <div class="modal-acoes">
        <button type="button" @click="emit('fechar')">Cancelar</button>
        <button type="submit" class="primario" :disabled="enviando || faltamCadastros">{{ enviando ? "Salvando…" : "Cadastrar" }}</button>
      </div>
    </form>
  </div>
</template>
