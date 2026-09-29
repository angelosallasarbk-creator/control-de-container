import { computed, isRef, ref, watch } from "vue";

// Paginação no navegador para listas longas (evita rolagem enorme).
// lista: ref/computed com o array completo (já filtrado/ordenado). chave: nome da tela — o
// tamanho da página escolhido (10, 20 ou 50) fica lembrado neste navegador por tela.
export const TAMANHOS_PAGINA = [10, 20, 50];
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

export function usePaginacao(lista, tela) {
  const fonte = isRef(lista) ? lista : computed(lista);
  const porPagina = ref(lerTamanho(tela));
  const pagina = ref(1);
  const total = computed(() => fonte.value?.length ?? 0);
  const totalPaginas = computed(() => Math.max(1, Math.ceil(total.value / porPagina.value)));
  const itens = computed(() => (fonte.value ?? []).slice((pagina.value - 1) * porPagina.value, pagina.value * porPagina.value));

  // Filtro/lista mudou e a página atual deixou de existir: volta para a última válida.
  watch(totalPaginas, (n) => {
    if (pagina.value > n) pagina.value = n;
  });
  watch(porPagina, (n) => {
    pagina.value = 1;
    try {
      localStorage.setItem(CHAVE(tela), String(n));
    } catch {
      // sem armazenamento: vale só nesta sessão
    }
  });
  const irPara = (n) => (pagina.value = Math.min(Math.max(1, n), totalPaginas.value));
  const primeiro = computed(() => (total.value ? (pagina.value - 1) * porPagina.value + 1 : 0));
  const ultimo = computed(() => Math.min(pagina.value * porPagina.value, total.value));
  return { itens, pagina, porPagina, total, totalPaginas, irPara, primeiro, ultimo };
}
