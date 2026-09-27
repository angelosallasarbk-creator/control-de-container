// Envio de SMS transacional pela API do Brevo (mesma BREVO_API_KEY do e-mail). Sem a chave
// (desenvolvimento e testes), o SMS NÃO sai: fica numa "caixa de saída" em memória e no console.
// Os textos são curtos e sem acento (GSM-7): 1 SMS = até 160 caracteres; com acento seriam 70.
const API_BREVO_SMS = "https://api.brevo.com/v3/transactionalSMS/sms";
const TIMEOUT_MS = 10_000;

// Nome que aparece como remetente (até 11 letras/números; em alguns países a operadora troca por número).
export const remetenteSms = () => (process.env.SMS_REMETENTE || "CCS").replace(/[^A-Za-z0-9]/g, "").slice(0, 11) || "CCS";

export const caixaDeSaidaSms = [];

export const smsConfigurado = () => Boolean(process.env.BREVO_API_KEY);

/**
 * Celular em formato internacional (E.164, ex.: +5511987654321). Aceita o jeito brasileiro de
 * digitar: "(11) 98765-4321" ou "11987654321" viram +55…; com "+" na frente vale qualquer país.
 * Vazio → null. Inválido → lança Error com a mensagem para o usuário.
 */
export function normalizarCelular(valor) {
  const bruto = String(valor ?? "").trim();
  if (!bruto) return null;
  const digitos = bruto.replace(/\D/g, "");
  let e164;
  if (bruto.startsWith("+")) e164 = digitos;
  else if (digitos.length === 10 || digitos.length === 11) e164 = `55${digitos}`;
  else if ((digitos.length === 12 || digitos.length === 13) && digitos.startsWith("55")) e164 = digitos;
  else e164 = null;
  if (!e164 || e164.length < 10 || e164.length > 15) {
    throw new Error("Celular inválido. Informe DDD + número (ex.: (11) 98765-4321) ou o formato internacional (+55…).");
  }
  // Brasil: celular tem 9 dígitos depois do DDD, começando por 9.
  if (e164.startsWith("55") && !/^55[1-9]{2}9\d{8}$/.test(e164)) {
    throw new Error("Celular brasileiro inválido: use DDD + 9 dígitos começando por 9 (ex.: (11) 98765-4321).");
  }
  return `+${e164}`;
}

/** Envia um SMS. Devolve { simulado } ou lança Error com a mensagem do serviço (sem a chave). */
export async function enviarSms({ para, texto }) {
  if (!smsConfigurado()) {
    caixaDeSaidaSms.push({ para, texto, em: new Date() });
    if (caixaDeSaidaSms.length > 50) caixaDeSaidaSms.shift();
    if (process.env.NODE_ENV !== "test") console.log(`[SMS simulado — sem BREVO_API_KEY] para ${para}: ${texto}`);
    return { simulado: true };
  }
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(API_BREVO_SMS, {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
      // O Brevo quer o número com o código do país e sem o "+".
      body: JSON.stringify({ sender: remetenteSms(), recipient: String(para).replace(/^\+/, ""), content: texto, type: "transactional", tag: "rastreamento" }),
      signal: controle.signal,
    });
    if (!r.ok) {
      const detalhe = await r.text().catch(() => "");
      throw new Error(`Brevo respondeu ${r.status}: ${detalhe.slice(0, 300)}`);
    }
    return { simulado: false };
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Brevo não respondeu em ${TIMEOUT_MS / 1000}s.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
