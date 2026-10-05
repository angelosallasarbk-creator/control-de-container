import { computed, ref, watch } from "vue";
import { TAMANHOS_PAGINA } from "./usePaginacao.js";

// Paginação feita no SERVIDOR (v3.10): a tela pede só a página (GET /containers/lista) em vez de baixar
// a lista inteira. Mesma interface do usePaginacao, para o componente Paginacao.vue servir aos dois.
// tela: nome da tela (o tamanho da página escolhido, 10/20/50, fica lembrado, com a mesma chave de antes).
// aoMudar: chamado quando a página ou o tamanho mudam (a tela busca de novo).
const PADRAO = 20;
const CHAVE = (tela) => `cc_pagina_${tela}`;

function lerTamanho(tela) {
  try {
    const v = Number(localStorage.getItem(CHAVE(tela)));
    return TAMANHOS_PAGINA.includes(v) ? v : PADRAO;
  } catch {
    return PADRAO;
  }
}

export function usePaginacaoServidor(tela, aoMudar) {
  const porPagina = ref(lerTamanho(tela));
  const pagina = ref(1);
  const total = ref(0);
  const totalPaginas = computed(() => Math.max(1, Math.ceil(total.value / porPagina.value)));

  watch(porPagina, (n) => {
    pagina.value = 1;
    try {
      localStorage.setItem(CHAVE(tela), String(n));
    } catch {
      // sem armazenamento: vale só nesta sessão
    }
    aoMudar();
  });
  const irPara = (n) => {
    const destino = Math.min(Math.max(1, n), totalPaginas.value);
    if (destino === pagina.value) return;
    pagina.value = destino;
    aoMudar();
  };
  const primeiro = computed(() => (total.value ? (pagina.value - 1) * porPagina.value + 1 : 0));
  const ultimo = computed(() => Math.min(pagina.value * porPagina.value, total.value));
  // Resposta do servidor: o total e a página que ele realmente devolveu (ex.: página além do fim).
  const aplicar = (r) => {
    total.value = r.total;
    pagina.value = r.pagina;
  };
  const voltarAoInicio = () => (pagina.value = 1);
  return { pagina, porPagina, total, totalPaginas, irPara, primeiro, ultimo, aplicar, voltarAoInicio };
}
