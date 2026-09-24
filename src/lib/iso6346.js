// Validação do número de container pelo padrão ISO 6346:
// 3 letras do proprietário + 1 letra de categoria (U, J ou Z) + 6 dígitos de série + 1 dígito verificador.
// Ex.: CSQU3054383.

const VALOR_LETRA = {};
(() => {
  // Letras valem 10..38 pulando múltiplos de 11 (11, 22, 33).
  let valor = 10;
  for (const letra of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    if (valor % 11 === 0) valor++;
    VALOR_LETRA[letra] = valor;
    valor++;
  }
})();

const FORMATO = /^[A-Z]{3}[UJZ]\d{7}$/;

export function normalizarNumero(numero) {
  return String(numero ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function calcularDigitoVerificador(dezPrimeiros) {
  let soma = 0;
  for (let i = 0; i < 10; i++) {
    const c = dezPrimeiros[i];
    const valor = /\d/.test(c) ? Number(c) : VALOR_LETRA[c];
    soma += valor * 2 ** i;
  }
  return (soma % 11) % 10;
}

// Retorna { numero, formatoValido, digitoValido }.
export function validarNumeroContainer(entrada) {
  const numero = normalizarNumero(entrada);
  if (!FORMATO.test(numero)) {
    return { numero, formatoValido: false, digitoValido: false };
  }
  const digitoValido = calcularDigitoVerificador(numero.slice(0, 10)) === Number(numero[10]);
  return { numero, formatoValido: true, digitoValido };
}
