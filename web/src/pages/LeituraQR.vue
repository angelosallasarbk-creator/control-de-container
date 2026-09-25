<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import { ROTULO_STATUS, ROTULO_TIPO, fmtDataHora, fmtTemp, paraInputLocal, deInputLocal } from "../formato.js";
import { conferirNumero } from "../iso6346.js";

// Página aberta pela câmera do celular ao ler a etiqueta. Exige login (o App mostra o login
// antes e volta para cá). 1ª leitura: número + temperatura + data/hora; depois, só temperatura.
const props = defineProps({ token: { type: String, required: true } });
const auth = useAuthStore();

const info = ref(null);
const erroFatal = ref(null);
const erro = ref(null);
const enviando = ref(false);
const sucesso = ref(null); // { temperatura, resultado, numero }
const confirmarSubstituicao = ref(null); // código da etiqueta anterior
const f = reactive({ numero: "", temperatura: "", lidaEm: paraInputLocal() });

// Localização só funciona em página segura (https) ou localhost — no teste pela rede local (http) não.
const podeLocalizar = typeof window !== "undefined" && window.isSecureContext && "geolocation" in navigator;
const enviarLocalizacao = ref(podeLocalizar);

async function carregar() {
  try {
    info.value = await api.qr(props.token);
    erroFatal.value = null;
  } catch (e) {
    erroFatal.value = e.message;
  }
}
onMounted(carregar);

const estado = computed(() => info.value?.etiqueta.estado);
const container = computed(() => info.value?.container);
const conferencia = computed(() => (f.numero.trim() ? conferirNumero(f.numero) : null));
const temperaturaExigida = computed(() => estado.value === "LIVRE" || container.value?.reefer);

// O campo só tem minutos. Se a pessoa não mexer nele, grava o instante exato do envio (com
// segundos) — senão duas leituras no mesmo minuto colidiriam como "duplicadas".
const horarioEditado = ref(false);
function agora() {
  f.lidaEm = paraInputLocal();
  horarioEditado.value = false;
}
const horarioDaLeitura = () => (horarioEditado.value ? deInputLocal(f.lidaEm) : new Date().toISOString());

function obterLocalizacao() {
  if (!enviarLocalizacao.value) return Promise.resolve({});
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, precisaoM: Math.round(p.coords.accuracy) }),
      () => resolve({}), // sem permissão/sinal: salva sem localização
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 }
    );
  });
}

async function salvar(substituir = false) {
  erro.value = null;
  confirmarSubstituicao.value = null;
  if (estado.value === "LIVRE" && conferencia.value && !conferencia.value.formatoValido) {
    erro.value = "Número do container inválido: são 4 letras + 7 números (ex.: MSCU1234566).";
    return;
  }
  enviando.value = true;
  try {
    const dados = {
      temperatura: f.temperatura === "" ? undefined : String(f.temperatura).replace(",", "."),
      lidaEm: horarioDaLeitura(),
      ...(await obterLocalizacao()),
    };
    const r = estado.value === "LIVRE"
      ? await api.qrVincular(props.token, { ...dados, numero: f.numero, substituir })
      : await api.qrLeitura(props.token, dados);
    info.value = r;
    sucesso.value = { temperatura: dados.temperatura, resultado: r.resultado, numero: r.container?.numero };
    f.temperatura = "";
    f.numero = "";
  } catch (e) {
    if (e.codigo === "ETIQUETA_EXISTENTE") confirmarSubstituicao.value = e.dados.etiquetaAnterior;
    else erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}

function novaLeitura() {
  sucesso.value = null;
  agora();
}
</script>

<template>
  <div class="movel">
    <header class="movel-topo">
      <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="8" width="28" height="16" rx="2" fill="#4a8fdc" /><path d="M8 11v10M13 11v10M18 11v10M23 11v10" stroke="#fff" stroke-width="2" /></svg>
      <span class="espaco">Controle de Container</span>
      <span class="pequeno">{{ auth.usuario?.nome }}</span>
    </header>

    <main class="movel-corpo">
      <div v-if="erroFatal" class="erro grande">{{ erroFatal }}</div>
      <div v-else-if="!info" class="vazio">Carregando…</div>

      <!-- Sucesso -->
      <section v-else-if="sucesso" class="cartao resultado" :class="sucesso.resultado && sucesso.resultado !== 'OK' ? 'ruim' : 'bom'">
        <div class="icone" aria-hidden="true">{{ sucesso.resultado && sucesso.resultado !== "OK" ? "⚠" : "✓" }}</div>
        <h1>{{ sucesso.temperatura !== undefined ? "Leitura registrada" : "Etiqueta ligada ao container" }}</h1>
        <div class="mono numero">{{ sucesso.numero }}</div>
        <div v-if="sucesso.temperatura !== undefined" class="temp">{{ fmtTemp(sucesso.temperatura) }}</div>
        <p v-if="sucesso.resultado === 'ACIMA'" class="aviso-forte">Temperatura ACIMA da faixa ({{ fmtTemp(container.tempMin) }} a {{ fmtTemp(container.tempMax) }}). O alerta já apareceu no sistema — avise o responsável.</p>
        <p v-else-if="sucesso.resultado === 'ABAIXO'" class="aviso-forte">Temperatura ABAIXO da faixa ({{ fmtTemp(container.tempMin) }} a {{ fmtTemp(container.tempMax) }}). O alerta já apareceu no sistema — avise o responsável.</p>
        <p v-else-if="sucesso.resultado === 'OK'" class="mudo">Dentro da faixa ({{ fmtTemp(container.tempMin) }} a {{ fmtTemp(container.tempMax) }}).</p>
        <button v-if="container?.reefer" class="primario bloco" @click="novaLeitura">Registrar outra leitura</button>
      </section>

      <template v-else>
        <div class="etiqueta-cod">Etiqueta <strong class="mono">{{ info.etiqueta.codigo }}</strong></div>

        <!-- Container já ligado -->
        <section v-if="container" class="cartao">
          <div class="mono numero">{{ container.numero }}</div>
          <div class="mudo">{{ ROTULO_TIPO[container.tipo] }} · {{ container.cliente }} / {{ container.fabrica }}</div>
          <div class="linha" style="margin-top: 8px; gap: 6px">
            <span class="chip azul">{{ ROTULO_STATUS[container.status] }}</span>
            <span v-if="container.reefer" class="chip">Faixa {{ fmtTemp(container.tempMin) }} a {{ fmtTemp(container.tempMax) }}</span>
          </div>
          <div v-if="container.ultimasLeituras.length" class="ultimas">
            <div class="mudo pequeno">Últimas leituras</div>
            <div v-for="l in container.ultimasLeituras" :key="l.lidaEm" class="linha-entre pequeno">
              <span>{{ fmtDataHora(l.lidaEm) }}</span>
              <strong :class="l.temperatura < container.tempMin || l.temperatura > container.tempMax ? 'txt-VENCIDO' : ''">{{ fmtTemp(l.temperatura) }}</strong>
            </div>
          </div>
        </section>

        <div v-if="estado === 'ENCERRADA'" class="aviso grande">
          Este container já foi {{ container.status === "CANCELADO" ? "cancelado" : "entregue no porto" }}. A etiqueta está encerrada e não recebe novas leituras.
        </div>
        <div v-else-if="estado === 'CANCELADA'" class="aviso grande">
          Esta etiqueta foi cancelada{{ info.etiqueta.motivoCancelamento ? `: ${info.etiqueta.motivoCancelamento}` : "" }}. Use outra etiqueta.
        </div>
        <div v-else-if="!info.podeRegistrar" class="aviso grande">Seu perfil só permite consultar. Peça a um operador para registrar.</div>
        <div v-else-if="container && !container.reefer" class="aviso grande">Container dry: não há temperatura para registrar.</div>

        <!-- Formulário -->
        <form v-else class="cartao formulario" @submit.prevent="salvar(false)">
          <h1>{{ estado === "LIVRE" ? "Primeira leitura: ligar etiqueta ao container" : "Registrar temperatura" }}</h1>
          <div v-if="erro" class="erro">{{ erro }}</div>
          <div v-if="confirmarSubstituicao" class="aviso">
            Este container já tem a etiqueta <strong class="mono">{{ confirmarSubstituicao }}</strong>. Substituir por
            <strong class="mono">{{ info.etiqueta.codigo }}</strong>? A antiga será cancelada.
            <div class="linha" style="margin-top: 10px">
              <button type="button" @click="confirmarSubstituicao = null">Não</button>
              <button type="button" class="primario" :disabled="enviando" @click="salvar(true)">Sim, substituir</button>
            </div>
          </div>

          <div v-if="estado === 'LIVRE'" class="campo">
            <label for="numero">Número do container</label>
            <input
              id="numero" v-model="f.numero" class="mono grande-campo" required maxlength="15" placeholder="MSCU1234566"
              autocapitalize="characters" autocomplete="off" spellcheck="false"
            />
            <span v-if="conferencia && !conferencia.formatoValido" class="dica txt-VENCIDO">Formato: 4 letras + 7 números.</span>
            <span v-else-if="conferencia && !conferencia.digitoValido" class="dica txt-ATENCAO">O último dígito não confere com o padrão — confira na porta do container.</span>
            <span v-else-if="conferencia" class="dica txt-OK">✓ {{ conferencia.numero }}</span>
          </div>

          <div class="campo">
            <label for="temp">Temperatura (°C){{ estado === "LIVRE" ? " — obrigatória se for reefer" : "" }}</label>
            <input
              id="temp" v-model="f.temperatura" class="grande-campo" inputmode="decimal" placeholder="-18,0" autocomplete="off"
              :required="temperaturaExigida && estado !== 'LIVRE'"
            />
          </div>

          <div class="campo">
            <label for="quando">Data e hora da leitura</label>
            <div class="linha-horario">
              <input id="quando" v-model="f.lidaEm" type="datetime-local" class="grande-campo" required @input="horarioEditado = true" />
              <button type="button" @click="agora">Agora</button>
            </div>
            <span class="dica">Já vem com o horário atual. Ajuste só se a leitura foi feita antes.</span>
          </div>

          <label v-if="podeLocalizar" class="linha pequeno"><input v-model="enviarLocalizacao" type="checkbox" /> Registrar minha localização (prova de que a leitura foi no local)</label>

          <button type="submit" class="primario bloco" :disabled="enviando">{{ enviando ? "Salvando…" : "Salvar" }}</button>
        </form>
      </template>
    </main>
  </div>
</template>

<style scoped>
.movel { min-height: 100vh; background: var(--fundo); display: flex; flex-direction: column; }
.movel-topo { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: var(--lateral); color: #fff; font-weight: 700; position: sticky; top: 0; z-index: 10; }
.movel-corpo { padding: 16px; display: flex; flex-direction: column; gap: 14px; max-width: 520px; width: 100%; margin: 0 auto; }
.cartao { background: var(--superficie); border: 1px solid var(--borda); border-radius: 12px; padding: 18px; box-shadow: var(--sombra); display: flex; flex-direction: column; gap: 14px; }
.cartao h1 { font-size: 18px; }
.etiqueta-cod { color: var(--texto-2); }
.numero { font-size: 26px; font-weight: 800; letter-spacing: .03em; }
.ultimas { border-top: 1px solid var(--borda); padding-top: 10px; display: flex; flex-direction: column; gap: 4px; }
.grande-campo { font-size: 20px; padding: 12px; }
#numero { text-transform: uppercase; }
.linha-horario { display: flex; gap: 8px; align-items: stretch; }
.linha-horario input { flex: 1; min-width: 0; }
.linha-horario button { flex-shrink: 0; }
.formulario .campo label { font-size: 14px; }
button.bloco { width: 100%; justify-content: center; font-size: 18px; padding: 14px; border-radius: 10px; }
.grande { font-size: 16px; padding: 16px; }
.resultado { align-items: center; text-align: center; }
.resultado .icone { font-size: 56px; line-height: 1; }
.resultado.bom .icone { color: var(--verde); }
.resultado.ruim .icone { color: var(--vermelho); }
.resultado .temp { font-size: 40px; font-weight: 800; }
.aviso-forte { background: var(--vermelho-fundo); color: var(--vermelho); font-weight: 700; padding: 12px; border-radius: 8px; margin: 0; }
</style>
