<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import { fmtDataHora } from "../formato.js";
import EtiquetaVisual from "../components/EtiquetaVisual.vue";
import ThOrdenavel from "../components/ThOrdenavel.vue";
import { useOrdenacao } from "../composables/useOrdenacao.js";

const auth = useAuthStore();
const lista = ref([]);
const erro = ref(null);
const aviso = ref(null);
const carregando = ref(false);
// todos: só administrador (ver as etiquetas de todos os usuários, para suporte).
const filtro = reactive({ estado: "", impressao: "", busca: "", todos: "" });
const ehAdmin = computed(() => auth.usuario?.perfil === "ADMIN");
const selecionadas = ref(new Set());
const quantidade = ref(10);
const gerando = ref(false);

const ESTADO = {
  LIVRE: { rotulo: "Livre", cor: "azul", dica: "Impressa, ainda sem container" },
  VINCULADA: { rotulo: "No container", cor: "verde", dica: "Ligada a um container em andamento" },
  ENCERRADA: { rotulo: "Encerrada", cor: "", dica: "Container já entregue/cancelado" },
  CANCELADA: { rotulo: "Cancelada", cor: "vermelho", dica: "Inutilizada ou substituída" },
};

// ---------- Impressão (preferências lembradas no navegador) ----------
const CHAVE_PREFS = "cc_impressao_etiquetas";
const cfgImpressao = ref({ modelos: [], dpis: [203, 300, 600], urlPublica: "", sugestoes: [] });
const imp = reactive({ modelo: "50x30", larguraMm: 50, alturaMm: 30, dpi: 203 });
try {
  // "baseUrl" de versões antigas é descartado: o endereço agora vem só de Configurações.
  const { baseUrl: descartado, ...prefs } = JSON.parse(localStorage.getItem(CHAVE_PREFS) || "{}");
  Object.assign(imp, prefs);
  if (descartado !== undefined) localStorage.setItem(CHAVE_PREFS, JSON.stringify(imp));
} catch {
  // sem preferências salvas
}
watch(imp, () => {
  try {
    localStorage.setItem(CHAVE_PREFS, JSON.stringify(imp));
  } catch {
    // sem armazenamento: só não lembra
  }
});
watch(() => imp.modelo, (m) => {
  const modelo = cfgImpressao.value.modelos.find((x) => x.chave === m);
  if (modelo) Object.assign(imp, { larguraMm: modelo.larguraMm, alturaMm: modelo.alturaMm });
});
// Endereço que vai dentro do QR: sempre o de Configurações → Etiquetas QR.
const configCarregada = ref(false);
const baseUrl = computed(() => cfgImpressao.value.urlPublica || "");
const enderecoProblema = computed(() => {
  if (!configCarregada.value) return null;
  if (!baseUrl.value) return "O endereço do sistema para o QR ainda não foi configurado — sem ele não dá para imprimir.";
  if (/\/\/(localhost|127\.0\.0\.1)/i.test(baseUrl.value)) return "O endereço configurado usa \"localhost\", que o celular não abre.";
  return null;
});

async function carregar() {
  carregando.value = true;
  try {
    lista.value = await api.etiquetas(filtro);
    erro.value = null;
  } catch (e) {
    erro.value = e.message;
  } finally {
    carregando.value = false;
  }
}

// A impressão pelo navegador acontece em outra aba: ao voltar para esta, atualiza a coluna "Impressa".
function aoVoltarParaAba() {
  if (document.visibilityState === "visible") carregar();
}
onMounted(() => document.addEventListener("visibilitychange", aoVoltarParaAba));
onBeforeUnmount(() => document.removeEventListener("visibilitychange", aoVoltarParaAba));

onMounted(async () => {
  try {
    cfgImpressao.value = await api.configImpressao();
    configCarregada.value = true;
  } catch (e) {
    erro.value = e.message;
  }
  carregar();
});

let atraso = null;
watch(() => filtro.busca, () => {
  clearTimeout(atraso);
  atraso = setTimeout(carregar, 350);
});

async function gerar() {
  gerando.value = true;
  erro.value = null;
  try {
    const r = await api.gerarEtiquetas(quantidade.value);
    aviso.value = `${r.etiquetas.length} etiqueta(s) gerada(s) e selecionada(s) — confira o modelo e imprima abaixo.`;
    filtro.estado = "";
    await carregar();
    selecionadas.value = new Set(r.etiquetas.map((e) => e.id));
    document.getElementById("painel-impressao")?.scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    erro.value = e.message;
  } finally {
    gerando.value = false;
  }
}

// ---------- Seleção ----------
const ordem = useOrdenacao({
  codigo: (e) => e.codigo,
  estado: (e) => ["LIVRE", "VINCULADA", "ENCERRADA", "CANCELADA"].indexOf(e.estado),
  container: (e) => e.container?.numero ?? null,
  ligada: (e) => (e.vinculadaEm ? new Date(e.vinculadaEm) : null),
  leituras: (e) => e.leituras,
  impressa: (e) => e.vezesImpressa,
  geradaPor: (e) => e.geradaPor,
  criada: (e) => new Date(e.criadoEm),
});
const linhas = computed(() => ordem.ordenar(lista.value));
// A seleção serve para imprimir e para excluir. Imprimir ignora as canceladas; excluir só
// vale para as nunca usadas (o servidor confere de novo).
const todasMarcadas = computed(() => lista.value.length > 0 && lista.value.every((e) => selecionadas.value.has(e.id)));
function alternar(e) {
  const s = new Set(selecionadas.value);
  s.has(e.id) ? s.delete(e.id) : s.add(e.id);
  selecionadas.value = s;
}
function alternarTodas() {
  selecionadas.value = todasMarcadas.value ? new Set() : new Set(lista.value.map((e) => e.id));
}
const selecionadasLista = computed(() => lista.value.filter((e) => selecionadas.value.has(e.id)));
const paraImprimir = computed(() => selecionadasLista.value.filter((e) => e.estado !== "CANCELADA"));
const exemplo = computed(() => paraImprimir.value[0] ?? lista.value.find((e) => e.estado !== "CANCELADA") ?? null);

// ---------- Excluir selecionadas (uma única requisição) ----------
// Só etiqueta nunca usada (sem container e sem leitura); as usadas ficam como prova — Cancelar.
const podeExcluir = (e) => !e.container && e.leituras === 0;
const excluiveis = computed(() => selecionadasLista.value.filter(podeExcluir));
const naoExcluiveis = computed(() => selecionadasLista.value.filter((e) => !podeExcluir(e)));
const excluindo = ref(false);

async function excluirSelecionadas() {
  const alvo = excluiveis.value;
  if (!alvo.length) return;
  const impressas = alvo.filter((e) => e.vezesImpressa > 0).length;
  const texto =
    `Excluir ${alvo.length} etiqueta(s)? Esta ação não pode ser desfeita.` +
    (impressas ? `\n\n⚠ ${impressas} já foram impressas: se alguma estiver colada em um container, o QR dela deixará de funcionar.` : "") +
    (naoExcluiveis.value.length ? `\n\n${naoExcluiveis.value.length} selecionada(s) já foram usadas (container/leituras) e serão mantidas — para essas, use Cancelar.` : "");
  if (!confirm(texto)) return;
  excluindo.value = true;
  erro.value = null;
  aviso.value = null;
  try {
    // Todas as selecionadas vão juntas numa única requisição; o servidor separa e confere.
    const r = await api.excluirEtiquetas(selecionadasLista.value.map((e) => e.id));
    const partes = [`${r.excluidas.length} etiqueta(s) excluída(s).`];
    if (r.bloqueadas.length) {
      partes.push(`${r.bloqueadas.length} mantida(s): ${r.bloqueadas.slice(0, 5).map((b) => `${b.codigo} (${b.motivo})`).join("; ")}${r.bloqueadas.length > 5 ? "…" : ""}`);
    }
    aviso.value = partes.join(" ");
    selecionadas.value = new Set();
    await carregar();
  } catch (e) {
    erro.value = e.message;
  } finally {
    excluindo.value = false;
  }
}
const urlDe = (e) => `${baseUrl.value.replace(/\/+$/, "")}/q/${e.token}`;
// Pré-visualização cabe em ~320px de largura.
const escalaPrevia = computed(() => Math.min(1.6, 320 / (imp.larguraMm * 3.78)));

// Reimprimir gera uma segunda etiqueta igual (mesmo QR) — pede confirmação.
function confirmarReimpressao() {
  const ja = paraImprimir.value.filter((e) => e.vezesImpressa > 0);
  if (!ja.length) return true;
  const exemplos = ja.slice(0, 5).map((e) => `${e.codigo} (${e.vezesImpressa}x, última ${fmtDataHora(e.impressaEm)})`).join("\n");
  return confirm(
    `${ja.length} etiqueta(s) selecionada(s) JÁ FORAM IMPRESSAS:\n${exemplos}${ja.length > 5 ? "\n…" : ""}\n\n` +
      "Reimprimir cria cópias com o mesmo QR. Cole só uma de cada no container e descarte a outra. Reimprimir mesmo assim?"
  );
}

function imprimirNavegador() {
  if (!confirmarReimpressao()) return;
  const ids = paraImprimir.value.map((e) => e.id).join(",");
  const q = new URLSearchParams({ ids, w: imp.larguraMm, h: imp.alturaMm });
  window.open(`/etiquetas/imprimir?${q}`, "_blank");
}

async function baixarZpl() {
  erro.value = null;
  if (!confirmarReimpressao()) return;
  try {
    const zpl = await api.baixarZpl({
      ids: paraImprimir.value.map((e) => e.id), larguraMm: imp.larguraMm, alturaMm: imp.alturaMm, dpi: Number(imp.dpi),
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([zpl], { type: "text/plain" }));
    link.download = `etiquetas-${imp.larguraMm}x${imp.alturaMm}mm-${imp.dpi}dpi.zpl`;
    link.click();
    URL.revokeObjectURL(link.href);
    await carregar(); // atualiza "Impressa"
  } catch (e) {
    erro.value = e.message;
  }
}

async function cancelar(e) {
  const motivo = prompt(`Cancelar a etiqueta ${e.codigo}? Ela deixará de funcionar.\n\nMotivo (ex.: rasgou, impressão falhou):`);
  if (!motivo) return;
  try {
    await api.cancelarEtiqueta(e.id, motivo);
    await carregar();
  } catch (err) {
    erro.value = err.message;
  }
}
</script>

<template>
  <div class="card linha-entre">
    <div>
      <h2 style="margin: 0">Etiquetas QR</h2>
      <div class="mudo pequeno" style="margin-top: 4px">
        Cada etiqueta vai colada em um container e vale para uma viagem. Na primeira leitura pelo celular, a pessoa informa o número do
        container e a temperatura; nas seguintes, só a temperatura. O login é exigido.
      </div>
      <div class="pequeno" style="margin-top: 6px">
        🔒 <strong>{{ filtro.todos ? "Mostrando as etiquetas de todos os usuários." : "Você vê e imprime apenas as etiquetas que você gerou." }}</strong>
        {{ " " }}<span class="mudo">Assim uma fábrica não imprime as etiquetas de outra. QR não abriu? Use
          <router-link to="/leitura">Registrar pelo código</router-link> com o código impresso.</span>
      </div>
    </div>
    <form v-if="auth.pode('etiquetas.emitir')" class="linha" @submit.prevent="gerar">
      <div class="campo" style="width: 110px"><label>Quantidade</label><input v-model.number="quantidade" type="number" min="1" max="500" required /></div>
      <button type="submit" class="primario" :disabled="gerando" style="align-self: flex-end">{{ gerando ? "Gerando…" : "Gerar etiquetas" }}</button>
    </form>
  </div>
  <div v-if="erro" class="erro">{{ erro }}</div>
  <div v-if="aviso" class="sucesso">{{ aviso }}</div>

  <!-- Impressão -->
  <div id="painel-impressao" class="card">
    <div class="linha-entre">
      <h2 style="margin: 0">Imprimir {{ paraImprimir.length ? `${paraImprimir.length} etiqueta(s) selecionada(s)` : "(selecione na lista abaixo)" }}</h2>
    </div>
    <div class="impressao">
      <div class="grade-form" style="flex: 1">
        <div class="campo">
          <label>Modelo da etiqueta</label>
          <select v-model="imp.modelo">
            <option v-for="m in cfgImpressao.modelos" :key="m.chave" :value="m.chave">{{ m.nome }}</option>
            <option value="custom">Personalizado…</option>
          </select>
        </div>
        <div class="campo"><label>Largura (mm)</label><input v-model.number="imp.larguraMm" type="number" min="20" max="200" step="1" @input="imp.modelo = 'custom'" /></div>
        <div class="campo"><label>Altura (mm)</label><input v-model.number="imp.alturaMm" type="number" min="15" max="300" step="1" @input="imp.modelo = 'custom'" /></div>
        <div class="campo">
          <label>Resolução da Zebra (só para ZPL)</label>
          <select v-model.number="imp.dpi">
            <option v-for="d in cfgImpressao.dpis" :key="d" :value="d">{{ d }} dpi{{ d === 203 ? " (mais comum)" : "" }}</option>
          </select>
        </div>
        <div v-if="enderecoProblema" class="campo erro" style="grid-column: 1 / -1; margin: 0">
          {{ enderecoProblema }}
          <router-link v-if="auth.pode('administrar')" to="/configuracoes?aba=etiquetas">Configurar agora</router-link>
          <span v-else>Peça a um administrador (Configurações → Etiquetas QR).</span>
        </div>
      </div>
      <div class="previa">
        <div class="mudo pequeno" style="margin-bottom: 6px">Pré-visualização ({{ imp.larguraMm }} × {{ imp.alturaMm }} mm)</div>
        <div v-if="exemplo && baseUrl" class="previa-caixa" :style="{ width: `${imp.larguraMm * 3.78 * escalaPrevia}px`, height: `${imp.alturaMm * 3.78 * escalaPrevia}px` }">
          <div :style="{ transform: `scale(${escalaPrevia})`, transformOrigin: 'top left' }">
            <EtiquetaVisual :codigo="exemplo.codigo" :url="urlDe(exemplo)" :largura-mm="imp.larguraMm" :altura-mm="imp.alturaMm" />
          </div>
        </div>
        <div v-else class="mudo pequeno">{{ exemplo ? "A prévia aparece depois de configurar o endereço do QR." : "Gere etiquetas para ver a prévia." }}</div>
      </div>
    </div>
    <div class="linha" style="margin-top: 12px">
      <button class="primario" :disabled="!auth.pode('etiquetas.emitir') || !paraImprimir.length || !baseUrl || !!enderecoProblema" @click="imprimirNavegador">🖨 Imprimir pelo navegador</button>
      <button :disabled="!auth.pode('etiquetas.emitir') || !paraImprimir.length || !baseUrl || !!enderecoProblema" @click="baixarZpl">⬇ Baixar arquivo ZPL (Zebra)</button>
      <span class="mudo pequeno">
        Navegador: escolha a Zebra e o mesmo tamanho de papel na janela de impressão, margens "Nenhuma", escala 100%.
        ZPL: envie o arquivo direto à impressora (ex.: Zebra Setup Utilities → "Enviar arquivo").
      </span>
    </div>
  </div>

  <!-- Lista -->
  <div class="card" style="padding: 0">
    <div class="filtros" style="padding: 12px 16px">
      <div class="campo">
        <label>Situação</label>
        <select v-model="filtro.estado" @change="carregar">
          <option value="">Todas</option>
          <option v-for="(e, v) in ESTADO" :key="v" :value="v">{{ e.rotulo }}</option>
        </select>
      </div>
      <div class="campo">
        <label>Impressão</label>
        <select v-model="filtro.impressao" @change="carregar">
          <option value="">Todas</option>
          <option value="nao">Ainda não impressas</option>
          <option value="sim">Já impressas</option>
        </select>
      </div>
      <div class="campo"><label>Buscar</label><input v-model="filtro.busca" placeholder="Código da etiqueta ou nº do container" /></div>
      <label v-if="ehAdmin" class="linha pequeno" style="gap: 6px; padding-bottom: 8px">
        <input type="checkbox" :checked="filtro.todos === '1'" @change="filtro.todos = $event.target.checked ? '1' : ''; selecionadas = new Set(); carregar()" />
        Ver de todos os usuários (administrador)
      </label>
    </div>
    <!-- Barra de ações da seleção -->
    <div v-if="selecionadas.size" class="barra-selecao">
      <strong>{{ selecionadasLista.length }} selecionada(s)</strong>
      <button
        v-if="auth.pode('etiquetas.cancelar')" class="pequeno perigo" :disabled="!excluiveis.length || excluindo"
        :title="excluiveis.length ? 'Exclui as selecionadas que nunca foram usadas' : 'Nenhuma selecionada pode ser excluída (já usadas)'"
        @click="excluirSelecionadas"
      >
        🗑 {{ excluindo ? "Excluindo…" : `Excluir selecionadas${naoExcluiveis.length && excluiveis.length ? ` (${excluiveis.length})` : ""}` }}
      </button>
      <button class="pequeno" @click="selecionadas = new Set()">Limpar seleção</button>
      <span v-if="naoExcluiveis.length" class="mudo pequeno">
        {{ naoExcluiveis.length }} já usada(s) (container/leituras) não pode(m) ser excluída(s) — use Cancelar.
      </span>
    </div>
    <div class="tabela-wrap">
      <table>
        <thead>
          <tr>
            <th style="width: 36px"><input type="checkbox" :checked="todasMarcadas" aria-label="Selecionar todas" @change="alternarTodas" /></th>
            <ThOrdenavel chave="codigo" :ordem="ordem">Etiqueta</ThOrdenavel>
            <ThOrdenavel chave="estado" :ordem="ordem">Situação</ThOrdenavel>
            <ThOrdenavel chave="container" :ordem="ordem">Container</ThOrdenavel>
            <ThOrdenavel chave="ligada" :ordem="ordem">Ligada em</ThOrdenavel>
            <ThOrdenavel chave="leituras" :ordem="ordem">Leituras</ThOrdenavel>
            <ThOrdenavel chave="impressa" :ordem="ordem" titulo="Quantas vezes foi enviada para a impressora">Impressa</ThOrdenavel>
            <ThOrdenavel v-if="filtro.todos" chave="geradaPor" :ordem="ordem">Gerada por</ThOrdenavel>
            <ThOrdenavel chave="criada" :ordem="ordem">Gerada em</ThOrdenavel>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in linhas" :key="e.id">
            <td><input type="checkbox" :checked="selecionadas.has(e.id)" :aria-label="`Selecionar ${e.codigo}`" @change="alternar(e)" /></td>
            <td class="mono negrito">{{ e.codigo }}</td>
            <td>
              <span class="chip" :class="ESTADO[e.estado].cor" :title="ESTADO[e.estado].dica">{{ ESTADO[e.estado].rotulo }}</span>
              <div v-if="e.motivoCancelamento" class="mudo pequeno">{{ e.motivoCancelamento }}</div>
            </td>
            <td>
              <router-link v-if="e.container" :to="`/containers/${e.container.id}`" class="mono">{{ e.container.numero }}</router-link>
              <span v-else class="mudo">—</span>
            </td>
            <td class="pequeno">{{ fmtDataHora(e.vinculadaEm) }}<div v-if="e.vinculadaPor" class="mudo">{{ e.vinculadaPor }}</div></td>
            <td>{{ e.leituras }}</td>
            <td class="pequeno">
              <span v-if="!e.vezesImpressa" class="chip azul">não impressa</span>
              <template v-else>
                <span class="chip" :class="e.vezesImpressa > 1 ? 'amarelo' : 'verde'" :title="e.vezesImpressa > 1 ? 'Impressa mais de uma vez: pode haver cópia' : ''">{{ e.vezesImpressa }}×</span>
                <div class="mudo">{{ fmtDataHora(e.impressaEm) }}</div>
              </template>
            </td>
            <td v-if="filtro.todos" class="pequeno">{{ e.geradaPor }}</td>
            <td class="pequeno">{{ fmtDataHora(e.criadoEm) }}</td>
            <td style="text-align: right; white-space: nowrap">
              <a :href="`/q/${e.token}`" target="_blank" rel="noopener" class="pequeno" title="Abre a página que o celular vê">abrir</a>
              <button v-if="auth.pode('etiquetas.cancelar') && ['LIVRE', 'VINCULADA'].includes(e.estado)" class="pequeno perigo" style="margin-left: 8px" @click="cancelar(e)">Cancelar</button>
            </td>
          </tr>
          <tr v-if="!lista.length && !carregando"><td :colspan="filtro.todos ? 10 : 9" class="vazio">Nenhuma etiqueta ainda. {{ auth.pode("etiquetas.emitir") ? "Informe a quantidade e clique em Gerar etiquetas." : "" }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.impressao { display: flex; gap: 20px; flex-wrap: wrap; margin-top: 12px; }
.previa { min-width: 280px; }
.barra-selecao { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 16px; background: var(--azul-fundo); border-top: 1px solid var(--borda); }
.previa-caixa { border: 1px dashed var(--borda); box-shadow: var(--sombra); overflow: hidden; background: #fff; }
</style>
