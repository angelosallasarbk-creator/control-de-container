<script setup>
// Organizações (clientes da plataforma) — só o administrador da plataforma. Cria o cliente com os
// cadastros padrão e o primeiro administrador dele; ativa/desativa; renomeia. Não mostra dados
// operacionais dos clientes (só contagens).
import { onMounted, reactive, ref } from "vue";
import { api } from "../api.js";
import { fmtDataHora } from "../formato.js";
import CampoSenha from "../components/CampoSenha.vue";
import Paginacao from "../components/Paginacao.vue";
import { usePaginacao } from "../composables/usePaginacao.js";

const lista = ref([]);
const erro = ref(null);
const aviso = ref(null);
const pag = usePaginacao(lista, "organizacoes");

async function carregar() {
  try {
    lista.value = await api.organizacoes();
    erro.value = null;
  } catch (e) {
    erro.value = e.message;
  }
}
onMounted(carregar);

const nova = ref(null);
const f = reactive({ nome: "", adminNome: "", adminEmail: "", adminSenha: "" });
const erroNova = ref(null);
const enviando = ref(false);
function abrirNova() {
  Object.assign(f, { nome: "", adminNome: "", adminEmail: "", adminSenha: "" });
  erroNova.value = null;
  nova.value = true;
}
async function salvarNova() {
  erroNova.value = null;
  enviando.value = true;
  try {
    const o = await api.criarOrganizacao({ ...f });
    nova.value = null;
    aviso.value = `Organização "${o.nome}" criada. Passe ao administrador dela o e-mail ${f.adminEmail} e a senha definida (ele pode trocar em "Esqueci minha senha").`;
    await carregar();
  } catch (e) {
    erroNova.value = e.message;
  } finally {
    enviando.value = false;
  }
}

async function alternar(o) {
  if (o.ativo && !confirm(`Desativar ${o.nome}? Os usuários dessa organização deixam de entrar na hora (os dados ficam guardados).`)) return;
  try {
    await api.atualizarOrganizacao(o.id, { ativo: !o.ativo });
    await carregar();
  } catch (e) {
    erro.value = e.message;
  }
}
async function renomear(o) {
  const nome = prompt("Novo nome da organização:", o.nome);
  if (!nome || nome.trim() === o.nome) return;
  try {
    await api.atualizarOrganizacao(o.id, { nome: nome.trim() });
    await carregar();
  } catch (e) {
    erro.value = e.message;
  }
}
</script>

<template>
  <div class="card linha-entre">
    <div>
      <h2 style="margin: 0">Organizações</h2>
      <div class="mudo pequeno" style="margin-top: 4px">
        Cada organização é um cliente da plataforma e só enxerga os próprios dados. Ao criar, ela já recebe os tipos de local e de operação
        padrão e o primeiro administrador. Por aqui você não vê containers nem dados operacionais dos clientes.
      </div>
    </div>
    <button class="primario" @click="abrirNova">+ Nova organização</button>
  </div>
  <div v-if="erro && !nova" class="erro">{{ erro }}</div>
  <div v-if="aviso" class="sucesso">{{ aviso }}</div>

  <div class="card" style="padding: 0">
    <div class="tabela-wrap">
      <table>
        <thead><tr><th>Organização</th><th>Usuários</th><th>Containers ativos</th><th>Containers (total)</th><th>Criada em</th><th>Situação</th><th></th></tr></thead>
        <tbody>
          <tr v-for="o in pag.itens.value" :key="o.id" :style="{ opacity: o.ativo ? 1 : 0.55 }">
            <td class="negrito">{{ o.nome }}</td>
            <td>{{ o.usuarios }}</td>
            <td>{{ o.containersAtivos }}</td>
            <td>{{ o.containers }}</td>
            <td class="pequeno">{{ fmtDataHora(o.criadoEm) }}<div v-if="o.criadoPor" class="mudo">{{ o.criadoPor }}</div></td>
            <td><span class="chip" :class="o.ativo ? 'verde' : ''">{{ o.ativo ? "Ativa" : "Desativada" }}</span></td>
            <td style="text-align: right; white-space: nowrap">
              <button class="pequeno" @click="renomear(o)">Renomear</button>
              <button class="pequeno" :class="{ perigo: o.ativo }" @click="alternar(o)">{{ o.ativo ? "Desativar" : "Reativar" }}</button>
            </td>
          </tr>
          <tr v-if="!lista.length"><td colspan="7" class="vazio">Nenhuma organização.</td></tr>
        </tbody>
      </table>
    </div>
    <Paginacao :p="pag" />
  </div>

  <div v-if="nova" class="fundo-modal" @mousedown.self="nova = null">
    <form class="modal estreito" @submit.prevent="salvarNova">
      <h2>Nova organização</h2>
      <div v-if="erroNova" class="erro">{{ erroNova }}</div>
      <div class="campo"><label for="org-nome">Nome da organização *</label><input id="org-nome" v-model="f.nome" required maxlength="120" placeholder="Ex.: Transportes Exemplo Ltda" /></div>
      <h3 style="margin: 14px 0 4px">Primeiro administrador</h3>
      <div class="campo"><label for="org-admin-nome">Nome *</label><input id="org-admin-nome" v-model="f.adminNome" required maxlength="120" /></div>
      <div class="campo"><label for="org-admin-email">E-mail *</label><input id="org-admin-email" v-model="f.adminEmail" type="email" required maxlength="160" /></div>
      <div class="campo">
        <label for="org-admin-senha">Senha inicial * (mín. 8)</label>
        <CampoSenha id="org-admin-senha" v-model="f.adminSenha" :obrigatorio="true" :minlength="8" autocomplete="new-password" />
      </div>
      <div class="modal-acoes">
        <button type="button" @click="nova = null">Cancelar</button>
        <button type="submit" class="primario" :disabled="enviando">{{ enviando ? "Criando…" : "Criar organização" }}</button>
      </div>
    </form>
  </div>
</template>
