<script setup>
import { onMounted, ref } from "vue";
import { api } from "../api.js";
import { fmtDataHora } from "../formato.js";

const lista = ref([]);
const erro = ref(null);
const nome = ref("");
const tokenNovo = ref(null);
const url = `${window.location.origin}/api/integracao/temperaturas`;

async function carregar() {
  try {
    lista.value = await api.tokens();
  } catch (e) {
    erro.value = e.message;
  }
}
onMounted(carregar);

async function criar() {
  erro.value = null;
  try {
    tokenNovo.value = await api.criarToken(nome.value);
    nome.value = "";
    await carregar();
  } catch (e) {
    erro.value = e.message;
  }
}

async function revogar(t) {
  if (!confirm(`Revogar o token "${t.nome}"? A integração que usa esse token para de funcionar imediatamente.`)) return;
  await api.revogarToken(t.id).catch((e) => (erro.value = e.message));
  await carregar();
}

const exemplo = `POST ${url}
Authorization: Bearer <token>
Content-Type: application/json

{
  "leituras": [
    { "container": "ABCU1234567", "temperatura": -18.2, "lidaEm": "2026-09-24T10:00:00-03:00" }
  ]
}`;
</script>

<template>
  <div class="card">
    <h2>Porta automática de temperatura</h2>
    <p class="mudo" style="margin-top: 0">
      Hoje a temperatura é lançada manualmente na ficha do container. Quando houver sensor próprio ou telemetria do armador,
      a fonte envia as leituras para o endereço abaixo usando um token. O container é identificado pelo número e precisa estar ativo e ser reefer.
      Reenviar a mesma leitura (mesmo container e horário) não duplica.
    </p>
    <pre class="card mono pequeno" style="background: var(--superficie-2); overflow-x: auto; margin: 0">{{ exemplo }}</pre>
    <p class="mudo pequeno">Resposta: quantidade de leituras gravadas, duplicadas e rejeitadas (com o motivo de cada rejeição). Máximo de 500 leituras por envio.</p>
  </div>

  <div class="card">
    <h2>Tokens de integração</h2>
    <div v-if="erro" class="erro">{{ erro }}</div>
    <form class="filtros" @submit.prevent="criar">
      <div class="campo" style="min-width: 260px"><label>Nome da integração</label><input v-model="nome" required maxlength="80" placeholder="ex.: Sensores pátio Fábrica 1" /></div>
      <button type="submit" class="primario">Gerar token</button>
    </form>
    <div v-if="tokenNovo" class="aviso" style="margin-top: 12px">
      <strong>Copie agora — este token não será exibido novamente:</strong>
      <div class="mono" style="margin-top: 6px; word-break: break-all; user-select: all">{{ tokenNovo.token }}</div>
    </div>
    <table style="margin-top: 12px">
      <thead><tr><th>Nome</th><th>Início do token</th><th>Criado</th><th>Último uso</th><th>Situação</th><th></th></tr></thead>
      <tbody>
        <tr v-for="t in lista" :key="t.id">
          <td>{{ t.nome }}</td>
          <td class="mono">{{ t.prefixo }}…</td>
          <td>{{ fmtDataHora(t.criadoEm) }}<div class="mudo pequeno">{{ t.criadoPor }}</div></td>
          <td>{{ fmtDataHora(t.ultimoUsoEm) }}</td>
          <td><span class="chip" :class="t.ativo ? 'verde' : 'vermelho'">{{ t.ativo ? "Ativo" : "Revogado" }}</span></td>
          <td><button v-if="t.ativo" class="pequeno perigo" @click="revogar(t)">Revogar</button></td>
        </tr>
        <tr v-if="!lista.length"><td colspan="6" class="vazio">Nenhum token criado.</td></tr>
      </tbody>
    </table>
  </div>
</template>
