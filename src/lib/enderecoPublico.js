// Endereço do sistema para links enviados por e-mail. Vem de Configurações (urlPublica) ou da
// variável APP_URL — nunca do cabeçalho Host da requisição em produção (alguém poderia forjá-lo
// para o link do e-mail apontar para outro site). Em desenvolvimento, usa a origem da requisição.
import { lerConfiguracao } from "./configuracao.js";

export async function enderecoPublico(req) {
  const { urlPublica } = await lerConfiguracao();
  const fixo = urlPublica || process.env.APP_URL;
  if (fixo) return fixo.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production") return null;
  return req.get("origin") || `${req.protocol}://${req.get("host")}`;
}

// Mesmo endereço, para quem não tem requisição (agendador de SMS). Em desenvolvimento, sem
// configuração, usa o próprio servidor local.
export async function enderecoPublicoFixo() {
  const { urlPublica } = await lerConfiguracao();
  const fixo = urlPublica || process.env.APP_URL;
  if (fixo) return fixo.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production") return null;
  return `http://localhost:${process.env.PORT || 3000}`;
}
