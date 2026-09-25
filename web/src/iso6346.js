// Conferência do número do container no celular (mesma regra de src/lib/iso6346.js no servidor):
// 4 letras (a 4ª U, J ou Z) + 6 dígitos + dígito verificador.
const VALOR = {};
(() => {
  let v = 10;
  for (const letra of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    if (v % 11 === 0) v++;
    VALOR[letra] = v++;
  }
})();

export const normalizarNumero = (n) => String(n ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export function conferirNumero(entrada) {
  const numero = normalizarNumero(entrada);
  if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(numero)) return { numero, formatoValido: false, digitoValido: false };
  let soma = 0;
  for (let i = 0; i < 10; i++) soma += (/\d/.test(numero[i]) ? Number(numero[i]) : VALOR[numero[i]]) * 2 ** i;
  return { numero, formatoValido: true, digitoValido: (soma % 11) % 10 === Number(numero[10]) };
}
