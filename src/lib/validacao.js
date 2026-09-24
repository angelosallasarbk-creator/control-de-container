import { erroHttp } from "./asyncHandler.js";

// Pequenos validadores de entrada. Todos lançam erro 400 com mensagem legível para o usuário.

export function texto(valor, rotulo, { obrigatorio = false, max = 200 } = {}) {
  const t = valor === null || valor === undefined ? "" : String(valor).trim();
  if (!t) {
    if (obrigatorio) throw erroHttp(400, `${rotulo} é obrigatório.`);
    return null;
  }
  if (t.length > max) throw erroHttp(400, `${rotulo} deve ter no máximo ${max} caracteres.`);
  return t;
}

export function inteiro(valor, rotulo, { obrigatorio = false, min = 0, max = 100000 } = {}) {
  if (valor === null || valor === undefined || valor === "") {
    if (obrigatorio) throw erroHttp(400, `${rotulo} é obrigatório.`);
    return null;
  }
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw erroHttp(400, `${rotulo} deve ser um número inteiro entre ${min} e ${max}.`);
  }
  return n;
}

export function decimal(valor, rotulo, { obrigatorio = false, min = -1e9, max = 1e9 } = {}) {
  if (valor === null || valor === undefined || valor === "") {
    if (obrigatorio) throw erroHttp(400, `${rotulo} é obrigatório.`);
    return null;
  }
  // Aceita vírgula decimal (padrão brasileiro).
  const n = typeof valor === "number" ? valor : Number(String(valor).replace(",", "."));
  if (!Number.isFinite(n) || n < min || n > max) {
    throw erroHttp(400, `${rotulo} deve ser um número entre ${min} e ${max}.`);
  }
  return n;
}

export function dataHora(valor, rotulo, { obrigatorio = false } = {}) {
  if (valor === null || valor === undefined || valor === "") {
    if (obrigatorio) throw erroHttp(400, `${rotulo} é obrigatório.`);
    return null;
  }
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) throw erroHttp(400, `${rotulo} não é uma data/hora válida.`);
  return d;
}

export function id(valor, rotulo = "ID") {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw erroHttp(400, `${rotulo} inválido.`);
  return n;
}

export function umDe(valor, opcoes, rotulo, { obrigatorio = false } = {}) {
  if (valor === null || valor === undefined || valor === "") {
    if (obrigatorio) throw erroHttp(400, `${rotulo} é obrigatório.`);
    return null;
  }
  if (!opcoes.includes(valor)) throw erroHttp(400, `${rotulo} inválido.`);
  return valor;
}
