<script setup>
import { computed, onMounted, ref } from "vue";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import { fmtMoeda, fmtTemp } from "../formato.js";

// Uma tela para os três cadastros de apoio; a configuração abaixo define colunas e campos.
const props = defineProps({ recurso: { type: String, required: true } });
const auth = useAuthStore();

const CONFIG = {
  grupos: {
    titulo: "Cliente / Fábrica",
    ajuda: "Cada combinação Cliente / Fábrica é um grupo de operação no pátio, com sua própria meta de estadia.",
    colunas: [
      { rotulo: "Cliente", valor: (r) => r.cliente },
      { rotulo: "Fábrica", valor: (r) => r.fabrica },
      { rotulo: "Meta de estadia", valor: (r) => `${r.metaEstadiaHoras}h` },
      { rotulo: "Alerta antes", valor: (r) => `${r.alertaEstadiaHoras}h` },
      { rotulo: "Custo/h excedida", valor: (r) => (r.custoEstadiaPorHora ? fmtMoeda(r.custoEstadiaPorHora) : "—") },
    ],
    campos: [
      { chave: "cliente", rotulo: "Cliente", tipo: "text", obrigatorio: true },
      { chave: "fabrica", rotulo: "Fábrica", tipo: "text", obrigatorio: true },
      { chave: "metaEstadiaHoras", rotulo: "Meta de estadia (horas)", tipo: "number", obrigatorio: true, min: 1 },
      { chave: "alertaEstadiaHoras", rotulo: "Avisar quando faltarem (horas)", tipo: "number", obrigatorio: true, min: 0, padrao: 6 },
      { chave: "custoEstadiaPorHora", rotulo: "Custo por hora excedida (R$, opcional)", tipo: "number", step: "0.01", min: 0 },
    ],
  },
  armadores: {
    titulo: "Armadores",
    ajuda: "Free time e diária de demurrage por armador. A contagem começa na coleta no porto; o dia da coleta é o dia 1.",
    colunas: [
      { rotulo: "Armador", valor: (r) => r.nome },
      { rotulo: "Free time", valor: (r) => `${r.freeTimeDias} dias` },
      { rotulo: "Diária", valor: (r) => fmtMoeda(r.valorDiaria, r.moeda) },
      { rotulo: "Alerta antes", valor: (r) => `${r.alertaDemurrageDias} dia(s)` },
    ],
    campos: [
      { chave: "nome", rotulo: "Nome do armador", tipo: "text", obrigatorio: true },
      { chave: "freeTimeDias", rotulo: "Free time (dias)", tipo: "number", obrigatorio: true, min: 0 },
      { chave: "valorDiaria", rotulo: "Valor da diária", tipo: "number", obrigatorio: true, step: "0.01", min: 0 },
      { chave: "moeda", rotulo: "Moeda", tipo: "select", opcoes: ["USD", "BRL", "EUR"], padrao: "USD" },
      { chave: "alertaDemurrageDias", rotulo: "Avisar quando faltarem (dias)", tipo: "number", obrigatorio: true, min: 0, padrao: 2 },
    ],
  },
  produtos: {
    titulo: "Produtos (faixa de temperatura)",
    ajuda: "Faixa aceitável para containers reefer. Fora da faixa gera alerta de Atenção na hora e Crítico após a tolerância.",
    colunas: [
      { rotulo: "Produto", valor: (r) => r.nome },
      { rotulo: "Setpoint", valor: (r) => fmtTemp(r.setpoint) },
      { rotulo: "Faixa", valor: (r) => `${fmtTemp(r.tempMin)} a ${fmtTemp(r.tempMax)}` },
      { rotulo: "Tolerância", valor: (r) => `${r.toleranciaMinutos} min` },
    ],
    campos: [
      { chave: "nome", rotulo: "Nome do produto", tipo: "text", obrigatorio: true },
      { chave: "setpoint", rotulo: "Setpoint (°C)", tipo: "number", obrigatorio: true, step: "0.1" },
      { chave: "tempMin", rotulo: "Temperatura mínima (°C)", tipo: "number", obrigatorio: true, step: "0.1" },
      { chave: "tempMax", rotulo: "Temperatura máxima (°C)", tipo: "number", obrigatorio: true, step: "0.1" },
      { chave: "toleranciaMinutos", rotulo: "Tolerância fora da faixa (min)", tipo: "number", obrigatorio: true, min: 0, padrao: 30 },
    ],
  },
};

const cfg = computed(() => CONFIG[props.recurso]);
const lista = ref([]);
const erro = ref(null);
const editando = ref(null); // null | {} (novo) | registro
const form = ref({});
const enviando = ref(false);

async function carregar() {
  try {
    lista.value = await api.listar(props.recurso);
    erro.value = null;
  } catch (e) {
    erro.value = e.message;
  }
}
onMounted(carregar);

function abrir(registro) {
  editando.value = registro ?? {};
  form.value = Object.fromEntries(cfg.value.campos.map((c) => [c.chave, registro ? registro[c.chave] ?? "" : c.padrao ?? ""]));
  erro.value = null;
}

async function salvar() {
  enviando.value = true;
  erro.value = null;
  try {
    const dados = { ...form.value };
    for (const c of cfg.value.campos) if (c.tipo === "number" && dados[c.chave] === "") dados[c.chave] = null;
    if (editando.value.id) await api.atualizar(props.recurso, editando.value.id, dados);
    else await api.criar(props.recurso, dados);
    editando.value = null;
    await carregar();
  } catch (e) {
    erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}

async function alternarAtivo(r) {
  try {
    await api.atualizar(props.recurso, r.id, { ativo: !r.ativo });
    await carregar();
  } catch (e) {
    erro.value = e.message;
  }
}

async function excluir(r) {
  if (!confirm("Excluir este cadastro? Só é possível se ele nunca foi usado em um container.")) return;
  try {
    await api.excluir(props.recurso, r.id);
    await carregar();
  } catch (e) {
    erro.value = e.message;
  }
}
</script>

<template>
  <div v-if="!cfg" class="erro">Cadastro inexistente.</div>
  <template v-else>
    <div class="card linha-entre">
      <div>
        <h2 style="margin: 0">{{ cfg.titulo }}</h2>
        <div class="mudo pequeno" style="margin-top: 4px">{{ cfg.ajuda }} Alterações valem para containers novos; os já cadastrados mantêm os prazos da época.</div>
      </div>
      <button v-if="auth.pode('cadastros')" class="primario" @click="abrir(null)">+ Novo</button>
    </div>
    <div v-if="erro && !editando" class="erro">{{ erro }}</div>

    <div class="card tabela-wrap" style="padding: 0">
      <table>
        <thead>
          <tr>
            <th v-for="col in cfg.colunas" :key="col.rotulo">{{ col.rotulo }}</th>
            <th>Containers</th>
            <th>Situação</th>
            <th v-if="auth.pode('cadastros')"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in lista" :key="r.id" :style="{ opacity: r.ativo ? 1 : 0.55 }">
            <td v-for="col in cfg.colunas" :key="col.rotulo">{{ col.valor(r) }}</td>
            <td>{{ r._count.containers }}</td>
            <td><span class="chip" :class="r.ativo ? 'verde' : ''">{{ r.ativo ? "Ativo" : "Inativo" }}</span></td>
            <td v-if="auth.pode('cadastros')" style="text-align: right; white-space: nowrap">
              <button class="pequeno" @click="abrir(r)">Editar</button>
              <button class="pequeno" @click="alternarAtivo(r)">{{ r.ativo ? "Desativar" : "Ativar" }}</button>
              <button v-if="!r._count.containers" class="pequeno perigo" @click="excluir(r)">Excluir</button>
            </td>
          </tr>
          <tr v-if="!lista.length"><td :colspan="cfg.colunas.length + 3" class="vazio">Nenhum cadastro ainda.</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="editando" class="fundo-modal" @mousedown.self="editando = null">
      <form class="modal estreito" @submit.prevent="salvar">
        <h2>{{ editando.id ? "Editar" : "Novo" }} · {{ cfg.titulo }}</h2>
        <div v-if="erro" class="erro">{{ erro }}</div>
        <div v-for="c in cfg.campos" :key="c.chave" class="campo">
          <label>{{ c.rotulo }}{{ c.obrigatorio ? " *" : "" }}</label>
          <select v-if="c.tipo === 'select'" v-model="form[c.chave]">
            <option v-for="o in c.opcoes" :key="o" :value="o">{{ o }}</option>
          </select>
          <input v-else v-model="form[c.chave]" :type="c.tipo" :required="c.obrigatorio" :min="c.min" :step="c.step" />
        </div>
        <div class="modal-acoes">
          <button type="button" @click="editando = null">Cancelar</button>
          <button type="submit" class="primario" :disabled="enviando">Salvar</button>
        </div>
      </form>
    </div>
  </template>
</template>
