<script setup>
import { inject, onMounted, reactive, ref, watch } from "vue";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import { ROTULO_ALERTA, rotuloEtapa, fmtDataHora, tempoDesde } from "../formato.js";
import ReconhecerAlerta from "../components/ReconhecerAlerta.vue";
import ThOrdenavel from "../components/ThOrdenavel.vue";
import { useOrdenacaoServidor } from "../composables/useOrdenacaoServidor.js";
import Paginacao from "../components/Paginacao.vue";
import { usePaginacaoServidor } from "../composables/usePaginacaoServidor.js";

const atualizarAlertas = inject("atualizarAlertas", () => {});
const auth = useAuthStore();
const lista = ref([]);
const grupos = ref([]);
const erro = ref(null);
const carregando = ref(false);
const selecionado = ref(null);
const filtro = reactive({ estado: "abertos", tipo: "", grupoId: "" });

// Lista paginada no servidor (v3.11): filtro, ordem e página rodam no banco; só a página chega ao navegador.
let sequencia = 0;
async function carregar() {
  const minha = ++sequencia; // descarta a resposta de uma consulta mais antiga
  carregando.value = true;
  try {
    const r = await api.alertas({ ...filtro, ...ordem.parametros(), pagina: pag.pagina.value, limite: pag.porPagina.value });
    if (minha !== sequencia) return;
    lista.value = r.itens;
    pag.aplicar(r);
    erro.value = null;
  } catch (e) {
    if (minha === sequencia) erro.value = e.message;
  } finally {
    if (minha === sequencia) carregando.value = false;
  }
}
// Filtro ou ordem mudou: volta à primeira página.
function refazer() {
  pag.voltarAoInicio();
  carregar();
}
const pag = usePaginacaoServidor("alertas", carregar);
// Nível: crescente = crítico primeiro. Tratamento: pendentes primeiro no crescente.
const ordem = useOrdenacaoServidor(refazer, { ordem: "nivel", dir: "asc" });
onMounted(async () => {
  grupos.value = await api.listar("grupos").catch(() => []);
  carregar();
});
watch(() => [filtro.estado, filtro.tipo, filtro.grupoId], refazer);

function reconhecido() {
  selecionado.value = null;
  carregar();
  atualizarAlertas();
}

</script>

<template>
  <div class="card filtros">
    <div class="campo">
      <label>Mostrar</label>
      <select v-model="filtro.estado">
        <option value="abertos">Abertos</option>
        <option value="historico">Encerrados</option>
      </select>
    </div>
    <div class="campo">
      <label>Tipo</label>
      <select v-model="filtro.tipo">
        <option value="">Todos</option>
        <option v-for="(r, v) in ROTULO_ALERTA" :key="v" :value="v">{{ r }}</option>
      </select>
    </div>
    <div class="campo">
      <label>Ponto de Carregamento</label>
      <select v-model="filtro.grupoId">
        <option value="">Todos</option>
        <option v-for="g in grupos" :key="g.id" :value="g.id">{{ g.cliente }} / {{ g.fabrica }}</option>
      </select>
    </div>
  </div>

  <div v-if="erro" class="erro">{{ erro }}</div>

  <div class="card tabela-wrap" style="padding: 0">
    <table>
      <thead>
        <tr>
          <ThOrdenavel chave="nivel" :ordem="ordem" titulo="Crítico primeiro no crescente">Nível</ThOrdenavel>
          <ThOrdenavel chave="tipo" :ordem="ordem">Tipo</ThOrdenavel>
          <ThOrdenavel chave="container" :ordem="ordem">Container</ThOrdenavel>
          <ThOrdenavel chave="grupo" :ordem="ordem">Ponto de Carregamento</ThOrdenavel>
          <ThOrdenavel chave="mensagem" :ordem="ordem">Mensagem</ThOrdenavel>
          <ThOrdenavel chave="aberto" :ordem="ordem" titulo="Mais antigo primeiro no crescente">Aberto</ThOrdenavel>
          <ThOrdenavel chave="tratamento" :ordem="ordem" titulo="Pendentes (não reconhecidos) primeiro no crescente">Tratamento</ThOrdenavel>
        </tr>
      </thead>
      <tbody>
        <tr v-for="a in lista" :key="a.id">
          <td><span class="chip" :class="a.nivel === 'CRITICO' ? 'vermelho' : 'amarelo'">{{ a.nivel === "CRITICO" ? "Crítico" : "Atenção" }}</span></td>
          <td class="negrito">{{ ROTULO_ALERTA[a.tipo] }}</td>
          <td>
            <router-link :to="`/containers/${a.container.id}`" class="mono">{{ a.container.numero }}</router-link>
            <div class="mudo pequeno">{{ rotuloEtapa(a.container, a.container.status) }}</div>
          </td>
          <td>{{ a.container.grupo.cliente }} / {{ a.container.grupo.fabrica }}</td>
          <td>{{ a.mensagem }}</td>
          <td class="pequeno">
            {{ fmtDataHora(a.abertoEm) }}
            <div class="mudo">{{ a.encerradoEm ? `encerrado ${fmtDataHora(a.encerradoEm)}` : `há ${tempoDesde(a.abertoEm)}` }}</div>
          </td>
          <td class="pequeno">
            <template v-if="a.reconhecidoEm">✔ {{ a.reconhecidoPor }}<div class="mudo">{{ a.acaoTomada }}</div></template>
            <button v-else-if="!a.encerradoEm && auth.pode('containers.operar')" class="pequeno" @click="selecionado = a">Reconhecer</button>
            <span v-else class="mudo">—</span>
          </td>
        </tr>
        <tr v-if="!lista.length && !carregando">
          <td colspan="7" class="vazio">{{ filtro.estado === "abertos" ? "Nenhum alerta aberto. 👍" : "Nenhum alerta encerrado." }}</td>
        </tr>
      </tbody>
    </table>
      <Paginacao :p="pag" />
  </div>

  <ReconhecerAlerta v-if="selecionado" :alerta="selecionado" @fechar="selecionado = null" @reconhecido="reconhecido" />
</template>
