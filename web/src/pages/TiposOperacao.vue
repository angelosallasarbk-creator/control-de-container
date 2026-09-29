<script setup>
// Cadastro de Tipos de Operação: cada tipo tem um fluxo de etapas (arrastáveis) com o tipo de local
// e o local sugerido de cada uma, e as etapas que abrem/fecham o free time. O fluxo é copiado para
// o container na criação: mudar um tipo vale só para containers novos.
import { computed, onMounted, reactive, ref } from "vue";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";

const auth = useAuthStore();
const podeEditar = computed(() => auth.pode("cadastros.editar"));
const lista = ref([]);
const tiposLocal = ref([]);
const locais = ref([]);
const gruposParada = ref([]);
const erro = ref(null);
const aviso = ref(null);

const ACOES = ["COLETA", "CHEGADA", "INICIO_OPERACAO", "LIBERACAO", "SAIDA", "PASSAGEM", "ENTREGA"];
const ROTULO_ACAO = {
  COLETA: "Coleta", CHEGADA: "Chegada ao local de operação", INICIO_OPERACAO: "Início da operação (ovação/desova)",
  LIBERACAO: "Liberação", SAIDA: "Saída do local de operação", PASSAGEM: "Passagem (ponto de parada)", ENTREGA: "Entrega",
};
const STATUS_DA_ACAO = { COLETA: "COLETADO", CHEGADA: "NA_FABRICA", INICIO_OPERACAO: "EM_OPERACAO", LIBERACAO: "LIBERADO", SAIDA: "SAIU_FABRICA", ENTREGA: "ENTREGUE_PORTO" };
// Etapas no local de operação: o local é o da chegada (sem tipo de local próprio).
const NO_LOCAL_DA_CHEGADA = ["INICIO_OPERACAO", "LIBERACAO", "SAIDA"];
const temLocal = (acao) => !NO_LOCAL_DA_CHEGADA.includes(acao);

async function carregar() {
  try {
    const [ts, tl, ls, gs] = await Promise.all([api.tiposOperacao(), api.tiposLocal(), api.locais({ ativos: "1" }), api.listar("grupos", { ativos: "1" })]);
    lista.value = ts;
    tiposLocal.value = tl.filter((t) => t.ativo && t.funcao !== "PARADA");
    locais.value = ls;
    gruposParada.value = gs.filter((g) => g.podeSerParada && g.localId);
    erro.value = null;
  } catch (e) {
    erro.value = e.message;
  }
}
onMounted(carregar);

const nomeEtapa = (e) => e.nome || ROTULO_ACAO[e.acao];
// Nome da etapa (do fluxo) que corresponde ao status — usado no free time.
const nomeDoStatus = (lista, status) => {
  const e = lista.find((x) => STATUS_DA_ACAO[x.acao] === status);
  return e ? nomeEtapa(e) : status;
};
const regraTexto = (e) => {
  if (!temLocal(e.acao)) return null;
  if (e.acao === "PASSAGEM") return e.localSugerido?.nome ?? "ponto a escolher";
  const tipo = e.tipoLocal?.nome ?? (e.funcaoLocal === "RETIRADA_ENTREGA" ? "porto/terminal" : e.funcaoLocal === "CARREGAMENTO" ? "fábrica/armazém" : "qualquer local");
  return e.localSugerido ? `${tipo} · ${e.localSugerido.nome}` : tipo;
};
const temOperacao = (t) => t.etapas.some((e) => e.acao === "CHEGADA");

// ---------- Editor ----------
const editando = ref(null); // null | {} (novo) | tipo
const f = reactive({ nome: "", descricao: "", padrao: false, freeTimeInicio: "COLETADO", freeTimeFim: "ENTREGUE_PORTO" });
const etapas = ref([]);
const enviando = ref(false);
const erroModal = ref(null);
let seq = 0;

// Regra de local no select: "" = qualquer; "F:<função>" = qualquer local da função; "T:<id>" = tipo.
const regraDe = (e) => (e.tipoLocalId ? `T:${e.tipoLocalId}` : e.funcaoLocal ? `F:${e.funcaoLocal}` : "");
const linha = (e) => ({ uid: ++seq, acao: e.acao, nome: e.nome ?? "", regra: regraDe(e), localSugeridoId: e.localSugeridoId ?? "" });

function abrir(t) {
  erroModal.value = null;
  editando.value = t ?? {};
  Object.assign(f, {
    nome: t?.nome ?? "", descricao: t?.descricao ?? "", padrao: Boolean(t?.padrao),
    freeTimeInicio: t?.freeTimeInicio ?? "COLETADO", freeTimeFim: t?.freeTimeFim ?? "ENTREGUE_PORTO",
  });
  etapas.value = (t?.etapas ?? [{ acao: "COLETA", funcaoLocal: "RETIRADA_ENTREGA" }, { acao: "ENTREGA", funcaoLocal: "RETIRADA_ENTREGA" }]).map(linha);
}

// Locais que servem para a etapa conforme a regra escolhida.
function opcoesLocal(e) {
  if (e.acao === "PASSAGEM") {
    const fiscais = locais.value.filter((l) => l.tipo.funcao === "PARADA");
    const vistos = new Set(fiscais.map((l) => l.id));
    const extras = gruposParada.value.filter((g) => !vistos.has(g.localId)).map((g) => ({ id: g.localId, nome: `Ponto de Carregamento: ${g.cliente} / ${g.fabrica}` }));
    return [...fiscais, ...extras];
  }
  const [tipo, valor] = e.regra.split(":");
  return locais.value.filter((l) => l.tipo.funcao !== "PARADA" && (!tipo || (tipo === "F" ? l.tipo.funcao === valor : l.tipo.id === Number(valor))));
}
function trocouRegra(e) {
  if (e.localSugeridoId && !opcoesLocal(e).some((l) => l.id === e.localSugeridoId)) e.localSugeridoId = "";
}

// Etapas principais (sem passagens) → status, para o free time.
const statusDoFluxo = computed(() => etapas.value.filter((e) => e.acao !== "PASSAGEM").map((e) => STATUS_DA_ACAO[e.acao]));

// Adicionar: nova etapa antes da Entrega; ações únicas que já existem ficam indisponíveis.
const novaAcao = ref("PASSAGEM");
const acoesDisponiveis = computed(() => ACOES.filter((a) => a === "PASSAGEM" || !etapas.value.some((e) => e.acao === a)));
function adicionar() {
  const acao = novaAcao.value;
  if (!acoesDisponiveis.value.includes(acao)) return;
  const nova = linha({ acao, funcaoLocal: acao === "CHEGADA" ? "CARREGAMENTO" : null });
  // Coloca na posição natural da ação (Chegada/Operação/Saída em ordem; passagem antes da entrega).
  const ordem = ["COLETA", "CHEGADA", "INICIO_OPERACAO", "LIBERACAO", "SAIDA", "ENTREGA"];
  const lista = [...etapas.value];
  let destino = lista.findIndex((e) => e.acao === "ENTREGA");
  if (acao !== "PASSAGEM") {
    const depois = lista.findIndex((e) => e.acao !== "PASSAGEM" && ordem.indexOf(e.acao) > ordem.indexOf(acao));
    if (depois >= 0) destino = depois;
  }
  lista.splice(destino < 0 ? lista.length : destino, 0, nova);
  etapas.value = lista;
  const livres = acoesDisponiveis.value;
  if (!livres.includes(novaAcao.value)) novaAcao.value = "PASSAGEM";
}
const podeRemover = (e) => !["COLETA", "ENTREGA"].includes(e.acao);
function remover(i) {
  etapas.value = etapas.value.filter((_, j) => j !== i);
  if (!statusDoFluxo.value.includes(f.freeTimeInicio)) f.freeTimeInicio = "COLETADO";
  if (!statusDoFluxo.value.includes(f.freeTimeFim)) f.freeTimeFim = "ENTREGUE_PORTO";
}

// Arrastar (mouse, pela alça) e ↑ ↓: Coleta fica no início e Entrega no fim.
function mover(de, para) {
  const lista = [...etapas.value];
  const [item] = lista.splice(de, 1);
  const destino = Math.max(1, Math.min(para, lista.length - 1));
  lista.splice(destino, 0, item);
  etapas.value = lista;
}
const movel = (e) => !["COLETA", "ENTREGA"].includes(e.acao);
const arrastando = ref(null);
const alvo = ref(null);
function inicioArrasto(ev, i) {
  arrastando.value = i;
  ev.dataTransfer.effectAllowed = "move";
  ev.dataTransfer.setData("text/plain", String(i));
}
function sobre(ev, i) {
  if (arrastando.value === null) return;
  ev.preventDefault();
  alvo.value = i;
}
function soltar(i) {
  if (arrastando.value !== null && arrastando.value !== i) mover(arrastando.value, i);
  arrastando.value = null;
  alvo.value = null;
}

async function salvar() {
  erroModal.value = null;
  enviando.value = true;
  try {
    const corpo = {
      ...f,
      etapas: etapas.value.map((e) => {
        const [tipo, valor] = e.regra.split(":");
        return {
          acao: e.acao, nome: e.nome || null,
          funcaoLocal: tipo === "F" ? valor : null, tipoLocalId: tipo === "T" ? Number(valor) : null,
          localSugeridoId: temLocal(e.acao) && e.localSugeridoId ? e.localSugeridoId : null,
        };
      }),
    };
    if (editando.value.id) await api.atualizarTipoOperacao(editando.value.id, corpo);
    else await api.criarTipoOperacao(corpo);
    aviso.value = editando.value.id ? `Tipo "${f.nome}" atualizado (vale para containers novos).` : `Tipo "${f.nome}" criado.`;
    editando.value = null;
    await carregar();
  } catch (e) {
    erroModal.value = e.message;
  } finally {
    enviando.value = false;
  }
}

async function alternarAtivo(t) {
  try {
    await api.atualizarTipoOperacao(t.id, { ativo: !t.ativo });
    await carregar();
  } catch (e) {
    erro.value = e.message;
  }
}
async function excluir(t) {
  if (!confirm(`Excluir o tipo de operação "${t.nome}"?`)) return;
  try {
    await api.excluirTipoOperacao(t.id);
    aviso.value = `Tipo "${t.nome}" excluído.`;
    await carregar();
  } catch (e) {
    erro.value = e.message;
  }
}
</script>

<template>
  <div class="card linha-entre">
    <div>
      <h2 style="margin: 0">Tipos de Operação</h2>
      <div class="mudo pequeno" style="margin-top: 4px">
        Cada tipo define o fluxo que o container segue (coleta, chegada, operação, passagens, entrega), o tipo de local de cada etapa e um
        local sugerido. Sem local de operação não há estadia. Alterar um tipo vale para os containers cadastrados depois.
      </div>
    </div>
    <button v-if="podeEditar" class="primario" @click="abrir(null)">+ Novo tipo</button>
  </div>
  <div v-if="erro && !editando" class="erro">{{ erro }}</div>
  <div v-if="aviso" class="sucesso">{{ aviso }}</div>

  <div class="card" style="padding: 0">
    <div class="tabela-wrap">
      <table>
        <thead>
          <tr><th>Tipo de operação</th><th>Fluxo</th><th>Free time</th><th>Containers</th><th>Situação</th><th v-if="podeEditar"></th></tr>
        </thead>
        <tbody>
          <tr v-for="t in lista" :key="t.id" :style="{ opacity: t.ativo ? 1 : 0.55 }">
            <td class="negrito">
              {{ t.nome }} <span v-if="t.padrao" class="chip azul pequeno">padrão</span>
              <div v-if="t.descricao" class="mudo pequeno" style="font-weight: 400">{{ t.descricao }}</div>
              <div v-if="!temOperacao(t)" class="mudo pequeno" style="font-weight: 400">sem local de operação (sem estadia)</div>
            </td>
            <td>
              <ol class="fluxo-resumo">
                <li v-for="e in t.etapas" :key="e.id" :class="{ passagem: e.acao === 'PASSAGEM' }">
                  <span class="negrito">{{ nomeEtapa(e) }}</span>
                  <span v-if="regraTexto(e)" class="mudo pequeno"> · {{ regraTexto(e) }}</span>
                </li>
              </ol>
            </td>
            <td class="pequeno">{{ nomeDoStatus(t.etapas, t.freeTimeInicio) }} → {{ nomeDoStatus(t.etapas, t.freeTimeFim) }}</td>
            <td>{{ t.containers }}</td>
            <td><span class="chip" :class="t.ativo ? 'verde' : ''">{{ t.ativo ? "Ativo" : "Inativo" }}</span></td>
            <td v-if="podeEditar" style="text-align: right; white-space: nowrap">
              <button class="pequeno" @click="abrir(t)">Editar</button>
              <button v-if="!t.padrao" class="pequeno" @click="alternarAtivo(t)">{{ t.ativo ? "Desativar" : "Ativar" }}</button>
              <button v-if="!t.padrao && !t.containers" class="pequeno perigo" @click="excluir(t)">Excluir</button>
            </td>
          </tr>
          <tr v-if="!lista.length"><td colspan="6" class="vazio">Nenhum tipo de operação cadastrado.</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div v-if="editando" class="fundo-modal" @mousedown.self="editando = null">
    <form class="modal editor-fluxo" @submit.prevent="salvar">
      <h2>{{ editando.id ? `Editar tipo · ${editando.nome}` : "Novo tipo de operação" }}</h2>
      <div v-if="erroModal" class="erro" role="alert">{{ erroModal }}</div>
      <div class="grade-2">
        <div class="campo"><label for="to-nome">Nome *</label><input id="to-nome" v-model="f.nome" required maxlength="60" placeholder="Ex.: Exportação via ferrovia" /></div>
        <div class="campo"><label for="to-desc">Descrição</label><input id="to-desc" v-model="f.descricao" maxlength="300" /></div>
      </div>
      <label class="check"><input v-model="f.padrao" type="checkbox" :disabled="editando.padrao" /> Tipo padrão (usado quando o container não informa o tipo)</label>
      <p v-if="editando.id && editando.containers" class="aviso pequeno">{{ editando.containers }} container(s) usam este tipo e continuam com o fluxo de quando foram cadastrados.</p>

      <h3 class="subtitulo">Fluxo</h3>
      <p class="mudo pequeno" style="margin-top: 0">
        Começa na <strong>Coleta</strong> e termina na <strong>Entrega</strong>. Chegada → (Início da operação → Liberação) → Saída acontecem no mesmo local,
        nessa ordem. <strong>Arraste</strong> as passagens (pontos de parada) para a posição desejada.
      </p>
      <ol class="etapas">
        <li
          v-for="(e, i) in etapas" :key="e.uid"
          :class="['item-etapa', { passagem: e.acao === 'PASSAGEM', arrastavel: movel(e), alvo: alvo === i && arrastando !== i }]"
          @dragover="sobre($event, i)" @drop.prevent="soltar(i)"
        >
          <span
            class="alca" :draggable="movel(e)" :title="movel(e) ? 'Arraste para mudar a posição' : 'Posição fixa'" aria-hidden="true"
            @dragstart="inicioArrasto($event, i)" @dragend="arrastando = null; alvo = null"
          >{{ movel(e) ? "⋮⋮" : "•" }}</span>
          <div class="corpo">
            <div class="rotulo">{{ i + 1 }}. {{ ROTULO_ACAO[e.acao] }}</div>
            <div class="campos">
              <input v-model="e.nome" :aria-label="`Nome da etapa ${i + 1}`" maxlength="60" :placeholder="`Nome (padrão: ${ROTULO_ACAO[e.acao]})`" />
              <template v-if="temLocal(e.acao)">
                <select v-if="e.acao !== 'PASSAGEM'" v-model="e.regra" :aria-label="`Tipo de local da etapa ${i + 1}`" @change="trocouRegra(e)">
                  <option value="">Qualquer local</option>
                  <option value="F:RETIRADA_ENTREGA">Qualquer porto/terminal (retirada/entrega)</option>
                  <option value="F:CARREGAMENTO">Qualquer fábrica/armazém (carregamento)</option>
                  <option v-for="t in tiposLocal" :key="t.id" :value="`T:${t.id}`">Só {{ t.nome }}</option>
                </select>
                <select v-model="e.localSugeridoId" :aria-label="`Local sugerido da etapa ${i + 1}`" :required="e.acao === 'PASSAGEM'">
                  <option value="">{{ e.acao === "PASSAGEM" ? "Escolha o ponto de parada…" : "Sem local sugerido" }}</option>
                  <option v-for="l in opcoesLocal(e)" :key="l.id" :value="l.id">{{ l.nome }}{{ l.uf ? ` (${l.uf})` : "" }}</option>
                </select>
              </template>
              <span v-else class="mudo pequeno">no local da chegada</span>
            </div>
          </div>
          <div class="acoes-ponto">
            <button type="button" class="pequeno" :disabled="!movel(e) || i <= 1" aria-label="Subir" title="Subir" @click="mover(i, i - 1)">↑</button>
            <button type="button" class="pequeno" :disabled="!movel(e) || i >= etapas.length - 2" aria-label="Descer" title="Descer" @click="mover(i, i + 1)">↓</button>
            <button type="button" class="pequeno perigo" :disabled="!podeRemover(e)" aria-label="Remover" title="Remover etapa" @click="remover(i)">✕</button>
          </div>
        </li>
      </ol>
      <div class="adicionar-etapa">
        <select v-model="novaAcao" aria-label="Etapa a adicionar">
          <option v-for="a in acoesDisponiveis" :key="a" :value="a">{{ ROTULO_ACAO[a] }}</option>
        </select>
        <button type="button" @click="adicionar">+ Adicionar etapa</button>
      </div>

      <h3 class="subtitulo">Free time (demurrage)</h3>
      <div class="grade-2">
        <div class="campo">
          <label for="to-ft-ini">Começa em</label>
          <select id="to-ft-ini" v-model="f.freeTimeInicio">
            <option v-for="s in statusDoFluxo" :key="s" :value="s">{{ nomeDoStatus(etapas, s) }}</option>
          </select>
        </div>
        <div class="campo">
          <label for="to-ft-fim">Termina em</label>
          <select id="to-ft-fim" v-model="f.freeTimeFim">
            <option v-for="s in statusDoFluxo" :key="s" :value="s">{{ nomeDoStatus(etapas, s) }}</option>
          </select>
        </div>
      </div>

      <div class="modal-acoes">
        <button type="button" @click="editando = null">Cancelar</button>
        <button type="submit" class="primario" :disabled="enviando">{{ enviando ? "Salvando…" : "Salvar" }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.fluxo-resumo { margin: 0; padding-left: 18px; font-size: 13px; }
.fluxo-resumo li.passagem { color: var(--texto-2); font-style: italic; }
.editor-fluxo { width: min(760px, 100%); }
.subtitulo { font-size: 14px; margin: 16px 0 6px; }
.grade-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.check { display: flex; gap: 8px; align-items: center; font-size: 13px; margin: 4px 0; }
.etapas { list-style: none; margin: 8px 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.item-etapa { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--borda); border-radius: 8px; background: var(--azul-fundo); }
.item-etapa.passagem { background: #fff; border-style: dashed; }
.item-etapa.alvo { outline: 2px dashed var(--primaria); outline-offset: 2px; }
.item-etapa .alca { width: 18px; text-align: center; color: var(--texto-2); font-weight: 700; user-select: none; }
.item-etapa.arrastavel .alca { cursor: grab; }
.corpo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.rotulo { font-size: 12px; font-weight: 600; color: var(--texto-2); }
.campos { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; align-items: center; }
.campos input, .campos select { width: 100%; min-width: 0; }
.acoes-ponto { display: flex; gap: 4px; }
.acoes-ponto button { min-width: 30px; justify-content: center; }
.adicionar-etapa { display: flex; gap: 8px; }
.adicionar-etapa select { flex: 1; }
@media (max-width: 640px) {
  .grade-2, .campos { grid-template-columns: 1fr; }
}
</style>
