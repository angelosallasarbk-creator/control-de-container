<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import { ROTULO_FUNCAO_LOCAL } from "../formato.js";

const auth = useAuthStore();
const lista = ref([]);
const tipos = ref([]);
const config = ref(null);
const erro = ref(null);
const aviso = ref(null);
const filtroTipo = ref("");
const busca = ref("");

const editando = ref(null); // null | {} (novo) | registro
const f = reactive({ nome: "", tipoId: "", endereco: "", cidade: "", uf: "", latitude: "", longitude: "", filaHoras: "" });
const enviando = ref(false);

// Busca de endereço
const termo = ref("");
const resultados = ref([]);
const buscando = ref(false);
const erroBusca = ref(null);

async function carregar() {
  try {
    [lista.value, config.value, tipos.value] = await Promise.all([api.locais(), api.configuracao(), api.tiposLocal()]);
    erro.value = null;
  } catch (e) {
    erro.value = e.message;
  }
}
onMounted(carregar);

const visiveis = computed(() => {
  const t = busca.value.trim().toLowerCase();
  return lista.value.filter(
    (l) => (!filtroTipo.value || l.tipoId === filtroTipo.value) && (!t || `${l.nome} ${l.cidade ?? ""} ${l.uf ?? ""}`.toLowerCase().includes(t))
  );
});
const semCoordenadas = computed(() => lista.value.filter((l) => l.ativo && !l.temCoordenadas).length);

// ---------- Tipo do local ----------
const NOVO_TIPO = "__novo";
const tipoDoForm = computed(() => tipos.value.find((t) => t.id === f.tipoId) ?? null);
const retiradaEntrega = computed(() => tipoDoForm.value?.funcao === "RETIRADA_ENTREGA");
// Opções do formulário: tipos ativos (+ o atual, mesmo inativo). Local já usado em containers
// só pode trocar por tipo da mesma função (o servidor também confere).
const opcoesTipo = computed(() => {
  const atual = editando.value?.tipo;
  return tipos.value.filter((t) => (t.ativo || t.id === atual?.id) && (!(editando.value?.emUso > 0) || !atual || t.funcao === atual.funcao));
});
let tipoAnterior = "";
watch(() => f.tipoId, (novo, antigo) => {
  if (novo === NOVO_TIPO) {
    tipoAnterior = antigo;
    abrirTipo(null, true);
  }
});

function abrir(l) {
  editando.value = l ?? {};
  Object.assign(f, {
    nome: l?.nome ?? "", tipoId: l?.tipoId ?? (filtroTipo.value || tipos.value.find((t) => t.ativo)?.id || ""), endereco: l?.endereco ?? "", cidade: l?.cidade ?? "", uf: l?.uf ?? "",
    latitude: l?.latitude ?? "", longitude: l?.longitude ?? "", filaHoras: l?.filaHoras ?? "",
  });
  termo.value = l ? [l.nome, l.cidade, l.uf].filter(Boolean).join(", ") : "";
  resultados.value = [];
  erroBusca.value = null;
  erro.value = null;
  aviso.value = null;
}

async function buscarEndereco() {
  if (!termo.value.trim()) return;
  buscando.value = true;
  erroBusca.value = null;
  try {
    resultados.value = await api.geocodificar(termo.value);
    if (!resultados.value.length) erroBusca.value = "Nada encontrado. Tente com cidade e UF (ex.: \"Terminal Santos Brasil, Santos SP\").";
  } catch (e) {
    erroBusca.value = e.message;
  } finally {
    buscando.value = false;
  }
}

function usarResultado(r) {
  Object.assign(f, {
    endereco: r.endereco ?? f.endereco,
    cidade: r.cidade ?? f.cidade,
    uf: r.uf ?? f.uf,
    latitude: Number(r.latitude.toFixed(6)),
    longitude: Number(r.longitude.toFixed(6)),
  });
  resultados.value = [];
}

// Aceita colar "-23.95, -46.33" (formato que o Google Maps copia) no campo de latitude.
function colarCoordenadas(evento) {
  const texto = evento.clipboardData?.getData("text") ?? "";
  const m = texto.match(/(-?\d+[.,]\d+)\s*[,;\s]\s*(-?\d+[.,]\d+)/);
  if (m) {
    evento.preventDefault();
    f.latitude = Number(m[1].replace(",", "."));
    f.longitude = Number(m[2].replace(",", "."));
  }
}

async function salvar() {
  enviando.value = true;
  erro.value = null;
  try {
    const dados = { ...f };
    for (const k of ["latitude", "longitude", "filaHoras"]) if (dados[k] === "") dados[k] = null;
    if (!retiradaEntrega.value) dados.filaHoras = null;
    if (editando.value.id) await api.atualizarLocal(editando.value.id, dados);
    else await api.criarLocal(dados);
    aviso.value = `Local "${dados.nome}" salvo.${editando.value.id ? " Se as coordenadas mudaram, as distâncias e previsões foram recalculadas." : ""}`;
    editando.value = null;
    await carregar();
  } catch (e) {
    erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}

async function alternarAtivo(l) {
  try {
    await api.atualizarLocal(l.id, { ativo: !l.ativo });
    await carregar();
  } catch (e) {
    erro.value = e.message;
  }
}

async function excluir(l) {
  if (!confirm(`Excluir o local "${l.nome}"? Só é possível se ele nunca foi usado.`)) return;
  try {
    await api.excluirLocal(l.id);
    await carregar();
  } catch (e) {
    erro.value = e.message;
  }
}

// ---------- Cadastro de tipos (modal) ----------
const tipoEditando = ref(null); // null | {} (novo) | tipo
const doFormLocal = ref(false); // aberto pelo "+ Novo tipo…" do formulário de local
const ft = reactive({ nome: "", funcao: "RETIRADA_ENTREGA", rotuloColeta: "", rotuloEntrega: "", rotuloChegada: "", rotuloSaida: "" });
const rotuloEditado = reactive({});
const erroTipo = ref(null);

// Sugestão dos nomes das etapas a partir do nome do tipo; a pessoa ajusta (no/na, do/da…).
function sugestoes() {
  const n = ft.nome.trim().toLowerCase() || "local";
  return ft.funcao === "RETIRADA_ENTREGA"
    ? { rotuloColeta: `Coleta no ${n}`, rotuloEntrega: `Entrega no ${n}` }
    : { rotuloChegada: `Chegada no ${n}`, rotuloSaida: `Saída do ${n}` };
}
watch(() => [ft.nome, ft.funcao], () => {
  if (tipoEditando.value?.id) return; // editando: não sobrescreve o que já foi gravado
  for (const [campo, valor] of Object.entries(sugestoes())) if (!rotuloEditado[campo]) ft[campo] = valor;
});

function abrirTipo(tipo, vindoDoLocal = false) {
  tipoEditando.value = tipo ?? {};
  doFormLocal.value = vindoDoLocal;
  for (const k of Object.keys(rotuloEditado)) delete rotuloEditado[k];
  Object.assign(ft, {
    nome: tipo?.nome ?? "", funcao: tipo?.funcao ?? "RETIRADA_ENTREGA",
    rotuloColeta: tipo?.rotuloColeta ?? "", rotuloEntrega: tipo?.rotuloEntrega ?? "",
    rotuloChegada: tipo?.rotuloChegada ?? "", rotuloSaida: tipo?.rotuloSaida ?? "",
  });
  if (!tipo) Object.assign(ft, sugestoes());
  erroTipo.value = null;
}
function fecharTipo() {
  if (doFormLocal.value && f.tipoId === NOVO_TIPO) f.tipoId = tipoAnterior;
  tipoEditando.value = null;
}
async function salvarTipo() {
  erroTipo.value = null;
  try {
    const dados = { ...ft };
    const salvo = tipoEditando.value.id ? await api.atualizarTipoLocal(tipoEditando.value.id, dados) : await api.criarTipoLocal(dados);
    tipos.value = await api.tiposLocal();
    if (doFormLocal.value) {
      f.tipoId = salvo.id;
    } else {
      aviso.value = `Tipo "${salvo.nome}" salvo.`;
      await carregar();
    }
    tipoEditando.value = null;
  } catch (e) {
    erroTipo.value = e.message;
  }
}
async function alternarTipoAtivo(t) {
  try {
    await api.atualizarTipoLocal(t.id, { ativo: !t.ativo });
    await carregar();
  } catch (e) {
    erro.value = e.message;
  }
}
async function excluirTipo(t) {
  if (!confirm(`Excluir o tipo "${t.nome}"? Só é possível se nenhum local usar este tipo.`)) return;
  try {
    await api.excluirTipoLocal(t.id);
    await carregar();
  } catch (e) {
    erro.value = e.message;
  }
}
const etapasDoTipo = (t) => (t.funcao === "RETIRADA_ENTREGA" ? [t.rotuloColeta, t.rotuloEntrega] : [t.rotuloChegada, t.rotuloSaida]).join(" · ");

const TIPO_RESULTADO = { venue: "terminal/empresa", address: "endereço", street: "rua", neighbourhood: "bairro", locality: "cidade", localadmin: "município", county: "município", region: "estado" };
const mapa = (l) => `https://www.openstreetmap.org/?mlat=${l.latitude}&mlon=${l.longitude}#map=15/${l.latitude}/${l.longitude}`;
</script>

<template>
  <div class="card linha-entre">
    <div>
      <h2 style="margin: 0">Locais</h2>
      <div class="mudo pequeno" style="margin-top: 4px">
        Locais de carregamento (fábrica, armazém…) e de retirada/entrega do container (porto, terminal ferroviário…). O tipo de
        cada local define o nome das etapas do container (ex.: "Coleta ferroviária").
        As coordenadas são usadas para calcular a distância de cada trajeto e prever o risco de demurrage.
      </div>
    </div>
    <button v-if="auth.pode('cadastros.editar')" class="primario" @click="abrir(null)">+ Novo local</button>
  </div>
  <div v-if="erro && !editando" class="erro">{{ erro }}</div>
  <div v-if="aviso" class="sucesso">{{ aviso }}</div>
  <div v-if="semCoordenadas" class="aviso">
    {{ semCoordenadas }} local(is) ativo(s) sem coordenadas: os containers que passam por eles ficam sem previsão de rota.
  </div>

  <div class="card" style="padding: 0">
    <div class="filtros" style="padding: 12px 16px">
      <div class="campo">
        <label>Tipo</label>
        <select v-model="filtroTipo">
          <option value="">Todos</option>
          <option v-for="t in tipos" :key="t.id" :value="t.id">{{ t.nome }}</option>
        </select>
      </div>
      <div class="campo"><label>Buscar</label><input v-model="busca" placeholder="Nome, cidade ou UF" /></div>
    </div>
    <div class="tabela-wrap">
      <table>
        <thead>
          <tr><th>Local</th><th>Tipo</th><th>Cidade / UF</th><th>Coordenadas</th><th>Fila/gate</th><th>Em uso</th><th>Situação</th><th v-if="auth.pode('cadastros.editar')"></th></tr>
        </thead>
        <tbody>
          <tr v-for="l in visiveis" :key="l.id" :style="{ opacity: l.ativo ? 1 : 0.55 }">
            <td class="negrito">{{ l.nome }}<div v-if="l.endereco" class="mudo pequeno">{{ l.endereco }}</div></td>
            <td><span class="chip" :class="l.tipo.funcao === 'RETIRADA_ENTREGA' ? 'azul' : ''">{{ l.tipo.nome }}</span></td>
            <td>{{ [l.cidade, l.uf].filter(Boolean).join(" / ") || "—" }}</td>
            <td>
              <a v-if="l.temCoordenadas" :href="mapa(l)" target="_blank" rel="noopener" class="pequeno mono">{{ l.latitude }}, {{ l.longitude }}</a>
              <span v-else class="chip amarelo">sem coordenadas</span>
            </td>
            <td>
              <template v-if="l.tipo.funcao === 'RETIRADA_ENTREGA'">{{ l.filaHoras ?? config?.filaPortoHorasPadrao }}h<span v-if="l.filaHoras === null" class="mudo pequeno"> (padrão)</span></template>
              <span v-else class="mudo">—</span>
            </td>
            <td>{{ l.emUso }}</td>
            <td><span class="chip" :class="l.ativo ? 'verde' : ''">{{ l.ativo ? "Ativo" : "Inativo" }}</span></td>
            <td v-if="auth.pode('cadastros.editar')" style="text-align: right; white-space: nowrap">
              <button class="pequeno" @click="abrir(l)">Editar</button>
              <button class="pequeno" @click="alternarAtivo(l)">{{ l.ativo ? "Desativar" : "Ativar" }}</button>
              <button v-if="!l.emUso" class="pequeno perigo" @click="excluir(l)">Excluir</button>
            </td>
          </tr>
          <tr v-if="!visiveis.length"><td colspan="8" class="vazio">Nenhum local encontrado.</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Tipos de local -->
  <div class="card" style="padding: 0">
    <div class="linha-entre" style="padding: 12px 16px">
      <div>
        <h3 style="margin: 0">Tipos de local</h3>
        <div class="mudo pequeno">A função diz onde o local entra no trajeto; os nomes das etapas aparecem na linha do tempo e nas listas de containers.</div>
      </div>
      <button v-if="auth.pode('cadastros.editar')" @click="abrirTipo(null)">+ Novo tipo</button>
    </div>
    <div class="tabela-wrap">
      <table>
        <thead><tr><th>Tipo</th><th>Função</th><th>Nomes das etapas</th><th>Locais</th><th>Situação</th><th v-if="auth.pode('cadastros.editar')"></th></tr></thead>
        <tbody>
          <tr v-for="t in tipos" :key="t.id" :style="{ opacity: t.ativo ? 1 : 0.55 }">
            <td class="negrito">{{ t.nome }}</td>
            <td><span class="chip" :class="t.funcao === 'RETIRADA_ENTREGA' ? 'azul' : ''">{{ ROTULO_FUNCAO_LOCAL[t.funcao] }}</span></td>
            <td class="pequeno">{{ etapasDoTipo(t) }}</td>
            <td>{{ t.locais }}</td>
            <td><span class="chip" :class="t.ativo ? 'verde' : ''">{{ t.ativo ? "Ativo" : "Inativo" }}</span></td>
            <td v-if="auth.pode('cadastros.editar')" style="text-align: right; white-space: nowrap">
              <button class="pequeno" @click="abrirTipo(t)">Editar</button>
              <button class="pequeno" @click="alternarTipoAtivo(t)">{{ t.ativo ? "Desativar" : "Ativar" }}</button>
              <button v-if="!t.locais" class="pequeno perigo" @click="excluirTipo(t)">Excluir</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div v-if="editando" class="fundo-modal" @mousedown.self="editando = null">
    <form class="modal" @submit.prevent="salvar">
      <h2>{{ editando.id ? "Editar local" : "Novo local" }}</h2>
      <div v-if="erro" class="erro">{{ erro }}</div>
      <div class="grade-form">
        <div class="campo"><label>Nome *</label><input v-model="f.nome" required maxlength="120" placeholder="ex.: Terminal BTP - Santos" /></div>
        <div class="campo">
          <label>Tipo *</label>
          <select v-model="f.tipoId" required>
            <option v-for="t in opcoesTipo" :key="t.id" :value="t.id">{{ t.nome }}</option>
            <option v-if="auth.pode('cadastros.editar')" :value="NOVO_TIPO">+ Novo tipo…</option>
          </select>
          <span v-if="tipoDoForm" class="dica">{{ ROTULO_FUNCAO_LOCAL[tipoDoForm.funcao] }} · etapas: {{ etapasDoTipo(tipoDoForm) }}</span>
          <span v-if="editando.id && editando.emUso > 0" class="dica">Local já usado: só tipos com a mesma função.</span>
        </div>
      </div>

      <div class="card" style="background: var(--superficie-2); box-shadow: none">
        <h3>Localização</h3>
        <div class="filtros">
          <div class="campo" style="flex: 1; min-width: 240px">
            <label>Buscar endereço</label>
            <input v-model="termo" placeholder="Nome do terminal/fábrica, rua, cidade e UF" @keydown.enter.prevent="buscarEndereco" />
          </div>
          <button type="button" :disabled="buscando" @click="buscarEndereco">{{ buscando ? "Buscando…" : "Buscar" }}</button>
        </div>
        <div v-if="erroBusca" class="aviso pequeno" style="margin-top: 8px">{{ erroBusca }}</div>
        <ul v-if="resultados.length" class="resultados-busca">
          <li v-for="(r, i) in resultados" :key="i" :class="{ outra: r.ufDiferente }">
            <button type="button" class="link" @click="usarResultado(r)">{{ r.rotulo }}</button>
            <span class="linha" style="gap: 6px; flex-shrink: 0">
              <span v-if="r.ufDiferente" class="chip amarelo" title="A UF é diferente da digitada na busca">⚠ outra UF</span>
              <span class="chip">{{ TIPO_RESULTADO[r.camada] ?? r.camada }}</span>
              <a :href="mapa(r)" target="_blank" rel="noopener" class="pequeno">ver no mapa</a>
            </span>
          </li>
        </ul>
        <div v-if="resultados.length" class="dica pequeno mudo" style="margin-top: 4px">Confira cidade e UF antes de escolher: o serviço às vezes traz lugares com nome parecido em outro estado.</div>
        <div class="grade-form" style="margin-top: 10px">
          <div class="campo"><label>Endereço</label><input v-model="f.endereco" maxlength="250" /></div>
          <div class="campo"><label>Cidade</label><input v-model="f.cidade" maxlength="120" /></div>
          <div class="campo"><label>UF</label><input v-model="f.uf" maxlength="2" style="text-transform: uppercase" /></div>
          <div class="campo">
            <label>Latitude</label>
            <input v-model="f.latitude" type="number" step="0.000001" placeholder="-23.956958" @paste="colarCoordenadas" />
          </div>
          <div class="campo">
            <label>Longitude</label>
            <input v-model="f.longitude" type="number" step="0.000001" placeholder="-46.313566" />
            <a v-if="f.latitude !== '' && f.longitude !== ''" :href="mapa(f)" target="_blank" rel="noopener" class="dica">ver este ponto no mapa ↗</a>
          </div>
        </div>
        <div class="dica pequeno mudo" style="margin-top: 6px">
          Dica: no Google Maps, clique com o botão direito no ponto e clique nas coordenadas para copiar; cole no campo Latitude que as duas são preenchidas.
          Use o ponto de entrada de caminhões (portaria/gate), não o centro do terreno.
        </div>
      </div>

      <div v-if="retiradaEntrega" class="campo" style="max-width: 280px">
        <label>Tempo de fila / gate (horas)</label>
        <input v-model="f.filaHoras" type="number" min="0" step="0.5" :placeholder="`padrão: ${config?.filaPortoHorasPadrao ?? 4}h`" />
        <span class="dica">Tempo médio até o gate-in de entrega. Vazio = padrão das Configurações.</span>
      </div>

      <div class="modal-acoes">
        <button type="button" @click="editando = null">Cancelar</button>
        <button type="submit" class="primario" :disabled="enviando || f.tipoId === NOVO_TIPO">Salvar</button>
      </div>
    </form>
  </div>

  <!-- Novo/editar tipo (pode abrir por cima do formulário de local) -->
  <div v-if="tipoEditando" class="fundo-modal" @mousedown.self="fecharTipo">
    <form class="modal" style="max-width: 560px" @submit.prevent="salvarTipo">
      <h2>{{ tipoEditando.id ? "Editar tipo de local" : "Novo tipo de local" }}</h2>
      <div v-if="erroTipo" class="erro">{{ erroTipo }}</div>
      <div class="grade-form">
        <div class="campo"><label>Nome do tipo *</label><input v-model.trim="ft.nome" required maxlength="60" placeholder="ex.: Terminal Ferroviário" /></div>
        <div class="campo">
          <label>Função *</label>
          <select v-model="ft.funcao" :disabled="tipoEditando.locais > 0">
            <option value="RETIRADA_ENTREGA">{{ ROTULO_FUNCAO_LOCAL.RETIRADA_ENTREGA }}</option>
            <option value="CARREGAMENTO">{{ ROTULO_FUNCAO_LOCAL.CARREGAMENTO }}</option>
          </select>
          <span class="dica">{{ ft.funcao === "RETIRADA_ENTREGA" ? "Onde o vazio é retirado e o cheio é entregue (ex.: porto, terminal ferroviário)." : "Onde o container é carregado/ovado (ex.: fábrica, armazém)." }}</span>
        </div>
      </div>
      <h3 style="margin-top: 6px">Nomes das etapas neste tipo de local</h3>
      <div class="grade-form">
        <template v-if="ft.funcao === 'RETIRADA_ENTREGA'">
          <div class="campo"><label>Coleta do vazio *</label><input v-model.trim="ft.rotuloColeta" required maxlength="60" placeholder="ex.: Coleta ferroviária" @input="rotuloEditado.rotuloColeta = true" /></div>
          <div class="campo"><label>Entrega do cheio *</label><input v-model.trim="ft.rotuloEntrega" required maxlength="60" placeholder="ex.: Entrega no terminal ferroviário" @input="rotuloEditado.rotuloEntrega = true" /></div>
        </template>
        <template v-else>
          <div class="campo"><label>Chegada *</label><input v-model.trim="ft.rotuloChegada" required maxlength="60" placeholder="ex.: Chegada no armazém" @input="rotuloEditado.rotuloChegada = true" /></div>
          <div class="campo"><label>Saída *</label><input v-model.trim="ft.rotuloSaida" required maxlength="60" placeholder="ex.: Saída do armazém" @input="rotuloEditado.rotuloSaida = true" /></div>
        </template>
      </div>
      <div class="dica pequeno mudo">Sugestão preenchida a partir do nome — ajuste o texto se precisar (ex.: "na fábrica", "ferroviária").</div>
      <div class="modal-acoes">
        <button type="button" @click="fecharTipo">Cancelar</button>
        <button type="submit" class="primario">Salvar tipo</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.resultados-busca { list-style: none; margin: 8px 0 0; padding: 0; border: 1px solid var(--borda); border-radius: 6px; background: var(--superficie); }
.resultados-busca li { padding: 7px 10px; border-bottom: 1px solid var(--borda); display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.resultados-busca li.outra { background: #fffcf4; }
.resultados-busca li:last-child { border-bottom: none; }
.resultados-busca button { text-align: left; white-space: normal; }
</style>
