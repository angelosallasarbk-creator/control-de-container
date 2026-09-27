import { reactive, watch } from "vue";

// Filtros da tela de Containers (cabeçalho, valem para Grid e Tabela): regiões e pontos de
// carregamento marcados (lista vazia = todos) e "Sem QR" (só os ainda sem etiqueta QR vinculada).
// Ficam lembrados neste navegador.
// Região "sem" = pontos de carregamento sem região.
const CHAVE = "cc_filtro_containers";
function ler() {
  try {
    const v = JSON.parse(localStorage.getItem(CHAVE) || "{}");
    return { regioes: Array.isArray(v.regioes) ? v.regioes : [], grupos: Array.isArray(v.grupos) ? v.grupos : [], semQr: v.semQr === true };
  } catch {
    return { regioes: [], grupos: [], semQr: false };
  }
}
export const filtroContainers = reactive(ler());
watch(filtroContainers, (f) => {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(f));
  } catch {
    // sem armazenamento: vale só nesta sessão
  }
});

export const chaveRegiao = (regiaoId) => (regiaoId === null || regiaoId === undefined ? "sem" : regiaoId);

// O container passa nos filtros marcados?
export function passaFiltroContainers(c) {
  const { regioes, grupos, semQr } = filtroContainers;
  if (semQr && c.qrVinculado) return false;
  if (regioes.length && !regioes.includes(chaveRegiao(c.grupo?.regiaoId))) return false;
  if (grupos.length && !grupos.includes(c.grupoId)) return false;
  return true;
}
