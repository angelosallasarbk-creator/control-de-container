import { ref } from "vue";

// Ordenação de tabela feita no SERVIDOR (v3.10), com a mesma interface do useOrdenacao (o ThOrdenavel
// serve aos dois). Clique alterna: crescente → decrescente → sem ordenação (a tela volta à ordem padrão).
// aoMudar: chamado depois de cada clique (a tela busca de novo).
export function useOrdenacaoServidor(aoMudar) {
  const coluna = ref(null);
  const direcao = ref("asc");

  function alternar(chave) {
    if (coluna.value !== chave) {
      coluna.value = chave;
      direcao.value = "asc";
    } else if (direcao.value === "asc") {
      direcao.value = "desc";
    } else {
      coluna.value = null;
      direcao.value = "asc";
    }
    aoMudar();
  }

  const ariaSort = (chave) => (coluna.value !== chave ? "none" : direcao.value === "asc" ? "ascending" : "descending");
  // Parâmetros da API; sem coluna escolhida, os mais recentes primeiro.
  const parametros = () => (coluna.value ? { ordem: coluna.value, dir: direcao.value } : { ordem: "recente", dir: "desc" });

  return { coluna, direcao, alternar, ariaSort, parametros };
}
