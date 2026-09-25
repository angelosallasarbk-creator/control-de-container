import { ref } from "vue";

// Ordenação de tabela por coluna, no navegador.
// extratores: { chaveDaColuna: (linha) => valor comparável (número, texto, Date) ou null }.
// Clique alterna: crescente → decrescente → ordem original. Valores vazios ficam sempre no fim.
export function useOrdenacao(extratores) {
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
  }

  const vazio = (v) => v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));
  const normalizar = (v) => (v instanceof Date ? v.getTime() : v);

  function comparar(a, b) {
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b), "pt-BR", { numeric: true, sensitivity: "base" });
  }

  function ordenar(lista) {
    if (!coluna.value || !extratores[coluna.value]) return lista;
    const extrair = extratores[coluna.value];
    const sinal = direcao.value === "asc" ? 1 : -1;
    const comValor = [];
    const semValor = [];
    for (const [i, linha] of lista.entries()) {
      const v = normalizar(extrair(linha));
      (vazio(v) ? semValor : comValor).push({ linha, v, i });
    }
    // Empate mantém a ordem original (índice), para a tabela não "pular" ao clicar.
    comValor.sort((x, y) => comparar(x.v, y.v) * sinal || x.i - y.i);
    return [...comValor, ...semValor].map((x) => x.linha);
  }

  const ariaSort = (chave) => (coluna.value !== chave ? "none" : direcao.value === "asc" ? "ascending" : "descending");

  return { coluna, direcao, alternar, ordenar, ariaSort };
}
