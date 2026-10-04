<script setup>
// Editar trajeto do container: Retirada → [paradas] → Carregamento → [paradas] → Entrega.
// Retirada, carregamento e entrega ficam fixos na ordem (só troca o local); os pontos de parada
// (ex.: Ponto Fiscal) são arrastados para a posição desejada — antes ou depois do carregamento.
// "+ Adicionar ponto" cria uma linha no final; ao escolher o ponto, ele vai para a posição padrão
// do cadastro e pode ser arrastado. Ao salvar, o servidor recalcula distâncias, ciclo e ETA.
import { computed, onMounted, ref } from "vue";
import { api } from "../api.js";
import { ROTULO_POSICAO_PARADA, atendeRegraLocal } from "../formato.js";

const props = defineProps({ container: { type: Object, required: true } });
const emit = defineEmits(["fechar", "salvo"]);

const locais = ref([]);
const gruposParada = ref([]); // Pontos de Carregamento marcados como "pode ser ponto de parada"
const erro = ref(null);
const enviando = ref(false);
let seq = 0;
const linha = (papel, localId, extra = {}) => ({ uid: ++seq, papel, localId: localId ?? "", ...extra });

// Monta a lista inicial a partir do container.
const c = props.container;
// Tipo de Operação sem local de operação: retirada → paradas → entrega (sem carregamento).
const comCarregamento = c.temOperacao !== false;
const antes = (c.paradas ?? []).filter((p) => p.fase === "ANTES_CARREGAMENTO");
const depois = (c.paradas ?? []).filter((p) => p.fase === "APOS_CARREGAMENTO");
const pontos = ref([
  linha("RETIRADA", c.portoRetiradaId),
  ...antes.map((p) => linha("PARADA", p.localId, { paradaId: p.id, passouEm: p.passouEm })),
  ...(comCarregamento ? [linha("CARREGAMENTO", c.localCarregamentoId)] : []),
  ...depois.map((p) => linha("PARADA", p.localId, { paradaId: p.id, passouEm: p.passouEm })),
  linha("ENTREGA", c.portoEntregaId),
]);

onMounted(async () => {
  try {
    const [ls, gs] = await Promise.all([api.locais({ ativos: "1" }), api.listar("grupos", { ativos: "1" })]);
    locais.value = ls;
    gruposParada.value = gs.filter((g) => g.podeSerParada && g.localId);
  } catch (e) {
    erro.value = e.message;
  }
});
// Local inativo que já está no trajeto continua aparecendo.
const incluiAtual = (lista, id) => (id && !lista.some((l) => l.id === id) ? [...lista, { id, nome: "(local inativo)" }] : lista);
// Opções de parada: Pontos Fiscais (função Parada) + Pontos de Carregamento marcados como parada.
const opcoesParada = computed(() => {
  const fiscais = locais.value.filter((l) => l.tipo.funcao === "PARADA");
  const vistos = new Set(fiscais.map((l) => l.id));
  const carregamentos = [];
  for (const g of gruposParada.value) {
    if (vistos.has(g.localId)) continue;
    vistos.add(g.localId);
    carregamentos.push({ id: g.localId, nome: `${g.cliente} / ${g.fabrica}`, uf: g.local?.uf, posicaoParada: g.posicaoParada, pontoCarregamento: true });
  }
  return [...fiscais, ...carregamentos];
});
const opcoes = (p) => {
  if (p.papel === "PARADA") return incluiAtual(opcoesParada.value, p.localId);
  const campo = { RETIRADA: "portoRetiradaId", CARREGAMENTO: "localCarregamentoId", ENTREGA: "portoEntregaId" }[p.papel];
  return incluiAtual(locais.value.filter((l) => atendeRegraLocal(l, c.regrasLocal?.[campo])), p.localId);
};
const ROTULO = { RETIRADA: "Retirada", CARREGAMENTO: "Carregamento", ENTREGA: "Entrega", PARADA: "Ponto de parada" };
const idx = (papel) => pontos.value.findIndex((p) => p.papel === papel);
const faseDe = (i) => (!comCarregamento || i < idx("CARREGAMENTO") ? "ANTES_CARREGAMENTO" : "APOS_CARREGAMENTO");
const foraDoLugar = (i) => pontos.value[i].papel === "PARADA" && (i < idx("RETIRADA") || i > idx("ENTREGA"));

// ----- mover -----
function mover(de, para) {
  const lista = [...pontos.value];
  // Parada só entre a retirada (0) e a entrega (fica antes dela).
  const [item] = lista.splice(de, 1);
  const entrega = lista.findIndex((p) => p.papel === "ENTREGA");
  const destino = Math.max(1, Math.min(para, entrega));
  lista.splice(destino, 0, item);
  pontos.value = lista;
}
const podeSubir = (i) => pontos.value[i].papel === "PARADA" && i > 1;
const podeDescer = (i) => pontos.value[i].papel === "PARADA" && i < idx("ENTREGA") - 1;

// Arrastar (mouse): só as paradas se movem; soltar numa linha coloca na posição dela.
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

// ----- adicionar / remover -----
function adicionar() {
  pontos.value = [...pontos.value, linha("PARADA", "", { nova: true })];
}
// Escolheu o ponto numa linha nova (no final): vai para a posição padrão do cadastro.
function escolheu(p) {
  if (!p.nova) return;
  p.nova = false;
  const local = opcoesParada.value.find((l) => l.id === p.localId);
  const i = pontos.value.indexOf(p);
  const destino = comCarregamento && local?.posicaoParada === "ANTES_CARREGAMENTO" ? idx("CARREGAMENTO") : idx("ENTREGA");
  mover(i, destino > i ? destino - 1 : destino);
}
function remover(i) {
  const p = pontos.value[i];
  if (p.passouEm && !confirm("Este ponto já tem a passagem registrada. O servidor só deixa tirar depois de desfazer a passagem. Tentar mesmo assim?")) return;
  pontos.value = pontos.value.filter((_, j) => j !== i);
}

// A entrega pode ficar "A definir" (v3.7); os outros pontos precisam de local.
const faltaEscolher = computed(() => pontos.value.some((p) => !p.localId && p.papel !== "ENTREGA"));
async function salvar() {
  erro.value = null;
  if (faltaEscolher.value) {
    erro.value = "Escolha o local de todas as linhas (ou remova a linha vazia).";
    return;
  }
  enviando.value = true;
  try {
    const r = await api.salvarTrajeto(props.container.id, pontos.value.map((p) => ({ papel: p.papel, localId: p.localId, ...(p.paradaId ? { paradaId: p.paradaId } : {}) })));
    emit("salvo", r);
  } catch (e) {
    erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}
</script>

<template>
  <div class="fundo-modal" @mousedown.self="emit('fechar')">
    <form class="modal editar-trajeto" @submit.prevent="salvar">
      <h2>Editar trajeto · {{ container.numero }}</h2>
      <p class="mudo pequeno" style="margin-top: 0">
        {{ comCarregamento ? "Retirada, carregamento e entrega" : "Retirada e entrega" }} ficam nessa ordem (troque só o local). <strong>Arraste os pontos de parada</strong> (ou use ↑ ↓) para a posição
        desejada{{ comCarregamento ? " — antes ou depois do carregamento" : "" }}. Ao salvar, distâncias, ciclo e ETA são recalculados{{ container.status === "PROGRAMADO" ? " e o Planejado é refeito" : "" }}.
      </p>
      <div v-if="erro" class="erro" role="alert">{{ erro }}</div>

      <ol class="pontos">
        <li
          v-for="(p, i) in pontos" :key="p.uid"
          :class="['item-rota', p.papel.toLowerCase(), { arrastavel: p.papel === 'PARADA', alvo: alvo === i && arrastando !== i, fora: foraDoLugar(i) }]"
          :draggable="p.papel === 'PARADA'"
          @dragstart="inicioArrasto($event, i)" @dragover="sobre($event, i)" @drop.prevent="soltar(i)" @dragend="arrastando = null; alvo = null"
        >
          <span class="alca" :title="p.papel === 'PARADA' ? 'Arraste para mudar a posição' : 'Posição fixa'" aria-hidden="true">{{ p.papel === "PARADA" ? "⋮⋮" : "•" }}</span>
          <div class="corpo">
            <div class="rotulo">
              {{ ROTULO[p.papel] }}
              <span v-if="comCarregamento && p.papel === 'PARADA' && !foraDoLugar(i) && !p.nova" class="chip pequeno">{{ faseDe(i) === "ANTES_CARREGAMENTO" ? "antes do carregamento" : "depois do carregamento" }}</span>
              <span v-if="p.passouEm" class="chip verde pequeno">passagem registrada</span>
            </div>
            <select v-model="p.localId" :aria-label="ROTULO[p.papel]" :required="p.papel !== 'ENTREGA'" @change="escolheu(p)">
              <option v-if="p.papel === 'ENTREGA'" value="">A definir</option>
              <option v-else value="" disabled>{{ p.papel === "PARADA" ? "Escolha o ponto (ex.: Ponto Fiscal)…" : "Escolha o local…" }}</option>
              <option v-for="l in opcoes(p)" :key="l.id" :value="l.id">
                {{ l.pontoCarregamento ? "Ponto de Carregamento: " : "" }}{{ l.nome }}{{ l.uf ? ` (${l.uf})` : "" }}{{ p.papel === "PARADA" && l.posicaoParada ? ` — ${ROTULO_POSICAO_PARADA[l.posicaoParada].toLowerCase()}` : "" }}
              </option>
            </select>
          </div>
          <div v-if="p.papel === 'PARADA'" class="acoes-ponto">
            <button type="button" class="pequeno" :disabled="!podeSubir(i)" aria-label="Subir" title="Subir" @click="mover(i, i - 1)">↑</button>
            <button type="button" class="pequeno" :disabled="!podeDescer(i)" aria-label="Descer" title="Descer" @click="mover(i, i + 1)">↓</button>
            <button type="button" class="pequeno perigo" aria-label="Remover" title="Remover do trajeto" @click="remover(i)">✕</button>
          </div>
        </li>
      </ol>
      <button type="button" class="adicionar" @click="adicionar">+ Adicionar ponto</button>
      <p v-if="!opcoesParada.length" class="dica pequeno mudo">Nenhum ponto de parada cadastrado. Cadastre um Ponto Fiscal em Cadastros → Locais, ou marque "Pode ser ponto de parada" em Cadastros → Ponto de Carregamento.</p>

      <div class="modal-acoes">
        <button type="button" @click="emit('fechar')">Cancelar</button>
        <button type="submit" class="primario" :disabled="enviando">{{ enviando ? "Recalculando…" : "Salvar e recalcular" }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.editar-trajeto { width: min(620px, 100%); }
.pontos { list-style: none; margin: 12px 0 8px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.item-rota { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--borda); border-radius: 8px; background: #fff; }
.item-rota.retirada, .item-rota.carregamento, .item-rota.entrega { background: var(--azul-fundo); }
.item-rota.arrastavel { cursor: grab; }
.item-rota.alvo { outline: 2px dashed var(--primaria); outline-offset: 2px; }
.item-rota.fora { border-style: dashed; border-color: var(--primaria); }
.alca { width: 18px; text-align: center; color: var(--texto-2); font-weight: 700; user-select: none; }
.corpo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.rotulo { font-size: 12px; font-weight: 600; color: var(--texto-2); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.corpo select { width: 100%; }
.acoes-ponto { display: flex; gap: 4px; }
.acoes-ponto button { min-width: 30px; justify-content: center; }
.adicionar { width: 100%; justify-content: center; border-style: dashed; }
</style>
