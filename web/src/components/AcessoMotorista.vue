<script setup>
// Acesso do motorista pelo celular (sem usuário/senha):
// 1) celular → 2) código de 6 dígitos (SMS, vale 15 min) → 3) primeiro acesso: nome, transportadora,
// placa, CPF (opcional) e aceite do termo. Depois o celular fica lembrado (60 dias).
import { computed, onBeforeUnmount, ref } from "vue";
import { api } from "../api.js";

defineProps({ aviso: { type: String, default: null } });
const emit = defineEmits(["entrou", "equipe"]);

const etapa = ref("celular"); // celular | codigo | cadastro
const celular = ref("");
const codigo = ref("");
const erro = ref(null);
const info = ref(null);
const enviando = ref(false);
const cad = ref({ nome: "", transportadoraId: "", placa: "", cpf: "", aceite: false });
const transportadoras = ref([]);
let comprovante = null;

// Reenviar só depois de 60 s (o servidor também limita).
const espera = ref(0);
let timer = null;
function contarEspera() {
  espera.value = 60;
  clearInterval(timer);
  timer = setInterval(() => { espera.value = Math.max(0, espera.value - 1); if (!espera.value) clearInterval(timer); }, 1000);
}
onBeforeUnmount(() => clearInterval(timer));

async function executar(fn) {
  erro.value = null;
  enviando.value = true;
  try {
    await fn();
  } catch (e) {
    erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}

const pedirCodigo = () => executar(async () => {
  const r = await api.motoristaPedirCodigo(celular.value);
  info.value = r.simulado ? `${r.mensagem} (teste: SMS simulado — veja o código no console do servidor)` : r.mensagem;
  codigo.value = "";
  etapa.value = "codigo";
  contarEspera();
});

const confirmarCodigo = () => executar(async () => {
  const r = await api.motoristaVerificar(celular.value, codigo.value);
  if (r.motorista) return emit("entrou", r.motorista);
  comprovante = r.comprovante;
  transportadoras.value = r.transportadoras;
  if (r.preenchido) cad.value = { ...cad.value, nome: r.preenchido.nome ?? "", transportadoraId: r.preenchido.transportadoraId ?? "", placa: r.preenchido.placa ?? "" };
  info.value = null;
  etapa.value = "cadastro";
});

const podeCadastrar = computed(() => cad.value.nome.trim().length >= 3 && cad.value.transportadoraId && cad.value.aceite);
const concluir = () => executar(async () => {
  const r = await api.motoristaCadastro({ ...cad.value, comprovante });
  emit("entrou", r.motorista);
});
</script>

<template>
  <div class="login-shell">
    <div class="login-card">
      <div class="marca">
        <div class="marca-sigla">CCS</div>
        <div class="marca-nome">Container Control Solutions</div>
      </div>
      <div class="login-subtitulo">{{ etapa === "cadastro" ? "Primeiro acesso" : "Acesso do motorista" }}</div>
      <div v-if="aviso" class="erro" role="alert">{{ aviso }}</div>
      <div v-if="erro" class="erro" role="alert">{{ erro }}</div>
      <div v-if="info" class="sucesso pequeno" role="status">{{ info }}</div>

      <form v-if="etapa === 'celular'" class="passos" @submit.prevent="pedirCodigo">
        <p class="mudo pequeno" style="margin: 0">Informe o seu celular. Vamos mandar um código por SMS para confirmar que é você.</p>
        <div class="campo">
          <label for="celular-motorista">Celular com DDD</label>
          <input id="celular-motorista" v-model="celular" type="tel" inputmode="tel" autocomplete="tel" placeholder="(11) 98765-4321" required />
        </div>
        <button type="submit" class="primario" :disabled="enviando">{{ enviando ? "Enviando…" : "Receber código por SMS" }}</button>
      </form>

      <form v-else-if="etapa === 'codigo'" class="passos" @submit.prevent="confirmarCodigo">
        <div class="campo">
          <label for="codigo-motorista">Código de 6 números</label>
          <input
            id="codigo-motorista" v-model="codigo" class="codigo" type="text" inputmode="numeric" autocomplete="one-time-code"
            maxlength="6" pattern="\d{6}" placeholder="000000" required
          />
          <span class="dica">Enviado para {{ celular }}. Vale por 15 minutos.</span>
        </div>
        <button type="submit" class="primario" :disabled="enviando || codigo.length !== 6">{{ enviando ? "Conferindo…" : "Entrar" }}</button>
        <div class="linha-entre pequeno">
          <button type="button" class="link" @click="etapa = 'celular'; info = null">Trocar número</button>
          <button type="button" class="link" :disabled="espera > 0 || enviando" @click="pedirCodigo">{{ espera ? `Reenviar em ${espera}s` : "Reenviar código" }}</button>
        </div>
      </form>

      <form v-else class="passos" @submit.prevent="concluir">
        <div class="campo">
          <label for="nome-motorista">Nome completo *</label>
          <input id="nome-motorista" v-model="cad.nome" autocomplete="name" maxlength="120" required />
        </div>
        <div class="campo">
          <label for="transp-motorista">Transportadora *</label>
          <select id="transp-motorista" v-model="cad.transportadoraId" required>
            <option value="" disabled>Escolha…</option>
            <option v-for="t in transportadoras" :key="t.id" :value="t.id">{{ t.nome }}</option>
          </select>
        </div>
        <div class="campo">
          <label for="placa-motorista">Placa do caminhão</label>
          <input id="placa-motorista" v-model="cad.placa" maxlength="8" placeholder="ABC1D23" style="text-transform: uppercase" />
        </div>
        <div class="campo">
          <label for="cpf-motorista">CPF (opcional)</label>
          <input id="cpf-motorista" v-model="cad.cpf" inputmode="numeric" maxlength="14" placeholder="000.000.000-00" />
        </div>
        <label class="termo">
          <input v-model="cad.aceite" type="checkbox" />
          <span>
            Autorizo o uso do meu nome, celular, placa (e CPF, se informado) e da <strong>localização do celular quando eu enviar a posição</strong>
            para o controle da operação dos containers. As posições são guardadas por tempo limitado e apagadas depois. A transportadora
            pode bloquear o meu acesso.
          </span>
        </label>
        <button type="submit" class="primario" :disabled="enviando || !podeCadastrar">{{ enviando ? "Salvando…" : "Concluir e entrar" }}</button>
      </form>

      <p v-if="etapa !== 'cadastro'" class="equipe pequeno"><button type="button" class="link" @click="emit('equipe')">Sou da equipe (entrar com e-mail e senha)</button></p>
    </div>
  </div>
</template>

<style scoped>
.marca { text-align: center; }
.marca-sigla { font-size: 30px; font-weight: 800; letter-spacing: .06em; line-height: 1.1; }
.marca-nome { font-size: 13px; color: var(--texto-2); margin-top: 2px; letter-spacing: .02em; }
.login-subtitulo { text-align: center; font-size: 16px; font-weight: 600; margin-top: 4px; }
.passos { display: flex; flex-direction: column; gap: 12px; }
.passos button[type="submit"] { justify-content: center; padding: 11px; }
.codigo { font-size: 24px; letter-spacing: .4em; text-align: center; font-family: ui-monospace, monospace; }
.link { background: none; border: none; padding: 0; color: var(--primaria); cursor: pointer; font-size: inherit; }
.link:disabled { color: var(--texto-2); cursor: default; }
.termo { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; line-height: 1.4; color: var(--texto-2); cursor: pointer; }
.termo input { width: auto; margin-top: 2px; }
.equipe { text-align: center; margin: 4px 0 0; }
</style>
