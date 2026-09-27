// Envio de e-mail transacional. Produção: API HTTP do Brevo (BREVO_API_KEY) — não usa portas
// SMTP, que podem estar bloqueadas no plano gratuito do Render. Sem a chave (desenvolvimento e
// testes), o e-mail NÃO sai: fica numa "caixa de saída" em memória e o link aparece no console.
const API_BREVO = "https://api.brevo.com/v3/smtp/email";
const TIMEOUT_MS = 10_000;

export const remetente = () => ({
  email: process.env.EMAIL_REMETENTE || "aslog.ccs@gmail.com",
  name: process.env.EMAIL_REMETENTE_NOME || "C.C.S – Container Control Solutions",
});

// Últimos e-mails "enviados" sem chave (para testes e para o desenvolvedor ver o link).
export const caixaDeSaida = [];

export const envioConfigurado = () => Boolean(process.env.BREVO_API_KEY);

export async function enviarEmail({ para, nome, assunto, html, texto }) {
  if (!envioConfigurado()) {
    caixaDeSaida.push({ para, assunto, html, texto, em: new Date() });
    if (caixaDeSaida.length > 50) caixaDeSaida.shift();
    if (process.env.NODE_ENV !== "test") console.log(`[e-mail simulado — sem BREVO_API_KEY] para ${para}: ${assunto}\n${texto}`);
    return { simulado: true };
  }
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(API_BREVO, {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: remetente(), to: [{ email: para, name: nome || para }], subject: assunto, htmlContent: html, textContent: texto }),
      signal: controle.signal,
    });
    if (!r.ok) {
      // Não loga a chave nem o corpo do e-mail; só o status e a mensagem do serviço.
      const detalhe = await r.text().catch(() => "");
      throw new Error(`Brevo respondeu ${r.status}: ${detalhe.slice(0, 300)}`);
    }
    return { simulado: false };
  } finally {
    clearTimeout(timer);
  }
}
