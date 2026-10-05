<script setup>
import { onMounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import { ROTULO_STATUS, ROTULO_TIPO, FLUXO, rotuloEtapa, fmtHoras, fmtTemp, fmtMoeda, fmtDataHora, fmtFolga } from "../formato.js";
import NovoContainer from "../components/NovoContainer.vue";
import ImportarContainers from "../components/ImportarContainers.vue";
import Icone from "../components/Icone.vue";
import MarcaQr from "../components/MarcaQr.vue";
import ThOrdenavel from "../components/ThOrdenavel.vue";
import { useOrdenacaoServidor } from "../composables/useOrdenacaoServidor.js";
import { filtroContainers } from "../filtroContainers.js";
import Paginacao from "../components/Paginacao.vue";
import { usePaginacaoServidor } from "../composables/usePaginacaoServidor.js";

const auth = useAuthStore();
const router = useRouter();
const lista = ref([]);
const carregando = ref(false);
const erro = ref(null);
const novoAberto = ref(false);
const uploadAberto = ref(false);
const filtro = reactive({ situacao: "ativos", status: "", busca: "" });

// Lista paginada no servidor (v3.10): busca, filtros, ordenação e página rodam no banco e só a página
// pedida chega ao navegador (antes baixava todos os containers, 6 MB com ~1.300 ativos).
let sequencia = 0;
async function carregar() {
  const minha = ++sequencia; // descarta a resposta de uma consulta mais antiga (digitação rápida, cliques seguidos)
  carregando.value = true;
  try {
    const r = await api.listaContainers({
      situacao: filtro.situacao, status: filtro.status, busca: filtro.busca.trim(),
      regioes: filtroContainers.regioes.join(","), grupos: filtroContainers.grupos.join(","), semQr: filtroContainers.semQr ? "1" : "",
      ...ordem.parametros(), pagina: pag.pagina.value, limite: pag.porPagina.value,
    });
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
// Filtro, busca ou ordem mudou: volta à primeira página e busca de novo.
function refazer() {
  pag.voltarAoInicio();
  carregar();
}
const pag = usePaginacaoServidor("containers", carregar);
const ordem = useOrdenacaoServidor(refazer);

onMounted(carregar);
// Região / Ponto de Carregamento / Sem QR (cabeçalho): valem também no servidor.
watch(() => [filtroContainers.regioes, filtroContainers.grupos, filtroContainers.semQr], refazer, { deep: true });

let atraso = null;
function buscarComAtraso() {
  clearTimeout(atraso);
  atraso = setTimeout(refazer, 350);
}

function criado(c) {
  novoAberto.value = false;
  router.push(`/containers/${c.id}`);
}

// A ordenação das colunas é feita no servidor (useOrdenacaoServidor): crescente = mais urgente primeiro.

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
          <label>Etapa</label>
          <select v-model="filtro.status" @change="carregar">
            <option value="">Todas</option>
            <option v-for="s in [...FLUXO, 'CANCELADO']" :key="s" :value="s">{{ ROTULO_STATUS[s] }}</option>
          </select>
        </div>
      </div>
      <span v-if="auth.pode('containers.operar')" class="linha" style="gap: 8px">
        <button type="button" title="Cadastrar vários containers por planilha" @click="uploadAberto = true"><Icone nome="upload" :tamanho="16" /> Upload</button>
        <button class="primario" @click="novoAberto = true">+ Novo container</button>
      </span>
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
          <ThOrdenavel chave="grupo" :ordem="ordem">Ponto de Carregamento</ThOrdenavel>
          <ThOrdenavel chave="armador" :ordem="ordem">Armador</ThOrdenavel>
          <th>Motorista / Placa</th>
          <ThOrdenavel chave="etapa" :ordem="ordem" titulo="Na ordem do processo">Etapa</ThOrdenavel>
          <ThOrdenavel chave="estadia" :ordem="ordem" titulo="Pelo tempo que falta para a meta: mais urgente primeiro no crescente">Estadia</ThOrdenavel>
          <ThOrdenavel chave="demurrage" :ordem="ordem" titulo="Pelos dias livres restantes: vencidos primeiro no crescente">Demurrage</ThOrdenavel>
          <ThOrdenavel chave="temperatura" :ordem="ordem">Temperatura</ThOrdenavel>
          <ThOrdenavel chave="deadline" :ordem="ordem">Deadline</ThOrdenavel>
          <ThOrdenavel chave="previsao" :ordem="ordem" titulo="Pela folga até o fim do free time: menor folga primeiro no crescente">Previsão</ThOrdenavel>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in lista" :key="c.id" class="clicavel" @click="router.push(`/containers/${c.id}`)">
          <td><span class="ponto" :class="c.semaforo" :title="c.semaforo"></span></td>
          <td class="mono negrito" style="white-space: nowrap"><MarcaQr v-if="c.qrVinculado" /> {{ c.numero }}<div v-if="c.booking" class="mudo pequeno">BK {{ c.booking }}</div></td>
          <td>{{ ROTULO_TIPO[c.tipo] }}</td>
          <td>{{ c.grupo.cliente }} / {{ c.grupo.fabrica }}</td>
          <td>{{ c.armador.nome }}</td>
          <td style="white-space: nowrap"><template v-if="c.motorista || c.placa">{{ c.motorista ?? "—" }}<div class="mudo pequeno mono">{{ c.placa ?? "sem placa" }}</div></template><span v-else class="mudo">—</span></td>
          <td><span class="chip azul">{{ rotuloEtapa(c, c.status) }}</span></td>
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
            <span v-if="c.situacao.previsao?.parcial" class="txt-ATENCAO pequeno">entrega a definir</span>
            <template v-else-if="c.situacao.previsao?.disponivel">
              {{ fmtDataHora(c.situacao.previsao.previsaoEntrega) }}
              <div class="pequeno" :class="`txt-${c.situacao.previsao.riscoDemurrage === 'CRITICO' ? 'VENCIDO' : c.situacao.previsao.riscoDemurrage}`">
                folga {{ fmtFolga(c.situacao.previsao.folgaHoras) }}
              </div>
            </template>
            <span v-else-if="c.situacao.previsao" class="mudo pequeno" :title="`Falta: ${c.situacao.previsao.faltando.join(', ')}`">sem trajeto</span>
            <span v-else class="mudo">—</span>
          </td>
        </tr>
        <tr v-if="!lista.length && !carregando"><td colspan="12" class="vazio">Nenhum container encontrado.</td></tr>
        <tr v-else-if="!lista.length"><td colspan="12" class="vazio">Carregando…</td></tr>
      </tbody>
    </table>
      <Paginacao :p="pag" />
  </div>

  <NovoContainer v-if="novoAberto" @fechar="novoAberto = false" @criado="criado" />
  <ImportarContainers v-if="uploadAberto" @fechar="uploadAberto = false" @importados="carregar" />
</template>
