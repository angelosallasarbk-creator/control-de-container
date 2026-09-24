<script setup>
import { onMounted, reactive, ref } from "vue";
import { api } from "../api.js";
import { ROTULO_PERFIL, fmtDataHora } from "../formato.js";

const lista = ref([]);
const erro = ref(null);
const editando = ref(null);
const form = reactive({ email: "", nome: "", perfil: "OPERADOR", senha: "" });
const enviando = ref(false);

const DESCRICAO_PERFIL = {
  ADMIN: "Tudo, inclusive usuários, integração e configurações.",
  SUPERVISOR: "Cadastros, containers, prazos negociados, desfazer/cancelar etapas.",
  OPERADOR: "Cadastrar containers, avançar etapas, registrar temperatura, reconhecer alertas.",
  VISUALIZACAO: "Somente consulta.",
};

async function carregar() {
  try {
    lista.value = await api.usuarios();
  } catch (e) {
    erro.value = e.message;
  }
}
onMounted(carregar);

function abrir(u) {
  editando.value = u ?? {};
  Object.assign(form, { email: u?.email ?? "", nome: u?.nome ?? "", perfil: u?.perfil ?? "OPERADOR", senha: "" });
  erro.value = null;
}

async function salvar() {
  enviando.value = true;
  erro.value = null;
  try {
    if (editando.value.id) {
      const dados = { nome: form.nome, perfil: form.perfil };
      if (form.senha) dados.senha = form.senha;
      await api.atualizarUsuario(editando.value.id, dados);
    } else {
      await api.criarUsuario({ ...form });
    }
    editando.value = null;
    await carregar();
  } catch (e) {
    erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}

async function alternarAtivo(u) {
  try {
    await api.atualizarUsuario(u.id, { ativo: !u.ativo });
    await carregar();
  } catch (e) {
    erro.value = e.message;
  }
}
</script>

<template>
  <div class="card linha-entre">
    <div class="mudo">Contas de acesso ao sistema. Uma conta desativada não consegue entrar.</div>
    <button class="primario" @click="abrir(null)">+ Novo usuário</button>
  </div>
  <div v-if="erro && !editando" class="erro">{{ erro }}</div>
  <div class="card tabela-wrap" style="padding: 0">
    <table>
      <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Criado</th><th>Situação</th><th></th></tr></thead>
      <tbody>
        <tr v-for="u in lista" :key="u.id" :style="{ opacity: u.ativo ? 1 : 0.55 }">
          <td>{{ u.nome }}</td>
          <td>{{ u.email }}</td>
          <td>{{ ROTULO_PERFIL[u.perfil] }}</td>
          <td>{{ fmtDataHora(u.criadoEm) }}</td>
          <td><span class="chip" :class="u.ativo ? 'verde' : ''">{{ u.ativo ? "Ativo" : "Inativo" }}</span></td>
          <td style="text-align: right; white-space: nowrap">
            <button class="pequeno" @click="abrir(u)">Editar</button>
            <button class="pequeno" @click="alternarAtivo(u)">{{ u.ativo ? "Desativar" : "Ativar" }}</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="editando" class="fundo-modal" @mousedown.self="editando = null">
    <form class="modal estreito" @submit.prevent="salvar">
      <h2>{{ editando.id ? "Editar usuário" : "Novo usuário" }}</h2>
      <div v-if="erro" class="erro">{{ erro }}</div>
      <div class="campo"><label>E-mail *</label><input v-model="form.email" type="email" required :disabled="!!editando.id" /></div>
      <div class="campo"><label>Nome *</label><input v-model="form.nome" required maxlength="120" /></div>
      <div class="campo">
        <label>Perfil *</label>
        <select v-model="form.perfil">
          <option v-for="(r, v) in ROTULO_PERFIL" :key="v" :value="v">{{ r }}</option>
        </select>
        <span class="dica">{{ DESCRICAO_PERFIL[form.perfil] }}</span>
      </div>
      <div class="campo">
        <label>{{ editando.id ? "Nova senha (deixe em branco para manter)" : "Senha *" }}</label>
        <input v-model="form.senha" type="password" :required="!editando.id" minlength="8" autocomplete="new-password" />
        <span class="dica">Mínimo de 8 caracteres.</span>
      </div>
      <div class="modal-acoes">
        <button type="button" @click="editando = null">Cancelar</button>
        <button type="submit" class="primario" :disabled="enviando">Salvar</button>
      </div>
    </form>
  </div>
</template>
