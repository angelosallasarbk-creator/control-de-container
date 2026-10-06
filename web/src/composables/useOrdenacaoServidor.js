import { ref } from "vue";

// Ordenação de tabela feita no SERVIDOR (v3.10), com a mesma interface do useOrdenacao (o ThOrdenavel
// serve aos dois). Clique alterna: crescente → decrescente → sem ordenação (a tela volta à ordem padrão).
// aoMudar: chamado depois de cada clique (a tela busca de novo).
// padrao: ordem usada quando nenhuma coluna está escolhida (a da tela de Containers é "recente", mais novos primeiro).
export function useOrdenacaoServidor(aoMudar, padrao = { ordem: "recente", dir: "desc" }) {
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
  // Parâmetros da API; sem coluna escolhida, a ordem padrão da tela.
  const parametros = () => (coluna.value ? { ordem: coluna.value, dir: direcao.value } : { ...padrao });

  return { coluna, direcao, alternar, ariaSort, parametros };
}
