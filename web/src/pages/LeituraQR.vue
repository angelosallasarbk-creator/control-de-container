<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { api, qrMotorista } from "../api.js";
import { useAuthStore } from "../stores/auth.js";
import { FLUXO, rotuloEtapa, ROTULO_TIPO, fmtDataHora, fmtTemp, paraInputLocal, deInputLocal, atendeRegraLocal } from "../formato.js";
import { conferirNumero } from "../iso6346.js";
import { melhorPosicao } from "../geolocalizacao.js";

// Página aberta pela câmera do celular ao ler a etiqueta. Exige login (o App mostra o login
// antes e volta para cá). 1ª leitura: número + temperatura + data/hora; depois, só temperatura.
// motorista: acesso pelo celular (sem usuário) — mesmas telas, rotas /api/motorista/qr.
const props = defineProps({ token: { type: String, required: true }, motorista: { type: Object, default: null } });
const emit = defineEmits(["sair", "sessao-encerrada", "motorista-atualizado"]);
const auth = useAuthStore();
const q = props.motorista ? qrMotorista : api;
const nomeQuem = computed(() => props.motorista ? `${props.motorista.nome} · ${props.motorista.transportadora?.nome ?? ""}` : auth.usuario?.nome);
// Placa do caminhão do motorista: confere na tela e troca se mudou de caminhão. O próximo registro
// pelo QR grava motorista e placa no container.
const trocandoPlaca = ref(false);
const novaPlaca = ref("");
const erroPlaca = ref(null);
function abrirPlaca() {
  novaPlaca.value = props.motorista?.placa ?? "";
  erroPlaca.value = null;
  trocandoPlaca.value = true;
}
async function salvarPlaca() {
  erroPlaca.value = null;
  try {
    const r = await api.motoristaAtualizar({ placa: novaPlaca.value });
    emit("motorista-atualizado", r.motorista);
    trocandoPlaca.value = false;
  } catch (e) {
    erroPlaca.value = e.message;
  }
}

// Trocar o próprio celular (v3.2): código SMS no número NOVO. O celular é a identidade do motorista
// e vale para todos os clientes — por isso só ele troca, e os outros acessos dele caem.
const etapaCel = ref(null); // null | "numero" | "codigo"
const novoCel = ref("");
const codigoCel = ref("");
const erroCel = ref(null);
const avisoCel = ref(null);
function abrirCelular() {
  etapaCel.value = "numero";
  novoCel.value = "";
  codigoCel.value = "";
  erroCel.value = null;
  avisoCel.value = null;
}
async function pedirCodigoCelular() {
  erroCel.value = null;
  try {
    await api.motoristaTrocarCelular(novoCel.value);
    etapaCel.value = "codigo";
  } catch (e) {
    erroCel.value = e.message;
  }
}
async function confirmarCelular() {
  erroCel.value = null;
  try {
    const r = await api.motoristaConfirmarCelular(novoCel.value, codigoCel.value);
    emit("motorista-atualizado", r.motorista);
    etapaCel.value = null;
    avisoCel.value = "Celular trocado. Os próximos SMS e o seu acesso usam o número novo.";
  } catch (e) {
    erroCel.value = e.message;
  }
}

// Sessão do motorista caiu (bloqueado/encerrada): volta para a tela de acesso.
function tratarErroMotorista(e) {
  if (props.motorista && (e.status === 401 || e.status === 403) && e.codigo && /MOTORISTA/.test(e.codigo)) {
    emit("sessao-encerrada", e.message);
    return true;
  }
  return false;
}

const info = ref(null);
const erroFatal = ref(null);
const erro = ref(null);
const enviando = ref(false);
const sucesso = ref(null); // { temperatura, resultado, numero }
const confirmarSubstituicao = ref(null); // código da etiqueta anterior
const f = reactive({ numero: "", temperatura: "", lidaEm: paraInputLocal(), placa: "", motivoPlaca: "" });
// Etiqueta nova: programação do container digitado (trajeto, placa e se controla temperatura).
const programacao = ref(null);
// Transportador: onde retirou (Tipo > Local) e, se o container não existir, os dados do cadastro.
const col = reactive({ tipoId: "", localId: "", carregamentoId: "", entregaId: "", tipoContainer: "", grupoId: "", armadorId: "", produtoId: "", tipoOperacaoId: "" });
// Trajeto (retirada, carregamento, entrega) preenchido com a programação: quem lê só confere.
const trajetoPreenchido = ref(false);
const opcoes = ref(null);
const precisaCadastro = ref(false);
// Portaria: entrada ou saída do ponto de carregamento.
const movimento = ref("");

// Localização só funciona em página segura (https) ou localhost — no teste pela rede local (http) não.
const podeLocalizar = typeof window !== "undefined" && window.isSecureContext && "geolocation" in navigator;
const enviarLocalizacao = ref(podeLocalizar);

async function carregar() {
  try {
    // Transportador: busca as opções da coleta junto (a tela já abre com Tipo/Local prontos).
    const transportador = Boolean(props.motorista) || auth.usuario?.perfil === "TRANSPORTADOR";
    const [r, op] = await Promise.all([q.qr(props.token), transportador && !opcoes.value ? q.qrOpcoesColeta(props.token) : null]);
    if (op) {
      opcoes.value = op;
      // Cadastro pelo QR: começa no Tipo de Operação padrão.
      col.tipoOperacaoId = (op.tiposOperacao ?? []).find((x) => x.padrao)?.id ?? "";
    }
    info.value = r;
    erroFatal.value = null;
    if (r.container?.trajeto && r.container.status === "PROGRAMADO") await aplicarTrajeto(r.container.trajeto);
  } catch (e) {
    if (tratarErroMotorista(e)) return;
    erroFatal.value = e.message;
  }
}
onMounted(carregar);

const estado = computed(() => info.value?.etiqueta.estado);
const container = computed(() => info.value?.container);
const conferencia = computed(() => (f.numero.trim() ? conferirNumero(f.numero) : null));
const temperaturaExigida = computed(() => estado.value === "LIVRE" || container.value?.reefer);

// Transportador lendo etiqueta nova ou de container ainda não coletado: registra a coleta.
const modoColeta = computed(
  () => info.value?.modoTransportador && info.value.podeRegistrar &&
    (estado.value === "LIVRE" || (estado.value === "VINCULADA" && container.value?.status === "PROGRAMADO"))
);
// Tipo de local aceito em cada campo: do fluxo do container (já cadastrado), ou do Tipo de Operação
// escolhido no cadastro pelo QR; sem saber ainda, o da exportação (porto → fábrica → porto).
const REGRA_PADRAO = { portoRetiradaId: { funcao: "RETIRADA_ENTREGA" }, localCarregamentoId: { funcao: "CARREGAMENTO" }, portoEntregaId: { funcao: "RETIRADA_ENTREGA" } };
const tipoOperacaoNovo = computed(() => (opcoes.value?.tiposOperacao ?? []).find((x) => x.id === Number(col.tipoOperacaoId)) ?? null);
function regrasDoTipo(tipo) {
  const etapa = (acao) => tipo.etapas.find((e) => e.acao === acao);
  const regra = (e) => (e ? { funcao: e.funcaoLocal, tipoLocalId: e.tipoLocalId } : null);
  return { portoRetiradaId: regra(etapa("COLETA")), localCarregamentoId: regra(etapa("CHEGADA")), portoEntregaId: regra(etapa("ENTREGA")) };
}
const regras = computed(() =>
  container.value?.regrasLocal ?? programacao.value?.regrasLocal ?? (precisaCadastro.value && tipoOperacaoNovo.value ? regrasDoTipo(tipoOperacaoNovo.value) : REGRA_PADRAO)
);
// Listas completas (v2.0) com recuo para as antigas (servidor anterior).
const todosLocais = computed(() => opcoes.value?.todosLocais ?? [...(opcoes.value?.locais ?? []).map((l) => ({ ...l, tipo: { id: l.tipoId, funcao: "RETIRADA_ENTREGA" } })), ...(opcoes.value?.locaisCarregamento ?? []).map((l) => ({ ...l, tipo: { funcao: "CARREGAMENTO" } }))]);
const locaisDoCampo = (campo) => todosLocais.value.filter((l) => atendeRegraLocal(l, regras.value[campo]));
const locaisRetirada = computed(() => locaisDoCampo("portoRetiradaId"));
const locaisCarregamento = computed(() => locaisDoCampo("localCarregamentoId"));
const locaisEntrega = computed(() => locaisDoCampo("portoEntregaId"));
const temCarregamento = computed(() => regras.value.localCarregamentoId !== null);
// Tipos de local (1º select da retirada) que têm local aceito.
const tiposRetirada = computed(() => (opcoes.value?.todosTipos ?? opcoes.value?.tipos ?? []).filter((x) => locaisRetirada.value.some((l) => l.tipoId === x.id)));
const locaisDoTipo = computed(() => locaisRetirada.value.filter((l) => l.tipoId === col.tipoId));
// Mudou a regra (tipo do container/cadastro): limpa o que não serve e aplica os locais sugeridos.
watch(regras, () => {
  if (col.tipoId && !tiposRetirada.value.some((x) => x.id === col.tipoId)) col.tipoId = "";
  if (col.carregamentoId && !locaisCarregamento.value.some((l) => l.id === col.carregamentoId)) col.carregamentoId = "";
  if (col.entregaId && !locaisEntrega.value.some((l) => l.id === col.entregaId)) col.entregaId = "";
});
watch(tipoOperacaoNovo, async (tipo) => {
  if (!tipo || !precisaCadastro.value) return;
  const sugerido = (acao) => tipo.etapas.find((e) => e.acao === acao)?.localSugeridoId ?? null;
  const retirada = todosLocais.value.find((l) => l.id === sugerido("COLETA"));
  if (retirada) {
    col.tipoId = retirada.tipoId;
    await nextTick();
    col.localId = retirada.id;
  }
  if (sugerido("CHEGADA")) col.carregamentoId = sugerido("CHEGADA");
  if (sugerido("ENTREGA")) col.entregaId = sugerido("ENTREGA");
});
watch(() => col.tipoId, () => {
  col.localId = locaisDoTipo.value.length === 1 ? locaisDoTipo.value[0].id : "";
});

// Preenche retirada (tipo + local), carregamento e entrega com a programação do container.
async function aplicarTrajeto(t) {
  if (!t) return;
  const retirada = todosLocais.value.find((l) => l.id === t.portoRetiradaId);
  if (retirada) {
    col.tipoId = retirada.tipoId;
    await nextTick(); // deixa o "trocou o tipo" limpar o local antes de preencher
    col.localId = retirada.id;
  }
  col.carregamentoId = t.localCarregamentoId ?? "";
  col.entregaId = t.portoEntregaId ?? "";
  trajetoPreenchido.value = Boolean(t.portoRetiradaId || t.localCarregamentoId || t.portoEntregaId);
}
// Etiqueta nova: número digitado e válido → busca a programação (se o container já estiver cadastrado).
let buscaProgramacao = null;
watch(() => conferencia.value?.formatoValido && conferencia.value.numero, (numero) => {
  clearTimeout(buscaProgramacao);
  programacao.value = null;
  if (!numero || estado.value !== "LIVRE") return;
  buscaProgramacao = setTimeout(async () => {
    try {
      const p = await q.qrProgramacao(numero, props.token);
      if (p.numero !== conferencia.value?.numero) return;
      programacao.value = p.cadastrado ? p : null;
      if (p.cadastrado && modoColeta.value) await aplicarTrajeto(p.trajeto);
      if (p.cadastrado && modoPortaria.value && !f.placa) f.placa = p.placa ?? "";
    } catch {
      // sem a programação, a pessoa preenche à mão
    }
  }, 400);
});
const novoReefer = computed(() => col.tipoContainer.startsWith("REEFER"));
// Container novo (cadastro pelo QR): controla temperatura se reefer E produto Congelado/Refrigerado.
const produtoNovo = computed(() => (opcoes.value?.produtos ?? []).find((p) => p.id === col.produtoId));
const novoComTemperatura = computed(() => novoReefer.value && produtoNovo.value?.categoria !== "CARGA_SECA");
// Etiqueta nova com container já conhecido: segue o que ele é (Carga Seca não pede temperatura).
const livreSemTemperatura = computed(() => estado.value === "LIVRE" && programacao.value?.controlaTemperatura === false);
const livreComTemperatura = computed(() => estado.value === "LIVRE" && programacao.value?.controlaTemperatura === true);
// Temperatura: container conhecido reefer, cadastro novo reefer, ou etiqueta nova (ainda não se sabe).
const pedeTemperaturaColeta = computed(() => container.value?.reefer || novoComTemperatura.value || (estado.value === "LIVRE" && !precisaCadastro.value && !livreSemTemperatura.value));
const temperaturaObrigatoria = computed(() => container.value?.reefer || novoComTemperatura.value || livreComTemperatura.value);

// O campo só tem minutos. Se a pessoa não mexer nele, grava o instante exato do envio (com
// segundos) — senão duas leituras no mesmo minuto colidiriam como "duplicadas".
const horarioEditado = ref(false);
function agora() {
  f.lidaEm = paraInputLocal();
  horarioEditado.value = false;
}
// Teclado numérico do celular muitas vezes não tem "-": o botão ± troca o sinal.
const negativa = computed(() => String(f.temperatura).trim().startsWith("-"));
function inverterSinal() {
  const v = String(f.temperatura).trim().replace(/^[-−+]+/, "");
  f.temperatura = negativa.value ? v : `-${v}`;
  document.getElementById("temp")?.focus();
}
const horarioDaLeitura = () => (horarioEditado.value ? deInputLocal(f.lidaEm) : new Date().toISOString());

function obterLocalizacao() {
  if (!enviarLocalizacao.value) return Promise.resolve({});
  // Até 8 s acompanhando as leituras e fica com a mais precisa (para antes se chegar a ±50 m).
  // Sem permissão/sinal: salva sem localização.
  return melhorPosicao({ alvoM: 50, tempoMaxMs: 8000, maximumAge: 60000 }).catch(() => ({}));
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
      ? await q.qrVincular(props.token, { ...dados, numero: f.numero, substituir })
      : await q.qrLeitura(props.token, dados);
    info.value = r;
    sucesso.value = { temperatura: dados.temperatura, resultado: r.resultado, numero: r.container?.numero };
    f.temperatura = "";
    f.numero = "";
  } catch (e) {
    if (tratarErroMotorista(e)) return;
    if (e.codigo === "ETIQUETA_EXISTENTE") confirmarSubstituicao.value = e.dados.etiquetaAnterior;
    else erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}

async function coletar({ substituir = false, confirmarDigito = false } = {}) {
  erro.value = null;
  confirmarSubstituicao.value = null;
  if (estado.value === "LIVRE" && conferencia.value && !conferencia.value.formatoValido) {
    erro.value = "Número do container inválido: são 4 letras + 7 números (ex.: MSCU1234566).";
    return;
  }
  enviando.value = true;
  try {
    const dados = {
      numero: f.numero,
      portoRetiradaId: col.localId,
      localCarregamentoId: temCarregamento.value ? col.carregamentoId || undefined : undefined,
      portoEntregaId: col.entregaId || undefined,
      coletadoEm: horarioDaLeitura(),
      temperatura: f.temperatura === "" ? undefined : String(f.temperatura).replace(",", "."),
      substituir,
      confirmarDigito,
      novo: precisaCadastro.value
        ? { tipo: col.tipoContainer, grupoId: col.grupoId, armadorId: col.armadorId, produtoId: novoReefer.value ? col.produtoId : null, tipoOperacaoId: col.tipoOperacaoId || undefined }
        : undefined,
      ...(await obterLocalizacao()),
    };
    const r = await q.qrColeta(props.token, dados);
    info.value = r;
    sucesso.value = {
      coleta: r.coleta, cadastrado: r.cadastrado, retirada: r.container?.retirada,
      temperatura: dados.temperatura, resultado: r.resultado, numero: r.container?.numero,
    };
    f.temperatura = "";
    f.numero = "";
    precisaCadastro.value = false;
  } catch (e) {
    if (tratarErroMotorista(e)) return;
    if (e.codigo === "ETIQUETA_EXISTENTE") confirmarSubstituicao.value = e.dados.etiquetaAnterior;
    else if (e.codigo === "CONTAINER_NAO_CADASTRADO") {
      precisaCadastro.value = true;
      erro.value = e.message;
    } else if (e.codigo === "DIGITO_INVALIDO") {
      if (confirm(`${e.message}\n\nSe o número está igual ao da porta do container, confirme para cadastrar assim mesmo.`)) {
        enviando.value = false;
        return coletar({ substituir, confirmarDigito: true });
      }
    } else erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}
// Portaria lendo etiqueta nova ou de container que ainda não saiu do ponto de carregamento.
const modoPortaria = computed(
  () => info.value?.modoPortaria && info.value.podeRegistrar &&
    (estado.value === "LIVRE" || (estado.value === "VINCULADA" && FLUXO.indexOf(container.value?.status) < FLUXO.indexOf("SAIU_FABRICA")))
);
// Sugere o movimento pela etapa atual (antes da chegada → entrada; depois → saída).
watch(
  () => [modoPortaria.value, container.value?.status],
  () => {
    if (!modoPortaria.value || !container.value) return;
    movimento.value = FLUXO.indexOf(container.value.status) < FLUXO.indexOf("NA_FABRICA") ? "ENTRADA" : "SAIDA";
  },
  { immediate: true }
);

function escolherMovimento(m) {
  movimento.value = m;
  erro.value = null;
}

// Portaria: container de tipo sem local de operação (ex.: Coleta de cheio) não tem entrada/saída.
const semOperacaoPortaria = computed(() => container.value?.temOperacao === false || (estado.value === "LIVRE" && programacao.value?.temOperacao === false));
const tipoSemOperacao = computed(() => container.value?.tipoOperacao ?? programacao.value?.tipoOperacao ?? "");

// Portaria: placa obrigatória; diferente da vinculada ao container → motivo obrigatório.
const normalizarPlaca = (p) => String(p ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const placaVinculada = computed(() => container.value?.placa ?? programacao.value?.placa ?? null);
const trocaDePlaca = computed(() => Boolean(placaVinculada.value) && Boolean(normalizarPlaca(f.placa)) && normalizarPlaca(f.placa) !== placaVinculada.value);
watch(() => [modoPortaria.value, container.value?.placa], () => {
  if (modoPortaria.value && !f.placa && container.value?.placa) f.placa = container.value.placa;
}, { immediate: true });

async function registrarPortaria(substituir = false) {
  erro.value = null;
  confirmarSubstituicao.value = null;
  if (!movimento.value) {
    erro.value = "Escolha se é ENTRADA ou SAÍDA.";
    return;
  }
  if (estado.value === "LIVRE" && conferencia.value && !conferencia.value.formatoValido) {
    erro.value = "Número do container inválido: são 4 letras + 7 números (ex.: MSCU1234566).";
    return;
  }
  enviando.value = true;
  try {
    const dados = {
      numero: f.numero,
      movimento: movimento.value,
      placa: f.placa,
      motivoTrocaPlaca: trocaDePlaca.value ? f.motivoPlaca : undefined,
      ocorridoEm: horarioDaLeitura(),
      temperatura: f.temperatura === "" ? undefined : String(f.temperatura).replace(",", "."),
      substituir,
      ...(await obterLocalizacao()),
    };
    const r = await q.qrPortaria(props.token, dados);
    info.value = r;
    sucesso.value = {
      movimento: r.movimento, etapa: r.etapa, completadas: r.completadas,
      temperatura: dados.temperatura, resultado: r.resultado, numero: r.container?.numero,
    };
    f.temperatura = "";
    f.numero = "";
    f.motivoPlaca = "";
  } catch (e) {
    if (tratarErroMotorista(e)) return;
    if (e.codigo === "ETIQUETA_EXISTENTE") confirmarSubstituicao.value = e.dados.etiquetaAnterior;
    else erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}
const enviar = (substituir) =>
  modoPortaria.value ? registrarPortaria(substituir) : modoColeta.value ? coletar({ substituir }) : salvar(substituir);

function novaLeitura() {
  sucesso.value = null;
  agora();
}

// Passagem por ponto de parada (ex.: Ponto Fiscal) lida no próprio ponto: horário de agora + GPS.
const proximaParada = computed(() => (info.value?.podeRegistrar ? container.value?.proximaParada ?? null : null));
async function registrarPassagemQr() {
  erro.value = null;
  enviando.value = true;
  try {
    const r = await q.qrPassagem(props.token, { paradaId: proximaParada.value.id, ...(await obterLocalizacao()) });
    info.value = r;
    sucesso.value = { passagem: r.passagem, numero: r.container?.numero };
  } catch (e) {
    if (tratarErroMotorista(e)) return;
    erro.value = e.message;
  } finally {
    enviando.value = false;
  }
}
</script>

<template>
  <div class="movel">
    <header class="movel-topo">
      <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="8" width="28" height="16" rx="2" fill="#4a8fdc" /><path d="M8 11v10M13 11v10M18 11v10M23 11v10" stroke="#fff" stroke-width="2" /></svg>
      <span class="espaco">Controle de Container</span>
      <span class="pequeno">{{ nomeQuem }}</span>
      <button v-if="motorista" type="button" class="pequeno sair" @click="emit('sair')">Sair</button>
      <button v-else-if="info?.modoTransportador" type="button" class="pequeno sair" @click="auth.logout()">Sair</button>
      <router-link v-if="info?.modoPortaria" to="/" class="btn pequeno sair">Home</router-link>
    </header>

    <main class="movel-corpo">
      <div v-if="erroFatal" class="erro grande">{{ erroFatal }}</div>
      <div v-else-if="!info" class="vazio">Carregando…</div>

      <!-- Sucesso da portaria -->
      <section v-else-if="sucesso?.movimento" class="cartao resultado" :class="sucesso.resultado && sucesso.resultado !== 'OK' ? 'ruim' : 'bom'">
        <div class="icone" aria-hidden="true">{{ sucesso.resultado && sucesso.resultado !== "OK" ? "⚠" : "✓" }}</div>
        <h1>{{ sucesso.movimento === "ENTRADA" ? "Entrada registrada" : "Saída registrada" }}</h1>
        <div class="mono numero">{{ sucesso.numero }}</div>
        <p class="mudo" style="margin: 0">{{ sucesso.etapa }}</p>
        <p v-if="sucesso.completadas.length" class="aviso" style="margin: 0">
          Etapas que não estavam registradas foram completadas com o mesmo horário: {{ sucesso.completadas.join(", ") }}.
        </p>
        <div v-if="sucesso.temperatura !== undefined" class="temp">{{ fmtTemp(sucesso.temperatura) }}</div>
        <p v-if="sucesso.resultado === 'ACIMA'" class="aviso-forte">Temperatura ACIMA da faixa ({{ fmtTemp(container.tempMin) }} a {{ fmtTemp(container.tempMax) }}). O alerta já apareceu no sistema — avise o responsável.</p>
        <p v-else-if="sucesso.resultado === 'ABAIXO'" class="aviso-forte">Temperatura ABAIXO da faixa ({{ fmtTemp(container.tempMin) }} a {{ fmtTemp(container.tempMax) }}). O alerta já apareceu no sistema — avise o responsável.</p>
      </section>

      <!-- Sucesso da coleta (transportador) -->
      <section v-else-if="sucesso?.coleta" class="cartao resultado" :class="sucesso.resultado && sucesso.resultado !== 'OK' ? 'ruim' : 'bom'">
        <div class="icone" aria-hidden="true">{{ sucesso.resultado && sucesso.resultado !== "OK" ? "⚠" : "✓" }}</div>
        <h1>{{ sucesso.coleta === "REGISTRADA" ? "Coleta registrada" : "Etiqueta ligada ao container" }}</h1>
        <div class="mono numero">{{ sucesso.numero }}</div>
        <p v-if="sucesso.coleta === 'REGISTRADA'" class="mudo" style="margin: 0">
          {{ rotuloEtapa(container, "COLETADO") }} · {{ sucesso.retirada }}{{ sucesso.cadastrado ? " · container cadastrado agora" : "" }}
        </p>
        <p v-else class="mudo" style="margin: 0">A coleta deste container já estava registrada ({{ fmtDataHora(container?.coletadoEm) }}).</p>
        <div v-if="sucesso.temperatura !== undefined" class="temp">{{ fmtTemp(sucesso.temperatura) }}</div>
        <p v-if="sucesso.resultado === 'ACIMA'" class="aviso-forte">Temperatura ACIMA da faixa ({{ fmtTemp(container.tempMin) }} a {{ fmtTemp(container.tempMax) }}). O alerta já apareceu no sistema — avise o responsável.</p>
        <p v-else-if="sucesso.resultado === 'ABAIXO'" class="aviso-forte">Temperatura ABAIXO da faixa ({{ fmtTemp(container.tempMin) }} a {{ fmtTemp(container.tempMax) }}). O alerta já apareceu no sistema — avise o responsável.</p>
      </section>

      <!-- Sucesso da passagem por ponto de parada -->
      <section v-else-if="sucesso?.passagem" class="cartao resultado bom">
        <div class="icone" aria-hidden="true">✓</div>
        <h1>Passagem registrada</h1>
        <div class="mono numero">{{ sucesso.numero }}</div>
        <p class="mudo" style="margin: 0">{{ sucesso.passagem }}</p>
        <button class="bloco" @click="novaLeitura">Voltar</button>
      </section>

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

        <!-- Motorista: placa do caminhão (vai para o container em cada registro) -->
        <section v-if="motorista" class="cartao placa-motorista">
          <template v-if="!trocandoPlaca">
            <div class="linha-entre" style="gap: 10px">
              <div>
                <div class="mudo pequeno">Placa do caminhão</div>
                <div class="mono negrito" style="font-size: 18px">{{ motorista.placa ?? "não informada" }}</div>
              </div>
              <button type="button" class="pequeno" @click="abrirPlaca">{{ motorista.placa ? "Trocar" : "Informar" }}</button>
            </div>
            <p class="mudo pequeno" style="margin: 6px 0 0">Mudou de caminhão? Troque a placa antes de registrar.</p>
          </template>
          <form v-else class="linha" style="gap: 8px; align-items: flex-end; flex-wrap: wrap" @submit.prevent="salvarPlaca">
            <div class="campo" style="flex: 1; min-width: 140px; margin: 0">
              <label for="placa-nova">Placa do caminhão</label>
              <input id="placa-nova" v-model="novaPlaca" class="mono grande-campo" maxlength="8" placeholder="ABC1D23" autocapitalize="characters" style="text-transform: uppercase" required />
            </div>
            <button type="submit" class="primario">Salvar</button>
            <button type="button" @click="trocandoPlaca = false">Cancelar</button>
            <div v-if="erroPlaca" class="erro" style="width: 100%">{{ erroPlaca }}</div>
          </form>
          <div class="celular-motorista">
            <template v-if="!etapaCel">
              <div class="linha-entre" style="gap: 10px">
                <div>
                  <div class="mudo pequeno">Celular do acesso</div>
                  <div class="mono">final {{ String(motorista.celular ?? "").slice(-4) }}</div>
                </div>
                <button type="button" class="pequeno" @click="abrirCelular">Trocar celular</button>
              </div>
              <div v-if="avisoCel" class="sucesso pequeno" style="margin-top: 6px">{{ avisoCel }}</div>
            </template>
            <form v-else-if="etapaCel === 'numero'" class="linha" style="gap: 8px; align-items: flex-end; flex-wrap: wrap" @submit.prevent="pedirCodigoCelular">
              <div class="campo" style="flex: 1; min-width: 160px; margin: 0">
                <label for="cel-novo">Celular novo (com DDD)</label>
                <input id="cel-novo" v-model="novoCel" class="grande-campo" inputmode="tel" autocomplete="tel" placeholder="(11) 98765-4321" required />
              </div>
              <button type="submit" class="primario">Enviar código</button>
              <button type="button" @click="etapaCel = null">Cancelar</button>
              <div v-if="erroCel" class="erro" style="width: 100%">{{ erroCel }}</div>
            </form>
            <form v-else class="linha" style="gap: 8px; align-items: flex-end; flex-wrap: wrap" @submit.prevent="confirmarCelular">
              <div class="campo" style="flex: 1; min-width: 140px; margin: 0">
                <label for="cel-codigo">Código recebido no celular novo</label>
                <input id="cel-codigo" v-model="codigoCel" class="mono grande-campo" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required />
              </div>
              <button type="submit" class="primario">Confirmar</button>
              <button type="button" @click="etapaCel = null">Cancelar</button>
              <div v-if="erroCel" class="erro" style="width: 100%">{{ erroCel }}</div>
            </form>
          </div>
        </section>

        <!-- Container no trecho de um ponto de parada ainda não registrado -->
        <section v-if="proximaParada" class="cartao passagem">
          <div class="mudo pequeno">Ponto de parada no trajeto</div>
          <div class="negrito" style="font-size: 18px">{{ proximaParada.nome }}</div>
          <p class="mudo pequeno" style="margin: 4px 0 10px">Está passando por este ponto agora? Registre a passagem (horário de agora{{ enviarLocalizacao ? " + sua localização" : "" }}).</p>
          <div v-if="erro" class="erro">{{ erro }}</div>
          <button type="button" class="primario bloco" :disabled="enviando" @click="registrarPassagemQr">{{ enviando ? "Registrando…" : "Registrar passagem" }}</button>
        </section>

        <!-- Container já ligado -->
        <section v-if="container" class="cartao">
          <div class="mono numero">{{ container.numero }}</div>
          <div class="mudo">{{ ROTULO_TIPO[container.tipo] }} · {{ container.cliente }} / {{ container.fabrica }}</div>
          <div class="linha" style="margin-top: 8px; gap: 6px">
            <span class="chip azul">{{ rotuloEtapa(container, container.status) }}</span>
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

        <!-- Portaria: entrada / saída -->
        <form v-else-if="modoPortaria" class="cartao formulario" @submit.prevent="registrarPortaria()">
          <h1>Portaria: entrada ou saída</h1>
          <div v-if="erro" class="erro">{{ erro }}</div>
          <div v-if="semOperacaoPortaria" class="aviso" role="alert">
            Este container é do tipo de operação <strong>{{ tipoSemOperacao }}</strong>, que não passa por entrada/saída em local de operação.
            Não há registro de portaria para ele — avise a operação se estiver no lugar errado.
          </div>
          <div v-if="confirmarSubstituicao" class="aviso">
            Este container já tem a etiqueta <strong class="mono">{{ confirmarSubstituicao }}</strong>. Substituir por
            <strong class="mono">{{ info.etiqueta.codigo }}</strong>? A antiga será cancelada.
            <div class="linha" style="margin-top: 10px">
              <button type="button" @click="confirmarSubstituicao = null">Não</button>
              <button type="button" class="primario" :disabled="enviando" @click="enviar(true)">Sim, substituir</button>
            </div>
          </div>

          <div v-if="estado === 'LIVRE'" class="campo">
            <label for="numero">Número do container</label>
            <input
              id="numero" v-model="f.numero" class="mono grande-campo" required maxlength="15" placeholder="MSCU1234566"
              autocapitalize="characters" autocomplete="off" spellcheck="false"
            />
            <span v-if="conferencia && !conferencia.formatoValido" class="dica txt-VENCIDO">Formato: 4 letras + 7 números.</span>
            <span v-else-if="conferencia" class="dica txt-OK">✓ {{ conferencia.numero }}</span>
          </div>

          <div class="campo">
            <label>Movimento</label>
            <div class="movimentos" role="radiogroup" aria-label="Entrada ou saída">
              <button type="button" role="radio" :aria-checked="movimento === 'ENTRADA'" :class="{ escolhido: movimento === 'ENTRADA' }" @click="escolherMovimento('ENTRADA')">⬇ Entrada</button>
              <button type="button" role="radio" :aria-checked="movimento === 'SAIDA'" :class="{ escolhido: movimento === 'SAIDA' }" @click="escolherMovimento('SAIDA')">⬆ Saída</button>
            </div>
            <span v-if="container && movimento" class="dica">
              Vai registrar: <strong>{{ rotuloEtapa(container, movimento === "ENTRADA" ? "NA_FABRICA" : "SAIU_FABRICA") }}</strong>
            </span>
          </div>

          <div class="campo">
            <label for="placa-portaria">Placa do veículo *</label>
            <input
              id="placa-portaria" v-model="f.placa" class="mono grande-campo" required maxlength="8" placeholder="ABC1D23"
              autocapitalize="characters" autocomplete="off" style="text-transform: uppercase"
            />
            <span v-if="placaVinculada" class="dica">Placa vinculada ao container: <strong class="mono">{{ placaVinculada }}</strong></span>
          </div>
          <div v-if="trocaDePlaca" class="campo">
            <label for="motivo-placa">Motivo da troca de placa *</label>
            <textarea id="motivo-placa" v-model="f.motivoPlaca" rows="2" required maxlength="200" placeholder="Ex.: troca de cavalo mecânico, veículo quebrado…"></textarea>
            <span class="dica txt-ATENCAO">A placa informada é diferente da vinculada ({{ placaVinculada }}). O motivo fica registrado.</span>
          </div>

          <div v-if="container?.reefer || (estado === 'LIVRE' && !livreSemTemperatura)" class="campo">
            <label for="temp">Temperatura (°C){{ container?.reefer || livreComTemperatura ? "" : " — obrigatória se for reefer" }}</label>
            <div class="campo-com-botao botao-antes">
              <button type="button" class="sinal" :aria-label="negativa ? 'Tornar positiva' : 'Tornar negativa'" @click="inverterSinal">±</button>
              <input id="temp" v-model="f.temperatura" class="grande-campo" inputmode="decimal" placeholder="-18,0" autocomplete="off" :required="Boolean(container?.reefer) || livreComTemperatura" />
            </div>
            <span class="dica">Temperatura negativa: toque em <strong>±</strong>.</span>
          </div>

          <div class="campo">
            <label for="quando">Data e hora</label>
            <div class="campo-com-botao">
              <input id="quando" v-model="f.lidaEm" type="datetime-local" class="grande-campo horario" required @input="horarioEditado = true" />
              <button type="button" @click="agora">Agora</button>
            </div>
            <span class="dica">Já vem com o horário atual. Ajuste só se o caminhão passou antes.</span>
          </div>

          <label v-if="podeLocalizar" class="check-local pequeno"><input v-model="enviarLocalizacao" type="checkbox" /> Registrar minha localização (prova de que a leitura foi no local)</label>

          <button type="submit" class="primario bloco" :disabled="enviando || semOperacaoPortaria">
            {{ enviando ? "Salvando…" : movimento === "SAIDA" ? "Registrar saída" : movimento === "ENTRADA" ? "Registrar entrada" : "Registrar" }}
          </button>
        </form>

        <!-- Transportador: registrar a coleta -->
        <form v-else-if="modoColeta" class="cartao formulario" @submit.prevent="coletar()">
          <h1>Registrar coleta</h1>
          <div v-if="erro" :class="precisaCadastro ? 'aviso' : 'erro'">{{ erro }}</div>
          <div v-if="confirmarSubstituicao" class="aviso">
            Este container já tem a etiqueta <strong class="mono">{{ confirmarSubstituicao }}</strong>. Substituir por
            <strong class="mono">{{ info.etiqueta.codigo }}</strong>? A antiga será cancelada.
            <div class="linha" style="margin-top: 10px">
              <button type="button" @click="confirmarSubstituicao = null">Não</button>
              <button type="button" class="primario" :disabled="enviando" @click="enviar(true)">Sim, substituir</button>
            </div>
          </div>

          <div v-if="estado === 'LIVRE'" class="campo">
            <label for="numero">Número do container</label>
            <input
              id="numero" v-model="f.numero" class="mono grande-campo" required maxlength="15" placeholder="MSCU1234566"
              autocapitalize="characters" autocomplete="off" spellcheck="false" @input="precisaCadastro = false"
            />
            <span v-if="conferencia && !conferencia.formatoValido" class="dica txt-VENCIDO">Formato: 4 letras + 7 números.</span>
            <span v-else-if="conferencia && !conferencia.digitoValido" class="dica txt-ATENCAO">O último dígito não confere com o padrão — confira na porta do container.</span>
            <span v-else-if="conferencia" class="dica txt-OK">✓ {{ conferencia.numero }}</span>
          </div>

          <div v-if="container?.tipoOperacao || programacao?.tipoOperacao" class="dica pequeno">
            Tipo de operação: <strong>{{ container?.tipoOperacao ?? programacao?.tipoOperacao }}</strong>
          </div>
          <div class="campo">
            <label for="tipo-retirada">Onde o container foi retirado?</label>
            <select id="tipo-retirada" v-model="col.tipoId" class="grande-campo" required>
              <option value="" disabled>Selecione o tipo de local</option>
              <option v-for="t in tiposRetirada" :key="t.id" :value="t.id">{{ t.nome }}</option>
            </select>
          </div>
          <div v-if="col.tipoId" class="campo">
            <label for="local-retirada">Local de retirada</label>
            <select id="local-retirada" v-model="col.localId" class="grande-campo" required>
              <option value="" disabled>Selecione o local</option>
              <option v-for="l in locaisDoTipo" :key="l.id" :value="l.id">{{ l.nome }}{{ l.uf ? ` (${l.uf})` : "" }}</option>
            </select>
            <span v-if="!locaisDoTipo.length" class="dica txt-ATENCAO">Nenhum local deste tipo cadastrado. Avise a operação.</span>
          </div>
          <div v-if="temCarregamento" class="campo">
            <label for="local-carregamento">Local de carregamento</label>
            <select id="local-carregamento" v-model="col.carregamentoId" class="grande-campo">
              <option value="">— {{ precisaCadastro ? "o do Ponto de Carregamento" : "não informado" }} —</option>
              <option v-for="l in locaisCarregamento" :key="l.id" :value="l.id">{{ l.nome }}{{ l.uf ? ` (${l.uf})` : "" }}</option>
            </select>
          </div>
          <div class="campo">
            <label for="local-entrega">Local de entrega</label>
            <select id="local-entrega" v-model="col.entregaId" class="grande-campo">
              <option value="">— não informado —</option>
              <option v-for="l in locaisEntrega" :key="l.id" :value="l.id">{{ l.nome }}{{ l.uf ? ` (${l.uf})` : "" }}</option>
            </select>
          </div>
          <div v-if="trajetoPreenchido" class="aviso pequeno trajeto-aviso">
            ✓ Retirada, carregamento e entrega vieram da programação do container. Confira e altere só o que estiver diferente.
          </div>

          <!-- Container ainda não cadastrado: dados mínimos -->
          <fieldset v-if="precisaCadastro" class="cadastro">
            <legend>Cadastrar o container</legend>
            <div v-if="(opcoes?.tiposOperacao ?? []).length > 1" class="campo">
              <label for="tipo-operacao">Tipo de operação</label>
              <select id="tipo-operacao" v-model="col.tipoOperacaoId" class="grande-campo" required>
                <option v-for="x in opcoes.tiposOperacao" :key="x.id" :value="x.id">{{ x.nome }}</option>
              </select>
              <span class="dica">Define os locais aceitos na retirada, no carregamento e na entrega.</span>
            </div>
            <div class="campo">
              <label for="tipo-container">Tipo do container</label>
              <select id="tipo-container" v-model="col.tipoContainer" class="grande-campo" required>
                <option value="" disabled>Selecione</option>
                <option v-for="t in opcoes?.tiposContainer ?? []" :key="t" :value="t">{{ ROTULO_TIPO[t] }}</option>
              </select>
            </div>
            <div class="campo">
              <label for="ponto">Ponto de Carregamento</label>
              <select id="ponto" v-model="col.grupoId" class="grande-campo" required>
                <option value="" disabled>Selecione</option>
                <option v-for="g in opcoes?.grupos ?? []" :key="g.id" :value="g.id">{{ g.cliente }} / {{ g.fabrica }}</option>
              </select>
            </div>
            <div class="campo">
              <label for="armador">Armador</label>
              <select id="armador" v-model="col.armadorId" class="grande-campo" required>
                <option value="" disabled>Selecione</option>
                <option v-for="a in opcoes?.armadores ?? []" :key="a.id" :value="a.id">{{ a.nome }}</option>
              </select>
            </div>
            <div v-if="novoReefer" class="campo">
              <label for="produto">Produto</label>
              <select id="produto" v-model="col.produtoId" class="grande-campo" required>
                <option value="" disabled>Selecione</option>
                <option v-for="p in opcoes?.produtos ?? []" :key="p.id" :value="p.id">{{ p.nome }}</option>
              </select>
            </div>
          </fieldset>

          <div v-if="pedeTemperaturaColeta" class="campo">
            <label for="temp">Temperatura (°C){{ temperaturaObrigatoria ? "" : " — obrigatória se for reefer" }}</label>
            <div class="campo-com-botao botao-antes">
              <button type="button" class="sinal" :aria-label="negativa ? 'Tornar positiva' : 'Tornar negativa'" @click="inverterSinal">±</button>
              <input id="temp" v-model="f.temperatura" class="grande-campo" inputmode="decimal" placeholder="-18,0" autocomplete="off" :required="temperaturaObrigatoria" />
            </div>
            <span class="dica">Temperatura negativa: toque em <strong>±</strong>.</span>
          </div>

          <div class="campo">
            <label for="quando">Data e hora da coleta</label>
            <div class="campo-com-botao">
              <input id="quando" v-model="f.lidaEm" type="datetime-local" class="grande-campo horario" required @input="horarioEditado = true" />
              <button type="button" @click="agora">Agora</button>
            </div>
            <span class="dica">Já vem com o horário atual. Ajuste só se a retirada foi antes.</span>
          </div>

          <label v-if="podeLocalizar" class="check-local pequeno"><input v-model="enviarLocalizacao" type="checkbox" /> Registrar minha localização (prova de que a leitura foi no local)</label>

          <button type="submit" class="primario bloco" :disabled="enviando">{{ enviando ? "Salvando…" : precisaCadastro ? "Cadastrar e registrar coleta" : "Registrar coleta" }}</button>
        </form>

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
              <button type="button" class="primario" :disabled="enviando" @click="enviar(true)">Sim, substituir</button>
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

          <div v-if="!livreSemTemperatura" class="campo">
            <label for="temp">Temperatura (°C){{ estado === "LIVRE" && !livreComTemperatura ? " — obrigatória se for reefer" : "" }}</label>
            <div class="campo-com-botao botao-antes">
              <button type="button" class="sinal" :aria-label="negativa ? 'Tornar positiva' : 'Tornar negativa'" @click="inverterSinal">±</button>
              <input
                id="temp" v-model="f.temperatura" class="grande-campo" inputmode="decimal" placeholder="-18,0" autocomplete="off"
                :required="(temperaturaExigida && estado !== 'LIVRE') || livreComTemperatura"
              />
            </div>
            <span class="dica">Temperatura negativa: toque em <strong>±</strong> (o teclado numérico do celular nem sempre tem o "-").</span>
          </div>

          <div class="campo">
            <label for="quando">Data e hora da leitura</label>
            <div class="campo-com-botao">
              <input id="quando" v-model="f.lidaEm" type="datetime-local" class="grande-campo horario" required @input="horarioEditado = true" />
              <button type="button" @click="agora">Agora</button>
            </div>
            <span class="dica">Já vem com o horário atual. Ajuste só se a leitura foi feita antes.</span>
          </div>

          <label v-if="podeLocalizar" class="check-local pequeno"><input v-model="enviarLocalizacao" type="checkbox" /> Registrar minha localização (prova de que a leitura foi no local)</label>

          <button type="submit" class="primario bloco" :disabled="enviando">{{ enviando ? "Salvando…" : "Salvar" }}</button>
        </form>
      </template>
    </main>
  </div>
</template>

<style scoped>
.celular-motorista { border-top: 1px solid var(--borda); margin-top: 10px; padding-top: 10px; }
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
/* Grade (e não flex): o campo de data/hora do celular tem largura mínima própria e empurrava
   o botão "Agora" para fora da tela; minmax(0, 1fr) obriga o campo a caber. */
.campo-com-botao { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: stretch; }
.campo-com-botao.botao-antes { grid-template-columns: auto minmax(0, 1fr); }
.campo-com-botao input { width: 100%; min-width: 0; box-sizing: border-box; }
.campo-com-botao button { white-space: nowrap; }
.horario { font-size: 17px; -webkit-appearance: none; appearance: none; }
.sinal { font-size: 24px; font-weight: 700; min-width: 56px; justify-content: center; }
/* Telas bem estreitas (ex.: iPhone SE): "Agora" desce para a data/hora aparecer inteira. */
@media (max-width: 350px) {
  .campo-com-botao:not(.botao-antes) { grid-template-columns: 1fr; }
  .campo-com-botao:not(.botao-antes) button { justify-content: center; }
}
.check-local { display: flex; align-items: flex-start; gap: 10px; }
.check-local input { flex-shrink: 0; width: 20px; height: 20px; margin: 2px 0 0; }
.formulario .campo label { font-size: 14px; }
.cadastro { border: 1px solid var(--borda); border-radius: 10px; padding: 12px; margin: 0; display: flex; flex-direction: column; gap: 12px; }
.cadastro legend { font-weight: 700; padding: 0 6px; }
.sair { background: transparent; color: #fff; border-color: rgba(255, 255, 255, .5); }
.movimentos { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.movimentos button { justify-content: center; font-size: 18px; padding: 14px; border-radius: 10px; }
.movimentos button.escolhido { background: var(--primaria); border-color: var(--primaria); color: #fff; }
button.bloco { width: 100%; justify-content: center; font-size: 18px; padding: 14px; border-radius: 10px; }
.grande { font-size: 16px; padding: 16px; }
.resultado { align-items: center; text-align: center; }
.resultado .icone { font-size: 56px; line-height: 1; }
.resultado.bom .icone { color: var(--verde); }
.resultado.ruim .icone { color: var(--vermelho); }
.resultado .temp { font-size: 40px; font-weight: 800; }
.aviso-forte { background: var(--vermelho-fundo); color: var(--vermelho); font-weight: 700; padding: 12px; border-radius: 8px; margin: 0; }
.passagem { border: 2px solid var(--primaria); }
</style>
