<script setup>
import { computed, onMounted, ref } from "vue";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import { ROTULO_PERFIL } from "../formato.js";

// Matriz usuário × permissão. Cada perfil tem um padrão; marcar/desmarcar personaliza o
// usuário. O administrador tem acesso total (não configurável).
const auth = useAuthStore();
const usuarios = ref([]);
const catalogo = ref([]);
const padroes = ref({});
const rascunho = ref({}); // id → Set de chaves em edição
const salvando = ref({});
const erro = ref(null);
const aviso = ref(null);
const busca = ref("");
const mostrarInativos = ref(false);

async function carregar() {
  try {
    const [lista, cat] = await Promise.all([api.usuarios(), api.catalogoPermissoes()]);
    usuarios.value = lista;
    catalogo.value = cat.catalogo;
    padroes.value = cat.padroes;
    rascunho.value = Object.fromEntries(lista.map((u) => [u.id, new Set(u.permissoes)]));
  } catch (e) {
    erro.value = e.message;
  }
}
onMounted(carregar);

// Grupos para o cabeçalho de duas linhas.
const grupos = computed(() => {
  const g = [];
  for (const p of catalogo.value) {
    const ultimo = g[g.length - 1];
    if (ultimo?.nome === p.grupo) ultimo.qtd++;
    else g.push({ nome: p.grupo, qtd: 1 });
  }
  return g;
});

const visiveis = computed(() => {
  const b = busca.value.trim().toLowerCase();
  return usuarios.value
    .filter((u) => mostrarInativos.value || u.ativo)
    .filter((u) => !b || `${u.nome} ${u.email}`.toLowerCase().includes(b))
    .sort((a, c) => (a.perfil === "ADMIN") - (c.perfil === "ADMIN") || a.nome.localeCompare(c.nome, "pt-BR"));
});

const iguais = (a, b) => a.size === b.length && b.every((x) => a.has(x));
const alterado = (u) => !iguais(rascunho.value[u.id], u.permissoes);
const ehPadrao = (u, conjunto) => iguais(conjunto, padroes.value[u.perfil] ?? []);

function alternar(u, chave) {
  const s = new Set(rascunho.value[u.id]);
  s.has(chave) ? s.delete(chave) : s.add(chave);
  rascunho.value = { ...rascunho.value, [u.id]: s };
}
function descartar(u) {
  rascunho.value = { ...rascunho.value, [u.id]: new Set(u.permissoes) };
}
function usarPadrao(u) {
  rascunho.value = { ...rascunho.value, [u.id]: new Set(padroes.value[u.perfil] ?? []) };
}

async function salvar(u) {
  erro.value = null;
  aviso.value = null;
  salvando.value = { ...salvando.value, [u.id]: true };
  try {
    const conjunto = rascunho.value[u.id];
    const atualizado = await api.salvarPermissoes(u.id, ehPadrao(u, conjunto) ? null : catalogo.value.map((p) => p.chave).filter((c) => conjunto.has(c)));
    usuarios.value = usuarios.value.map((x) => (x.id === u.id ? atualizado : x));
    rascunho.value = { ...rascunho.value, [u.id]: new Set(atualizado.permissoes) };
    aviso.value = `Permissões de ${u.nome} salvas${atualizado.personalizado ? " (personalizado)" : " (padrão do perfil)"}. Valem em até 30 segundos, sem ele precisar sair e entrar.`;
  } catch (e) {
    erro.value = e.message;
  } finally {
    salvando.value = { ...salvando.value, [u.id]: false };
  }
}

const pendentes = computed(() => usuarios.value.filter((u) => u.perfil !== "ADMIN" && rascunho.value[u.id] && alterado(u)).length);
</script>

<template>
  <div class="card">
    <div class="linha-entre">
      <div>
        <h2 style="margin: 0">Perfis e permissões</h2>
        <div class="mudo pequeno" style="margin-top: 4px">
          Cada perfil tem um padrão; marque ou desmarque para personalizar um usuário específico. Clique em <strong>Salvar</strong> na linha.
          A mudança vale em até 30 segundos (sem sair e entrar). Tudo fica no log de auditoria.
        </div>
      </div>
      <div class="linha">
        <input v-model="busca" placeholder="Buscar usuário" style="width: 220px" />
        <label class="linha pequeno" style="gap: 6px"><input v-model="mostrarInativos" type="checkbox" /> Mostrar inativos</label>
      </div>
    </div>
  </div>

  <div v-if="erro" class="erro">{{ erro }}</div>
  <div v-if="aviso" class="sucesso">{{ aviso }}</div>
  <div v-if="pendentes" class="aviso pequeno">{{ pendentes }} usuário(s) com alterações não salvas.</div>

  <div class="card tabela-wrap" style="padding: 0">
    <table class="matriz">
      <thead>
        <tr>
          <th rowspan="2" class="col-usuario">Usuário</th>
          <th v-for="g in grupos" :key="g.nome" :colspan="g.qtd" class="grupo">{{ g.nome }}</th>
        </tr>
        <tr>
          <th v-for="p in catalogo" :key="p.chave" class="col-perm" :title="p.descricao">{{ p.nome }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="u in visiveis" :key="u.id" :class="{ inativo: !u.ativo, sujo: u.perfil !== 'ADMIN' && alterado(u) }">
          <td class="col-usuario">
            <div class="negrito">{{ u.nome }}<span v-if="u.email === auth.usuario?.email" class="mudo"> (você)</span></div>
            <div class="mudo pequeno">{{ u.email }}</div>
            <div class="linha" style="gap: 4px; margin-top: 4px">
              <span class="chip">{{ ROTULO_PERFIL[u.perfil] }}</span>
              <span v-if="u.perfil === 'ADMIN'" class="chip azul">acesso total</span>
              <span v-else-if="!ehPadrao(u, rascunho[u.id])" class="chip amarelo">personalizado</span>
              <span v-else class="chip verde">padrão do perfil</span>
              <span v-if="!u.ativo" class="chip vermelho">inativo</span>
            </div>
            <!-- Ações na própria célula do usuário: sempre visíveis, mesmo com a tabela larga. -->
            <div v-if="u.perfil !== 'ADMIN' && (alterado(u) || !ehPadrao(u, rascunho[u.id]))" class="acoes">
              <button v-if="alterado(u)" class="pequeno primario" :disabled="salvando[u.id]" @click="salvar(u)">{{ salvando[u.id] ? "Salvando…" : "Salvar" }}</button>
              <button v-if="alterado(u)" class="pequeno" @click="descartar(u)">Desfazer</button>
              <button v-if="!ehPadrao(u, rascunho[u.id])" class="pequeno" :title="`Volta ao padrão do perfil ${ROTULO_PERFIL[u.perfil]}`" @click="usarPadrao(u)">Padrão do perfil</button>
            </div>
          </td>
          <td v-for="p in catalogo" :key="p.chave" class="col-perm">
            <input
              type="checkbox" :checked="rascunho[u.id]?.has(p.chave)" :disabled="u.perfil === 'ADMIN'"
              :aria-label="`${p.nome} para ${u.nome}`" :title="p.descricao" @change="alternar(u, p.chave)"
            />
            <div v-if="u.perfil !== 'ADMIN' && rascunho[u.id]?.has(p.chave) !== u.permissoes.includes(p.chave)" class="marca-mudou" aria-hidden="true">●</div>
          </td>
        </tr>
        <tr v-if="!visiveis.length"><td :colspan="catalogo.length + 1" class="vazio">Nenhum usuário.</td></tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h3>O que cada permissão libera</h3>
    <dl class="lista-def">
      <template v-for="p in catalogo" :key="p.chave">
        <dt class="negrito">{{ p.nome }}</dt>
        <dd class="pequeno">{{ p.descricao }}</dd>
      </template>
      <dt class="negrito">Somente administrador</dt>
      <dd class="pequeno">Usuários, permissões, integração e regras de Configurações — não pode ser liberado a outros perfis.</dd>
    </dl>
    <h3 style="margin-top: 14px">Padrão de cada perfil</h3>
    <div class="pequeno">
      <div v-for="(lista, perfil) in padroes" :key="perfil" style="margin-bottom: 4px">
        <strong>{{ ROTULO_PERFIL[perfil] }}:</strong>
        {{ perfil === "ADMIN" ? "tudo" : lista.length ? lista.map((c) => catalogo.find((p) => p.chave === c)?.nome).join(", ") : "somente consulta" }}
      </div>
      <div class="mudo" style="margin-top: 6px">Trocar o perfil de um usuário (em Usuários) descarta a personalização dele e aplica o padrão do novo perfil.</div>
    </div>
  </div>
</template>

<style scoped>
.matriz th, .matriz td { text-align: center; }
.matriz .col-usuario { text-align: left; min-width: 220px; position: sticky; left: 0; background: var(--superficie); z-index: 1; }
.matriz thead .col-usuario { background: var(--superficie-2); }
.matriz th.grupo { border-bottom: 1px solid var(--borda); text-transform: uppercase; font-size: 11px; letter-spacing: .05em; }
.matriz th.col-perm { font-size: 12px; min-width: 96px; max-width: 120px; white-space: normal; line-height: 1.2; cursor: help; }
.matriz td.col-perm { position: relative; }
.matriz td.col-perm input { width: 18px; height: 18px; cursor: pointer; }
.matriz td.col-perm input:disabled { cursor: not-allowed; }
.marca-mudou { position: absolute; top: 6px; right: 10px; font-size: 8px; color: var(--amarelo); }
.matriz tr.inativo td { opacity: .55; }
.matriz tr.sujo td { background: #fffcf4; }
.matriz tr.sujo .col-usuario { background: #fffcf4; }
.acoes { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
</style>
