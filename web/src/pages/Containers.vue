<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import { ROTULO_STATUS, ROTULO_TIPO, FLUXO, fmtHoras, fmtTemp, fmtMoeda, fmtDataHora, fmtFolga } from "../formato.js";
import NovoContainer from "../components/NovoContainer.vue";
import ThOrdenavel from "../components/ThOrdenavel.vue";
import { useOrdenacao } from "../composables/useOrdenacao.js";

const auth = useAuthStore();
const router = useRouter();
const lista = ref([]);
const grupos = ref([]);
const carregando = ref(false);
const erro = ref(null);
const novoAberto = ref(false);
const filtro = reactive({ situacao: "ativos", grupoId: "", status: "", busca: "" });

async function carregar() {
  carregando.value = true;
  try {
    lista.value = await api.containers(filtro);
    erro.value = null;
  } catch (e) {
    erro.value = e.message;
  } finally {
    carregando.value = false;
  }
}

onMounted(async () => {
  grupos.value = await api.listar("grupos").catch(() => []);
  carregar();
});

let atraso = null;
function buscarComAtraso() {
  clearTimeout(atraso);
  atraso = setTimeout(carregar, 350);
}

function criado(c) {
  novoAberto.value = false;
  router.push(`/containers/${c.id}`);
}

// Colunas de situação e prazo: crescente = mais urgente primeiro.
const GRAVIDADE = { VERMELHO: 0, AMARELO: 1, VERDE: 2 };
const ordem = useOrdenacao({
  semaforo: (c) => GRAVIDADE[c.semaforo],
  numero: (c) => c.numero,
  tipo: (c) => ROTULO_TIPO[c.tipo],
  grupo: (c) => `${c.grupo.cliente} / ${c.grupo.fabrica}`,
  armador: (c) => c.armador.nome,
  etapa: (c) => (c.status === "CANCELADO" ? FLUXO.length : FLUXO.indexOf(c.status)),
  estadia: (c) => c.situacao.estadia?.horasRestantes ?? null,
  demurrage: (c) => {
    const d = c.situacao.demurrage;
    if (!d) return null;
    return d.diasExcedidos > 0 ? -d.diasExcedidos : d.diasRestantes;
  },
  temperatura: (c) => c.situacao.temperatura?.ultima?.temperatura ?? null,
  deadline: (c) => (c.deadline ? new Date(c.deadline) : null),
  previsao: (c) => (c.situacao.previsao?.disponivel ? c.situacao.previsao.folgaHoras : null),
});
const linhas = computed(() => ordem.ordenar(lista.value));

function textoDemurrage(d) {
  if (!d) return "—";
  if (d.diasExcedidos > 0) return `+${d.diasExcedidos}d · ${fmtMoeda(d.custo, d.moeda)}`;
  return d.encerrada ? "no prazo" : `${d.diasRestantes}d livres`;
}
</script>

<template>
  <div class="card">
    <div class="linha-entre">
      <div class="filtros">
        <div class="campo">
          <label>Buscar</label>
          <input v-model="filtro.busca" placeholder="Número, booking ou placa" @input="buscarComAtraso" />
        </div>
        <div class="campo">
          <label>Situação</label>
          <select v-model="filtro.situacao" @change="carregar">
            <option value="ativos">Ativos</option>
            <option value="encerrados">Encerrados (entregues/cancelados)</option>
            <option value="todos">Todos</option>
          </select>
        </div>
        <div class="campo">
          <label>Cliente / Fábrica</label>
          <select v-model="filtro.grupoId" @change="carregar">
            <option value="">Todos</option>
            <option v-for="g in grupos" :key="g.id" :value="g.id">{{ g.cliente }} / {{ g.fabrica }}</option>
          </select>
        </div>
        <div class="campo">
          <label>Etapa</label>
          <select v-model="filtro.status" @change="carregar">
            <option value="">Todas</option>
            <option v-for="s in [...FLUXO, 'CANCELADO']" :key="s" :value="s">{{ ROTULO_STATUS[s] }}</option>
          </select>
        </div>
      </div>
      <button v-if="auth.pode('containers.operar')" class="primario" @click="novoAberto = true">+ Novo container</button>
    </div>
  </div>

  <div v-if="erro" class="erro">{{ erro }}</div>

  <div class="card tabela-wrap" style="padding: 0">
    <table>
      <thead>
        <tr>
          <ThOrdenavel chave="semaforo" :ordem="ordem" titulo="Situação: crítico primeiro no crescente"><span class="sr-only">Situação</span></ThOrdenavel>
          <ThOrdenavel chave="numero" :ordem="ordem">Container</ThOrdenavel>
          <ThOrdenavel chave="tipo" :ordem="ordem">Tipo</ThOrdenavel>
          <ThOrdenavel chave="grupo" :ordem="ordem">Cliente / Fábrica</ThOrdenavel>
          <ThOrdenavel chave="armador" :ordem="ordem">Armador</ThOrdenavel>
          <ThOrdenavel chave="etapa" :ordem="ordem" titulo="Na ordem do processo">Etapa</ThOrdenavel>
          <ThOrdenavel chave="estadia" :ordem="ordem" titulo="Pelo tempo que falta para a meta: mais urgente primeiro no crescente">Estadia</ThOrdenavel>
          <ThOrdenavel chave="demurrage" :ordem="ordem" titulo="Pelos dias livres restantes: vencidos primeiro no crescente">Demurrage</ThOrdenavel>
          <ThOrdenavel chave="temperatura" :ordem="ordem">Temperatura</ThOrdenavel>
          <ThOrdenavel chave="deadline" :ordem="ordem">Deadline</ThOrdenavel>
          <ThOrdenavel chave="previsao" :ordem="ordem" titulo="Pela folga até o fim do free time: menor folga primeiro no crescente">Previsão</ThOrdenavel>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in linhas" :key="c.id" class="clicavel" @click="router.push(`/containers/${c.id}`)">
          <td><span class="ponto" :class="c.semaforo" :title="c.semaforo"></span></td>
          <td class="mono negrito">{{ c.numero }}<div v-if="c.booking" class="mudo pequeno">BK {{ c.booking }}</div></td>
          <td>{{ ROTULO_TIPO[c.tipo] }}</td>
          <td>{{ c.grupo.cliente }} / {{ c.grupo.fabrica }}</td>
          <td>{{ c.armador.nome }}</td>
          <td><span class="chip azul">{{ ROTULO_STATUS[c.status] }}</span></td>
          <td :class="c.situacao.estadia && `txt-${c.situacao.estadia.situacao}`">
            <template v-if="c.situacao.estadia">{{ fmtHoras(c.situacao.estadia.horasDecorridas) }} / {{ c.situacao.estadia.metaHoras }}h</template>
            <span v-else class="mudo">—</span>
          </td>
          <td :class="c.situacao.demurrage && `txt-${c.situacao.demurrage.situacao}`">{{ textoDemurrage(c.situacao.demurrage) }}</td>
          <td>
            <template v-if="c.situacao.temperatura?.ultima">
              <span :class="c.situacao.temperatura.foraDaFaixa ? 'txt-VENCIDO' : ''">{{ fmtTemp(c.situacao.temperatura.ultima.temperatura) }}</span>
            </template>
            <span v-else class="mudo">{{ c.reefer ? "sem leitura" : "—" }}</span>
          </td>
          <td :class="c.situacao.deadline && `txt-${c.situacao.deadline.situacao}`">{{ fmtDataHora(c.deadline) }}</td>
          <td>
            <template v-if="c.situacao.previsao?.disponivel">
              {{ fmtDataHora(c.situacao.previsao.previsaoEntrega) }}
              <div class="pequeno" :class="`txt-${c.situacao.previsao.riscoDemurrage === 'CRITICO' ? 'VENCIDO' : c.situacao.previsao.riscoDemurrage}`">
                folga {{ fmtFolga(c.situacao.previsao.folgaHoras) }}
              </div>
            </template>
            <span v-else-if="c.situacao.previsao" class="mudo pequeno" :title="`Falta: ${c.situacao.previsao.faltando.join(', ')}`">sem trajeto</span>
            <span v-else class="mudo">—</span>
          </td>
        </tr>
        <tr v-if="!lista.length && !carregando"><td colspan="11" class="vazio">Nenhum container encontrado.</td></tr>
      </tbody>
    </table>
  </div>

  <NovoContainer v-if="novoAberto" @fechar="novoAberto = false" @criado="criado" />
</template>
