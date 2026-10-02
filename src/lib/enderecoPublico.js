// Endereço do sistema nos links que a plataforma envia (SMS e e-mail com o remetente "CCS") e na
// URL gravada nos QR codes. Nunca vem do cabeçalho Host da requisição em produção (alguém poderia
// forjá-lo para o link apontar para outro site).
// v3.2 (item 19): em produção é SEMPRE o endereço da plataforma — APP_URL ou, no Render,
// RENDER_EXTERNAL_URL (definida pelo próprio Render). O "Endereço do sistema" das Configurações de
// cada cliente só vale fora de produção (teste na rede local, celular pelo IP do computador).
import { lerConfiguracao } from "./configuracao.js";

const semBarraFinal = (u) => (u ? String(u).replace(/\/+$/, "") : null);
export const emProducao = () => process.env.NODE_ENV === "production";

/** Endereço fixo da plataforma (variável de ambiente), ou null se não houver. */
export function enderecoDaPlataforma() {
  return semBarraFinal(process.env.APP_URL || process.env.RENDER_EXTERNAL_URL);
}

/** Endereço configurado (produção: o da plataforma; fora: o das Configurações ou APP_URL). */
export async function enderecoConfiguradoDoSistema() {
  if (emProducao()) return enderecoDaPlataforma();
  const { urlPublica } = await lerConfiguracao();
  return semBarraFinal(urlPublica) || enderecoDaPlataforma();
}

export async function enderecoPublico(req) {
  const fixo = await enderecoConfiguradoDoSistema();
  if (fixo || emProducao()) return fixo;
  return req.get("origin") || `${req.protocol}://${req.get("host")}`;
}

// Mesmo endereço, para quem não tem requisição (agendador de SMS). Em desenvolvimento, sem
// configuração, usa o próprio servidor local.
export async function enderecoPublicoFixo() {
  const fixo = await enderecoConfiguradoDoSistema();
  if (fixo || emProducao()) return fixo;
  return `http://localhost:${process.env.PORT || 3000}`;
}
