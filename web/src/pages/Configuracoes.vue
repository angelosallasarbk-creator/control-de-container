<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import { fmtDataHora, minutosParaHora, horaParaMinutos } from "../formato.js";
import PermissoesUsuarios from "../components/PermissoesUsuarios.vue";
import Paginacao from "../components/Paginacao.vue";
import { usePaginacao } from "../composables/usePaginacao.js";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

// ---------- Abas ----------
// Regras: todos que abrem a tela veem; só o administrador edita. Permissões: só administrador.
// Log: quem tem "Ver log de auditoria".
const ABAS = computed(() =>
  [
    { chave: "geral", nome: "Geral", visivel: true },
    { chave: "custos", nome: "Custos", visivel: true },
    { chave: "rota", nome: "Previsão de rota", visivel: true },
    { chave: "etiquetas", nome: "Etiquetas QR", visivel: true },
    { chave: "rastreamento", nome: "Rastreamento (SMS)", visivel: true },
    { chave: "permissoes", nome: "Perfis e permissões", visivel: auth.pode("administrar") },
    { chave: "log", nome: "Log de auditoria", visivel: auth.pode("auditoria.ver") },
  ].filter((a) => a.visivel)
);
const aba = computed(() => {
  const pedida = route.query.aba ?? "geral";
  return ABAS.value.some((a) => a.chave === pedida) ? pedida : ABAS.value[0]?.chave;
});
const irPara = (chave) => router.replace({ query: { ...route.query, aba: chave } });
const podeEditar = computed(() => auth.pode("administrar"));
// Liga/desliga do rastreamento (o servidor guarda 1/0).
const smsLigado = computed({ get: () => Boolean(cfg.rastreioSmsAtivo), set: (v) => (cfg.rastreioSmsAtivo = v ? 1 : 0) });
const personalizado = computed({ get: () => Boolean(cfg.rastreioPersonalizado), set: (v) => (cfg.rastreioPersonalizado = v ? 1 : 0) });

// ---------- Regras (uma única configuração, salva por aba) ----------
const cfg = reactive({ intervaloLeituraMinutos: null, cotacaoUSD: 0, cotacaoEUR: 0, urlPublica: "" });
// Janela de rodagem editada como "HH:MM" e gravada em minutos desde 00:00.
const inicioRodagem = ref("05:00");
const fimRodagem = ref("22:00");
const erro = ref(null);
const salvo = ref(null);

function aplicar(c) {
  Object.assign(cfg, c);
  inicioRodagem.value = minutosParaHora(c.rodagemInicioMin);
  fimRodagem.value = minutosParaHora(c.rodagemFimMin);
}
const janelaHoras = computed(() => (horaParaMinutos(fimRodagem.value) - horaParaMinutos(inicioRodagem.value)) / 60);
const mediaKmH = computed(() => (janelaHoras.value > 0 ? cfg.kmPorDia / janelaHoras.value : 0));

async function salvar() {
  erro.value = null;
  salvo.value = null;
  try {
    aplicar(await api.salvarConfiguracao({ ...cfg, rodagemInicioMin: horaParaMinutos(inicioRodagem.value), rodagemFimMin: horaParaMinutos(fimRodagem.value) }));
    salvo.value = aba.value;
    setTimeout(() => (salvo.value = null), 4000);
  } catch (e) {
    erro.value = e.message;
  }
}

// ---------- Log ----------
const logs = ref([]);
const buscaLog = ref("");
async function carregarLogs() {
  if (!auth.pode("auditoria.ver")) return;
  try {
    logs.value = await api.logs();
  } catch (e) {
    erro.value = e.message;
  }
}
const logsFiltrados = computed(() => {
  const b = buscaLog.value.trim().toLowerCase();
  return b ? logs.value.filter((l) => `${l.usuarioEmail} ${l.acao} ${l.descricao}`.toLowerCase().includes(b)) : logs.value;
});
watch(aba, (a) => a === "log" && carregarLogs());

// IPs desta máquina na rede: sugestões para o endereço do QR ao testar sem publicar.
const sugestoesEndereco = ref([]);

onMounted(async () => {
  try {
    aplicar(await api.configuracao());
  } catch (e) {
    erro.value = e.message;
  }
  if (podeEditar.value) api.configImpressao().then((r) => (sugestoesEndereco.value = r.sugestoes ?? [])).catch(() => {});
  if (aba.value === "log") carregarLogs();
});

// Paginação da lista (10/20/50 por página, lembrado neste navegador).
const pag = usePaginacao(() => logsFiltrados.value, "log");
</script>

<template>
  <nav class="abas" role="tablist" aria-label="Configurações">
    <button v-for="a in ABAS" :key="a.chave" role="tab" class="aba" :class="{ ativa: a.chave === aba }" :aria-selected="a.chave === aba" @click="irPara(a.chave)">
      {{ a.nome }}
    </button>
  </nav>

  <div v-if="erro" class="erro">{{ erro }}</div>
  <div v-if="!podeEditar && ['geral', 'custos', 'rota', 'etiquetas', 'rastreamento'].includes(aba)" class="aviso pequeno">Somente leitura — só o administrador altera estas regras.</div>

  <!-- Geral -->
  <form v-if="aba === 'geral'" class="card" @submit.prevent="salvar">
    <h2>Geral</h2>
    <div class="grade-form">
      <div class="campo">
        <label>Intervalo máximo entre leituras de temperatura (minutos)</label>
        <input v-model.number="cfg.intervaloLeituraMinutos" type="number" min="0" max="10080" required :disabled="!podeEditar" />
        <span class="dica">Vale para reefer em ovação ou liberado. Passou disso sem leitura: alerta de Atenção; o dobro: Crítico. 0 desliga.</span>
      </div>
      <div class="campo">
        <label>Tolerância do "no prazo" nas etapas (minutos)</label>
        <input v-model.number="cfg.toleranciaPlanejadoMinutos" type="number" min="0" max="10080" step="5" required :disabled="!podeEditar" />
        <span class="dica">Aba Etapas do container: realizado até este tempo depois do planejado fica verde (no prazo); passou disso, vermelho.</span>
      </div>
      <div class="campo">
        <label>Atraso na coleta vira crítico após (horas)</label>
        <input v-model.number="cfg.atrasoColetaCriticoHoras" type="number" min="0" max="720" step="0.5" required :disabled="!podeEditar" />
        <span class="dica">Passou da "coleta programada" sem coleta registrada: alerta de Atenção na hora; depois destas horas, Crítico.</span>
      </div>
    </div>
    <div v-if="podeEditar" class="linha" style="margin-top: 12px"><button type="submit" class="primario">Salvar</button><span v-if="salvo === 'geral'" class="txt-OK pequeno">✓ Salvo e alertas recalculados.</span></div>
  </form>

  <!-- Custos -->
  <form v-if="aba === 'custos'" class="card" @submit.prevent="salvar">
    <h2>Custos</h2>
    <div class="grade-form">
      <div class="campo">
        <label>Cotação do dólar (R$ por US$ 1)</label>
        <input v-model="cfg.cotacaoUSD" type="number" min="0" step="0.0001" :disabled="!podeEditar" />
        <span class="dica">Usada só para somar tudo em R$ no Custo estimado. 0 = não informada (valores ficam separados por moeda).</span>
      </div>
      <div class="campo">
        <label>Cotação do euro (R$ por € 1)</label>
        <input v-model="cfg.cotacaoEUR" type="number" min="0" step="0.0001" :disabled="!podeEditar" />
        <span class="dica">Só se algum armador cobrar em euro.</span>
      </div>
    </div>
    <div v-if="podeEditar" class="linha" style="margin-top: 12px"><button type="submit" class="primario">Salvar</button><span v-if="salvo === 'custos'" class="txt-OK pequeno">✓ Salvo.</span></div>
  </form>

  <!-- Previsão de rota -->
  <form v-if="aba === 'rota'" class="card" @submit.prevent="salvar">
    <h2>Previsão de rota</h2>
    <div class="mudo pequeno" style="margin: -6px 0 10px">
      Usada para prever a entrega no porto e o risco de demurrage. O caminhão só roda dentro da janela de horário (todos os dias,
      inclusive fim de semana e feriado) e faz no máximo os km por dia informados; fora da janela fica parado.
    </div>
    <div class="grade-form">
      <div class="campo"><label>Rodagem: início</label><input v-model="inicioRodagem" type="time" required :disabled="!podeEditar" /></div>
      <div class="campo"><label>Rodagem: fim</label><input v-model="fimRodagem" type="time" required :disabled="!podeEditar" /></div>
      <div class="campo">
        <label>Km máximos por dia</label>
        <input v-model.number="cfg.kmPorDia" type="number" min="50" max="2000" step="10" required :disabled="!podeEditar" />
        <span class="dica">Janela de {{ janelaHoras }}h → média de {{ mediaKmH.toFixed(1).replace(".", ",") }} km/h rodando.</span>
      </div>
      <div class="campo">
        <label>Fila / gate padrão no porto (h)</label>
        <input v-model.number="cfg.filaPortoHorasPadrao" type="number" min="0" max="240" step="0.5" required :disabled="!podeEditar" />
        <span class="dica">Cada porto pode ter o seu tempo em Locais.</span>
      </div>
      <div class="campo">
        <label>Alertar risco com folga menor que (h)</label>
        <input v-model.number="cfg.riscoFolgaHoras" type="number" min="0" max="720" step="1" required :disabled="!podeEditar" />
        <span class="dica">Folga negativa = demurrage prevista (Crítico).</span>
      </div>
      <div class="campo">
        <label>Fator da estimativa em linha reta</label>
        <input v-model.number="cfg.fatorLinhaReta" type="number" min="1" max="3" step="0.05" required :disabled="!podeEditar" />
        <span class="dica">Só quando o serviço de rota não responde: distância em linha reta × fator.</span>
      </div>
    </div>
    <div v-if="podeEditar" class="linha" style="margin-top: 12px"><button type="submit" class="primario">Salvar</button><span v-if="salvo === 'rota'" class="txt-OK pequeno">✓ Salvo e previsões recalculadas.</span></div>
  </form>

  <!-- Etiquetas QR -->
  <form v-if="aba === 'etiquetas'" class="card" @submit.prevent="salvar">
    <h2>Etiquetas QR</h2>
    <div class="grade-form">
      <div v-if="cfg.enderecoDaPlataforma" class="campo" style="grid-column: 1 / -1">
        <label>Endereço do sistema para o celular (vai dentro do QR, nos SMS e nos e-mails)</label>
        <input :value="cfg.enderecoDaPlataforma" disabled />
        <span class="dica">Definido pela plataforma — o mesmo para todos os clientes, por segurança dos links enviados.</span>
      </div>
      <div v-else class="campo" style="grid-column: 1 / -1">
        <label>Endereço do sistema para o celular (vai dentro do QR)</label>
        <input v-model.trim="cfg.urlPublica" list="sugestoes-endereco" placeholder="https://meusistema.onrender.com" :disabled="!podeEditar" />
        <datalist id="sugestoes-endereco">
          <option v-for="s in sugestoesEndereco" :key="s.url" :value="s.url">{{ s.rotulo }}</option>
        </datalist>
        <span class="dica">
          Todas as etiquetas (navegador e ZPL) usam este endereço — a tela de Etiquetas não pede outro. Sistema publicado: o endereço
          https dele. Teste na rede local: IP deste computador + porta (o celular no mesmo Wi-Fi). Etiquetas impressas antes de uma troca
          continuam com o endereço antigo. Vazio = ninguém consegue imprimir.
        </span>
      </div>
    </div>
    <p class="mudo pequeno">
      Quem pode gerar, imprimir e cancelar etiquetas é definido por usuário na aba
      <a href="#" @click.prevent="irPara('permissoes')">Perfis e permissões</a>.
    </p>
    <div v-if="podeEditar" class="linha" style="margin-top: 12px"><button type="submit" class="primario">Salvar</button><span v-if="salvo === 'etiquetas'" class="txt-OK pequeno">✓ Salvo.</span></div>
  </form>

  <!-- Rastreamento por SMS -->
  <form v-if="aba === 'rastreamento'" class="card" @submit.prevent="salvar">
    <h2>Rastreamento por SMS</h2>
    <div class="mudo pequeno" style="margin: -6px 0 10px">
      Quem registra algo pelo QR do container (vínculo, temperatura, coleta, entrada/saída) passa a ser o responsável por ele e recebe
      um SMS de aviso. Enquanto o container estiver ativo, o responsável recebe SMS com um link para enviar a posição GPS do celular.
      Quando outra pessoa registra pelo QR, o rastreamento passa para ela e o anterior para de receber. O celular vem do cadastro do
      usuário (Configurações → Usuários). O envio usa a conta Brevo (créditos de SMS); sem a chave configurada no servidor, o SMS é só simulado.
    </div>
    <div class="grade-form">
      <label class="chave-linha">
        <input v-model="smsLigado" type="checkbox" :disabled="!podeEditar" />
        <span>Enviar SMS de rastreamento</span>
      </label>
    </div>

    <h3 class="subtitulo">Quando pedir a posição</h3>
    <label class="chave-linha">
      <input v-model="personalizado" type="checkbox" :disabled="!podeEditar" />
      <span>Intervalo personalizado</span>
    </label>
    <p class="mudo pequeno" style="margin: 4px 0 10px">
      <template v-if="personalizado">Pede a posição a cada intervalo fixo enquanto o container estiver ativo. Atenção ao custo: em trânsito, 30 min = até 48 SMS por dia por container.</template>
      <template v-else>
        <strong>Padrão — só em trechos críticos</strong> (menos SMS). Pede a posição quando:
        a <strong>previsão estoura</strong> (passou do horário planejado da próxima etapa além da tolerância da aba Geral),
        há <strong>risco de prazo</strong> (alerta aberto de risco de demurrage, risco de deadline, free time ou deadline),
        o container está <strong>parado</strong> (2 últimas posições no mesmo lugar, até 500 m) ou está <strong>sem posição</strong> há muito tempo.
        No ponto de carregamento só vale o risco de prazo. Na ficha, o botão <strong>"Solicitar posição"</strong> pede na hora.
      </template>
    </p>
    <div v-if="personalizado" class="grade-form">
      <div class="campo">
        <label>Pedir a posição a cada (minutos)</label>
        <input v-model.number="cfg.rastreioIntervaloMin" type="number" min="10" max="1440" step="5" required :disabled="!podeEditar" />
        <span class="dica">Em trânsito e demais etapas ativas.</span>
      </div>
      <div class="campo">
        <label>No ponto de carregamento, a cada (minutos)</label>
        <input v-model.number="cfg.rastreioIntervaloCarregamentoMin" type="number" min="10" max="1440" step="5" required :disabled="!podeEditar" />
        <span class="dica">Da chegada até a saída do ponto de carregamento: {{ (cfg.rastreioIntervaloCarregamentoMin / 60).toFixed(1).replace(".0", "").replace(".", ",") }} h.</span>
      </div>
    </div>
    <div v-else class="grade-form">
      <div class="campo">
        <label>Em trecho crítico, repetir a cada (minutos)</label>
        <input v-model.number="cfg.rastreioCriticoIntervaloMin" type="number" min="15" max="1440" step="5" required :disabled="!podeEditar" />
        <span class="dica">Enquanto houver previsão estourada, risco de prazo ou parado.</span>
      </div>
      <div class="campo">
        <label>Parado há mais de (horas)</label>
        <input v-model.number="cfg.rastreioParadoHoras" type="number" min="0.5" max="72" step="0.5" required :disabled="!podeEditar" />
        <span class="dica">Tempo entre as 2 últimas posições no mesmo lugar (até 500 m).</span>
      </div>
      <div class="campo">
        <label>Sem posição há mais de (horas)</label>
        <input v-model.number="cfg.rastreioSemPosicaoHoras" type="number" min="1" max="168" step="1" required :disabled="!podeEditar" />
        <span class="dica">Em trânsito: checagem esparsa (repete a cada este tempo sem resposta).</span>
      </div>
    </div>
    <h3 class="subtitulo">Dados pessoais (LGPD)</h3>
    <div class="grade-form">
      <div class="campo">
        <label>Guardar as posições GPS por (dias)</label>
        <input v-model.number="cfg.retencaoPosicoesDias" type="number" min="30" max="3650" step="1" required :disabled="!podeEditar" />
        <span class="dica">Posições mais antigas são apagadas automaticamente uma vez por dia.</span>
      </div>
    </div>
    <p class="mudo pequeno">O link do SMS usa o endereço do sistema da aba <a href="#" @click.prevent="irPara('etiquetas')">Etiquetas QR</a>.</p>
    <div v-if="podeEditar" class="linha" style="margin-top: 12px"><button type="submit" class="primario">Salvar</button><span v-if="salvo === 'rastreamento'" class="txt-OK pequeno">✓ Salvo.</span></div>
  </form>

  <!-- Perfis e permissões -->
  <PermissoesUsuarios v-if="aba === 'permissoes'" />

  <!-- Log -->
  <div v-if="aba === 'log'" class="card tabela-wrap">
    <div class="linha-entre" style="margin-bottom: 10px">
      <h2 style="margin: 0">Log de auditoria (últimos 300 registros)</h2>
      <input v-model="buscaLog" placeholder="Filtrar por usuário, ação ou texto" style="max-width: 320px" />
    </div>
    <table class="pequeno">
      <thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Descrição</th></tr></thead>
      <tbody>
        <tr v-for="l in pag.itens.value" :key="l.id">
          <td style="white-space: nowrap">{{ fmtDataHora(l.criadoEm) }}</td>
          <td>{{ l.usuarioEmail }}</td>
          <td>{{ l.acao }}</td>
          <td>{{ l.descricao }}</td>
        </tr>
        <tr v-if="!logsFiltrados.length"><td colspan="4" class="vazio">Nenhum registro.</td></tr>
      </tbody>
    </table>
      <Paginacao :p="pag" />
  </div>
</template>

<style scoped>
.chave-linha { display: flex; gap: 8px; align-items: center; font-weight: 600; cursor: pointer; grid-column: 1 / -1; }
.chave-linha input { width: auto; margin: 0; }
.subtitulo { margin: 16px 0 6px; font-size: 15px; }
</style>
