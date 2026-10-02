<script setup>
// Motoristas (acesso pelo celular, sem usuário). Gestor da transportadora: só os dele.
// Administração (Editar cadastros): todos, com filtro por transportadora.
import { computed, onMounted, reactive, ref } from "vue";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import { fmtDataHora, tempoDesde } from "../formato.js";
import Icone from "../components/Icone.vue";
import Paginacao from "../components/Paginacao.vue";
import { usePaginacao } from "../composables/usePaginacao.js";

const auth = useAuthStore();
const ehGestor = computed(() => auth.usuario?.perfil === "GESTOR_TRANSPORTADORA");
const lista = ref([]);
const transportadoras = ref([]);
const erro = ref(null);
const aviso = ref(null);
const carregando = ref(true);
const filtro = reactive({ busca: "", situacao: "", transportadoraId: "" });

async function carregar() {
  try {
    lista.value = await api.motoristas({ transportadoraId: filtro.transportadoraId });
    erro.value = null;
  } catch (e) {
    erro.value = e.message;
  } finally {
    carregando.value = false;
  }
}
onMounted(async () => {
  if (!ehGestor.value) transportadoras.value = await api.listar("transportadoras", { ativos: "1" }).catch(() => []);
  carregar();
});

const situacao = (m) => (m.bloqueado ? "BLOQUEADO" : !m.consentimentoEm ? "AGUARDANDO" : "ATIVO");
const ROTULO_SITUACAO = { ATIVO: ["Ativo", "verde"], BLOQUEADO: ["Bloqueado", "vermelho"], AGUARDANDO: ["Aguardando 1º acesso", "amarelo"] };
// v3.2: o bloqueio do gestor é o da transportadora (todos os clientes); o da administração, só deste cliente.
const rotuloBloqueio = (m) => (m.bloqueadoPelaTransportadora ? "Bloqueado pela transportadora" : "Bloqueado para este cliente");
const meuBloqueio = (m) => (ehGestor.value ? m.bloqueadoPelaTransportadora : m.bloqueadoNoCliente);
const visiveis = computed(() => {
  const b = filtro.busca.trim().toLowerCase();
  const digitos = b.replace(/\D/g, "");
  return lista.value.filter((m) =>
    (!filtro.situacao || situacao(m) === filtro.situacao) &&
    (!b || m.nome.toLowerCase().includes(b) || (m.placa ?? "").toLowerCase().includes(b) || (digitos.length >= 3 && m.celularFinal.includes(digitos)))
  );
});
const contagem = computed(() => ({
  total: lista.value.length,
  ativos: lista.value.filter((m) => situacao(m) === "ATIVO").length,
  bloqueados: lista.value.filter((m) => m.bloqueado).length,
}));
const fmtCelular = (c) => {
  const m = /^\+55(\d{2})(\d{5})(\d{4})$/.exec(c ?? "");
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : c;
};

// Editar: busca o celular completo (a lista só tem os 4 últimos dígitos).
const edicao = ref(null);
const erroEdicao = ref(null);
async function abrirEdicao(m) {
  erroEdicao.value = null;
  try {
    const x = await api.motorista(m.id);
    edicao.value = { id: x.id, nome: x.nome, placa: x.placa ?? "", celular: fmtCelular(x.celular), celularOriginal: fmtCelular(x.celular), compartilhado: x.compartilhado };
  } catch (e) {
    mostrar(e.message);
  }
}
async function salvarEdicao() {
  erroEdicao.value = null;
  const e = edicao.value;
  if (e.celular !== e.celularOriginal && !confirm("Trocar o celular encerra os acessos atuais do motorista; ele entra de novo com o código SMS no número novo. Continuar?")) return;
  try {
    await api.atualizarMotorista(e.id, { nome: e.nome, placa: e.placa, ...(e.celular !== e.celularOriginal ? { celular: e.celular } : {}) });
    edicao.value = null;
    mostrar("Motorista atualizado.");
    await carregar();
  } catch (err) {
    erroEdicao.value = err.message;
  }
}

// LGPD (v3.3): direito de exclusão — só administração e motorista exclusivo deste cliente.
async function anonimizar() {
  const e = edicao.value;
  if (!confirm(`Anonimizar ${e.nome}? Nome, celular, CPF e placa saem do cadastro e dos containers, e o acesso dele é encerrado. Não dá para desfazer.`)) return;
  try {
    await api.anonimizarMotorista(e.id);
    edicao.value = null;
    mostrar("Motorista anonimizado.");
    await carregar();
  } catch (err) {
    erroEdicao.value = err.message;
  }
}

function mostrar(msg) {
  aviso.value = msg;
  setTimeout(() => (aviso.value = null), 5000);
}
async function alternarBloqueio(m) {
  const bloquear = !meuBloqueio(m);
  const efeito = ehGestor.value
    ? "O acesso dele pelo celular cai na hora, para todos os clientes, até ser desbloqueado."
    : "Ele não consegue mais registrar cargas deste cliente pelo QR nem recebe os SMS de rastreamento dele. Com outros clientes continua normal.";
  if (bloquear && !confirm(`Bloquear ${m.nome}? ${efeito}`)) return;
  try {
    await api.atualizarMotorista(m.id, { bloqueado: bloquear });
    mostrar(`${m.nome} ${bloquear ? "bloqueado" : "desbloqueado"}.`);
    carregar();
  } catch (e) {
    alert(e.message);
  }
}
async function encerrarAcessos(m) {
  if (!confirm(`Encerrar os acessos de ${m.nome}? (ex.: celular perdido ou trocado) Ele precisará entrar de novo com o código SMS.`)) return;
  try {
    const r = await api.encerrarSessoesMotorista(m.id);
    mostrar(`${r.encerradas} acesso(s) de ${m.nome} encerrado(s).`);
    carregar();
  } catch (e) {
    alert(e.message);
  }
}

// ----- Acessos (sessões) -----
const sessoes = ref(null);
async function verAcessos(m) {
  try {
    sessoes.value = { motorista: m, lista: await api.sessoesMotorista(m.id) };
  } catch (e) {
    alert(e.message);
  }
}

// ----- Novo motorista (pré-cadastro) -----
const novo = ref(null);
const erroNovo = ref(null);
function abrirNovo() {
  novo.value = { nome: "", celular: "", placa: "", cpf: "", transportadoraId: "" };
  erroNovo.value = null;
}
async function salvarNovo() {
  try {
    await api.criarMotorista(novo.value);
    mostrar(`${novo.value.nome} pré-cadastrado. No primeiro acesso ele confirma o celular pelo código SMS e aceita o termo.`);
    novo.value = null;
    carregar();
  } catch (e) {
    erroNovo.value = e.message;
  }
}

// ----- Planilha -----
const planilha = ref(null); // { arquivo, previa, resultado, erro, enviando }
async function baixarModelo() {
  try {
    await api.baixarModeloMotoristas();
  } catch (e) {
    alert(e.message);
  }
}
async function escolherArquivo(ev) {
  const arquivo = ev.target.files?.[0];
  ev.target.value = "";
  if (!arquivo) return;
  planilha.value = { arquivo, previa: null, resultado: null, erro: null, enviando: true };
  try {
    planilha.value.previa = await api.importarMotoristas(arquivo);
  } catch (e) {
    planilha.value.erro = e.message;
  } finally {
    planilha.value.enviando = false;
  }
}
async function confirmarPlanilha() {
  planilha.value.enviando = true;
  try {
    planilha.value.resultado = await api.importarMotoristas(planilha.value.arquivo, true);
    carregar();
  } catch (e) {
    planilha.value.erro = e.message;
  } finally {
    planilha.value.enviando = false;
  }
}
const linhasPlanilha = computed(() => (planilha.value?.resultado ?? planilha.value?.previa)?.linhas ?? []);

// Paginação da lista (10/20/50 por página, lembrado neste navegador).
const pag = usePaginacao(() => visiveis.value, "motoristas");
</script>

<template>
  <div class="card">
    <div class="linha-entre" style="flex-wrap: wrap; gap: 10px">
      <div>
        <h2 style="margin: 0">Motoristas</h2>
        <p class="mudo pequeno" style="margin: 4px 0 0">
          Motoristas não têm usuário: entram pelo QR com o celular e um código SMS. {{ ehGestor ? "Aqui ficam os da sua transportadora." : "Aparecem aqui os motoristas que registraram pelo QR uma carga de vocês ou que vocês cadastraram (o cadastro do motorista é único na plataforma)." }}
          Bloquear derruba o acesso na hora.
        </p>
      </div>
      <div class="linha" style="gap: 8px; flex-wrap: wrap">
        <button type="button" @click="baixarModelo"><Icone nome="download" :tamanho="16" /> Baixar modelo</button>
        <label class="btn"><Icone nome="upload" :tamanho="16" /> Upload<input type="file" accept=".xlsx" hidden @change="escolherArquivo" /></label>
        <button type="button" class="primario" @click="abrirNovo">+ Novo motorista</button>
      </div>
    </div>

    <div class="filtros" style="margin-top: 14px">
      <div class="campo"><label>Buscar</label><input v-model="filtro.busca" placeholder="Nome, placa ou celular" /></div>
      <div class="campo">
        <label>Situação</label>
        <select v-model="filtro.situacao">
          <option value="">Todas ({{ contagem.total }})</option>
          <option value="ATIVO">Ativos ({{ contagem.ativos }})</option>
          <option value="AGUARDANDO">Aguardando 1º acesso</option>
          <option value="BLOQUEADO">Bloqueados ({{ contagem.bloqueados }})</option>
        </select>
      </div>
      <div v-if="!ehGestor" class="campo">
        <label>Transportadora</label>
        <select v-model="filtro.transportadoraId" @change="carregar">
          <option value="">Todas</option>
          <option v-for="t in transportadoras" :key="t.id" :value="t.id">{{ t.nome }}</option>
        </select>
      </div>
    </div>
  </div>

  <div v-if="erro" class="erro">{{ erro }}</div>
  <div v-if="aviso" class="sucesso" role="status">{{ aviso }}</div>

  <div class="card tabela-wrap" style="padding: 0">
    <div v-if="carregando" class="vazio">Carregando…</div>
    <div v-else-if="!visiveis.length" class="vazio">Nenhum motorista{{ lista.length ? " com esses filtros" : " ainda — eles aparecem aqui quando entram pelo QR pela primeira vez" }}.</div>
    <table v-else>
      <thead>
        <tr><th>Nome</th><th>Celular</th><th v-if="!ehGestor">Transportadora</th><th>Placa</th><th>Situação</th><th>Último acesso</th><th>Acessos</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="m in pag.itens.value" :key="m.id" :style="{ opacity: m.bloqueado ? 0.6 : 1 }">
          <td class="negrito">{{ m.nome }}</td>
          <td class="mono" style="white-space: nowrap" title="Por privacidade, só os 4 últimos dígitos (o número completo aparece ao editar)">{{ m.celular }}</td>
          <td v-if="!ehGestor">{{ m.transportadora.nome }}</td>
          <td class="mono">{{ m.placa ?? "—" }}</td>
          <td><span class="chip" :class="ROTULO_SITUACAO[situacao(m)][1]">{{ m.bloqueado ? rotuloBloqueio(m) : ROTULO_SITUACAO[situacao(m)][0] }}</span></td>
          <td :title="m.ultimoAcessoEm ? fmtDataHora(m.ultimoAcessoEm) : ''">{{ m.ultimoAcessoEm ? `há ${tempoDesde(m.ultimoAcessoEm)}` : "—" }}</td>
          <td><button type="button" class="pequeno" :title="'Celulares com acesso ativo'" @click="verAcessos(m)">{{ m.sessoesAtivas }}</button></td>
          <td style="text-align: right; white-space: nowrap">
            <button type="button" class="pequeno" @click="abrirEdicao(m)">Editar</button>
            <button v-if="m.sessoesAtivas" type="button" class="pequeno" @click="encerrarAcessos(m)">Encerrar acessos</button>
            <button type="button" class="pequeno" :class="{ perigo: !meuBloqueio(m) }" @click="alternarBloqueio(m)">{{ meuBloqueio(m) ? "Desbloquear" : "Bloquear" }}</button>
          </td>
        </tr>
      </tbody>
    </table>
      <Paginacao :p="pag" />
  </div>

  <!-- Acessos -->
  <div v-if="sessoes" class="fundo-modal" @mousedown.self="sessoes = null">
    <div class="modal">
      <h2>Acessos de {{ sessoes.motorista.nome }}</h2>
      <table v-if="sessoes.lista.length" class="pequeno">
        <thead><tr><th>Aparelho</th><th>Entrou</th><th>Último uso</th><th>Situação</th></tr></thead>
        <tbody>
          <tr v-for="s in sessoes.lista" :key="s.id">
            <td>{{ s.dispositivo ?? "—" }}</td>
            <td>{{ fmtDataHora(s.criadaEm) }}</td>
            <td>{{ s.ultimoUsoEm ? fmtDataHora(s.ultimoUsoEm) : "—" }}</td>
            <td>
              <span v-if="s.revogadaEm" class="mudo">Encerrado {{ fmtDataHora(s.revogadaEm) }}<template v-if="s.revogadaPor"> por {{ s.revogadaPor }}</template></span>
              <span v-else-if="new Date(s.expiraEm) < new Date()" class="mudo">Expirou</span>
              <span v-else class="chip verde">Ativo até {{ fmtDataHora(s.expiraEm) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="vazio">Nenhum acesso ainda.</div>
      <div class="modal-acoes"><button type="button" @click="sessoes = null">Fechar</button></div>
    </div>
  </div>

  <!-- Novo motorista -->
  <div v-if="edicao" class="fundo-modal" @mousedown.self="edicao = null">
    <form class="modal estreito" @submit.prevent="salvarEdicao">
      <h2>Editar motorista</h2>
      <div v-if="erroEdicao" class="erro">{{ erroEdicao }}</div>
      <div v-if="edicao.compartilhado" class="aviso pequeno">Este motorista também atende outros clientes: nome, placa e celular valem para todos e só ele mesmo pode alterar, pelo celular, na tela do QR ("Trocar placa" e "Trocar celular"; o número novo é confirmado por SMS).</div>
      <div class="campo"><label for="ed-nome">Nome *</label><input id="ed-nome" v-model="edicao.nome" required maxlength="120" :disabled="edicao.compartilhado" /></div>
      <div class="campo">
        <label for="ed-celular">Celular *</label>
        <input id="ed-celular" v-model="edicao.celular" type="tel" required :disabled="edicao.compartilhado" />
        <span class="dica">Número completo só aqui. Trocar o celular encerra os acessos atuais.</span>
      </div>
      <div class="campo"><label for="ed-placa">Placa</label><input id="ed-placa" v-model="edicao.placa" maxlength="8" style="text-transform: uppercase" :disabled="edicao.compartilhado" /></div>
      <div class="modal-acoes">
        <button v-if="!ehGestor && !edicao.compartilhado" type="button" class="perigo" style="margin-right: auto" title="Direito de exclusão (LGPD)" @click="anonimizar">Anonimizar (LGPD)</button>
        <button type="button" @click="edicao = null">{{ edicao.compartilhado ? "Fechar" : "Cancelar" }}</button>
        <button v-if="!edicao.compartilhado" type="submit" class="primario">Salvar</button>
      </div>
    </form>
  </div>

  <div v-if="novo" class="fundo-modal" @mousedown.self="novo = null">
    <form class="modal estreito" @submit.prevent="salvarNovo">
      <h2>Novo motorista</h2>
      <p class="mudo pequeno" style="margin-top: 0">Pré-cadastro: no primeiro acesso pelo QR ele confirma o celular (código SMS) e aceita o termo de uso dos dados.</p>
      <div v-if="erroNovo" class="erro">{{ erroNovo }}</div>
      <div class="campo"><label>Nome completo *</label><input v-model="novo.nome" required maxlength="120" /></div>
      <div class="campo"><label>Celular *</label><input v-model="novo.celular" type="tel" required placeholder="(11) 98765-4321" /></div>
      <div v-if="!ehGestor" class="campo">
        <label>Transportadora *</label>
        <select v-model="novo.transportadoraId" required>
          <option value="" disabled>Escolha…</option>
          <option v-for="t in transportadoras" :key="t.id" :value="t.id">{{ t.nome }}</option>
        </select>
      </div>
      <div class="campo"><label>Placa</label><input v-model="novo.placa" maxlength="8" placeholder="ABC1D23" style="text-transform: uppercase" /></div>
      <div class="campo"><label>CPF (opcional)</label><input v-model="novo.cpf" inputmode="numeric" maxlength="14" /></div>
      <div class="modal-acoes">
        <button type="button" @click="novo = null">Cancelar</button>
        <button type="submit" class="primario">Salvar</button>
      </div>
    </form>
  </div>

  <!-- Planilha -->
  <div v-if="planilha" class="fundo-modal" @mousedown.self="planilha = null">
    <div class="modal">
      <h2>Motoristas por planilha</h2>
      <p class="mudo pequeno" style="margin-top: 0">{{ planilha.arquivo.name }} — confira as linhas; nada é gravado até confirmar. Celular já cadastrado é recusado.</p>
      <div v-if="planilha.enviando" class="vazio">Processando…</div>
      <div v-if="planilha.erro" class="erro">{{ planilha.erro }}</div>
      <template v-if="(planilha.previa || planilha.resultado) && !planilha.enviando">
        <div v-if="planilha.resultado" class="sucesso">{{ planilha.resultado.importados }} motorista(s) pré-cadastrado(s).</div>
        <div v-else class="linha" style="gap: 8px">
          <span class="chip verde">{{ planilha.previa.validos }} pronto(s)</span>
          <span v-if="planilha.previa.comErro" class="chip vermelho">{{ planilha.previa.comErro }} com erro</span>
        </div>
        <div class="tabela-wrap" style="max-height: 45vh; overflow: auto; margin-top: 10px">
          <table class="pequeno">
            <thead><tr><th>Linha</th><th>Nome</th><th>Celular</th><th>Situação</th></tr></thead>
            <tbody>
              <tr v-for="l in linhasPlanilha" :key="l.linha">
                <td>{{ l.linha }}</td><td>{{ l.nome ?? "—" }}</td><td class="mono">{{ fmtCelular(l.celular) ?? "—" }}</td>
                <td><span v-if="l.erro" class="txt-VENCIDO">{{ l.erro }}</span><span v-else class="txt-OK">{{ l.importado ? "✓ Cadastrado" : "OK" }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <div class="modal-acoes">
        <button type="button" @click="planilha = null">{{ planilha.resultado ? "Fechar" : "Cancelar" }}</button>
        <button v-if="planilha.previa && !planilha.resultado" type="button" class="primario" :disabled="planilha.enviando || !planilha.previa.validos" @click="confirmarPlanilha">
          Cadastrar {{ planilha.previa.validos }} motorista(s)
        </button>
      </div>
    </div>
  </div>
</template>
