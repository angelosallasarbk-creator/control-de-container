<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import { ROTULO_TIPO_LOCAL } from "../formato.js";

const auth = useAuthStore();
const lista = ref([]);
const config = ref(null);
const erro = ref(null);
const aviso = ref(null);
const filtroTipo = ref("");
const busca = ref("");

const editando = ref(null); // null | {} (novo) | registro
const f = reactive({ nome: "", tipo: "FABRICA", endereco: "", cidade: "", uf: "", latitude: "", longitude: "", filaHoras: "" });
const enviando = ref(false);

// Busca de endereço
const termo = ref("");
const resultados = ref([]);
const buscando = ref(false);
const erroBusca = ref(null);

async function carregar() {
  try {
    [lista.value, config.value] = await Promise.all([api.locais(), api.configuracao()]);
    erro.value = null;
  } catch (e) {
    erro.value = e.message;
  }
}
onMounted(carregar);

const visiveis = computed(() => {
  const t = busca.value.trim().toLowerCase();
  return lista.value.filter(
    (l) => (!filtroTipo.value || l.tipo === filtroTipo.value) && (!t || `${l.nome} ${l.cidade ?? ""} ${l.uf ?? ""}`.toLowerCase().includes(t))
  );
});
const semCoordenadas = computed(() => lista.value.filter((l) => l.ativo && !l.temCoordenadas).length);

function abrir(l) {
  editando.value = l ?? {};
  Object.assign(f, {
    nome: l?.nome ?? "", tipo: l?.tipo ?? (filtroTipo.value || "FABRICA"), endereco: l?.endereco ?? "", cidade: l?.cidade ?? "", uf: l?.uf ?? "",
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
    if (dados.tipo !== "PORTO") dados.filaHoras = null;
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

const TIPO_RESULTADO = { venue: "terminal/empresa", address: "endereço", street: "rua", neighbourhood: "bairro", locality: "cidade", localadmin: "município", county: "município", region: "estado" };
const mapa = (l) => `https://www.openstreetmap.org/?mlat=${l.latitude}&mlon=${l.longitude}#map=15/${l.latitude}/${l.longitude}`;
</script>

<template>
  <div class="card linha-entre">
    <div>
      <h2 style="margin: 0">Locais</h2>
      <div class="mudo pequeno" style="margin-top: 4px">
        Fábricas e armazéns (onde o container é carregado) e portos/terminais (retirada do vazio e entrega do cheio).
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
          <option v-for="(r, v) in ROTULO_TIPO_LOCAL" :key="v" :value="v">{{ r }}</option>
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
            <td><span class="chip" :class="l.tipo === 'PORTO' ? 'azul' : ''">{{ ROTULO_TIPO_LOCAL[l.tipo] }}</span></td>
            <td>{{ [l.cidade, l.uf].filter(Boolean).join(" / ") || "—" }}</td>
            <td>
              <a v-if="l.temCoordenadas" :href="mapa(l)" target="_blank" rel="noopener" class="pequeno mono">{{ l.latitude }}, {{ l.longitude }}</a>
              <span v-else class="chip amarelo">sem coordenadas</span>
            </td>
            <td>
              <template v-if="l.tipo === 'PORTO'">{{ l.filaHoras ?? config?.filaPortoHorasPadrao }}h<span v-if="l.filaHoras === null" class="mudo pequeno"> (padrão)</span></template>
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

  <div v-if="editando" class="fundo-modal" @mousedown.self="editando = null">
    <form class="modal" @submit.prevent="salvar">
      <h2>{{ editando.id ? "Editar local" : "Novo local" }}</h2>
      <div v-if="erro" class="erro">{{ erro }}</div>
      <div class="grade-form">
        <div class="campo"><label>Nome *</label><input v-model="f.nome" required maxlength="120" placeholder="ex.: Terminal BTP - Santos" /></div>
        <div class="campo">
          <label>Tipo *</label>
          <select v-model="f.tipo" :disabled="editando.id && editando.emUso > 0">
            <option v-for="(r, v) in ROTULO_TIPO_LOCAL" :key="v" :value="v">{{ r }}</option>
          </select>
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

      <div v-if="f.tipo === 'PORTO'" class="campo" style="max-width: 280px">
        <label>Tempo de fila / gate (horas)</label>
        <input v-model="f.filaHoras" type="number" min="0" step="0.5" :placeholder="`padrão: ${config?.filaPortoHorasPadrao ?? 4}h`" />
        <span class="dica">Tempo médio até o gate-in de entrega. Vazio = padrão das Configurações.</span>
      </div>

      <div class="modal-acoes">
        <button type="button" @click="editando = null">Cancelar</button>
        <button type="submit" class="primario" :disabled="enviando">Salvar</button>
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
