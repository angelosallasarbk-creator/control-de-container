import { ref } from "vue";

// Modelo de visão da tela de Containers: "grid" (lista + detalhe, padrão) ou "tabela".
// Fica lembrado neste navegador; o seletor está no cabeçalho, ao lado do título.
const CHAVE = "cc_visao_containers";
function ler() {
  try {
    return localStorage.getItem(CHAVE) === "tabela" ? "tabela" : "grid";
  } catch {
    return "grid";
  }
}
export const visaoContainers = ref(ler());
export function definirVisaoContainers(valor) {
  visaoContainers.value = valor;
  try {
    localStorage.setItem(CHAVE, valor);
  } catch {
    // sem armazenamento: vale só nesta sessão
  }
}
