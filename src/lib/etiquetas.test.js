import { test } from "node:test";
import assert from "node:assert/strict";
import { gerarCodigo, gerarToken, urlDaEtiqueta, zplDaEtiqueta, zplDoLote } from "./etiquetas.js";

test("código curto: formato CC-XXXXXX sem caracteres ambíguos", () => {
  for (let i = 0; i < 200; i++) assert.match(gerarCodigo(), /^CC-[2-9A-HJKMNP-Z]{6}$/);
});

test("token: 22 caracteres url-safe e sem repetição", () => {
  const tokens = new Set(Array.from({ length: 2000 }, gerarToken));
  assert.equal(tokens.size, 2000);
  for (const t of tokens) assert.match(t, /^[A-Za-z0-9_-]{22}$/);
});

test("URL da etiqueta ignora barra final no endereço base", () => {
  assert.equal(urlDaEtiqueta("http://192.168.0.10:5174/", "abc"), "http://192.168.0.10:5174/q/abc");
  assert.equal(urlDaEtiqueta("https://cc.onrender.com", "abc"), "https://cc.onrender.com/q/abc");
});

const etq = { codigo: "CC-7K3F9P", url: "http://192.168.0.10:5174/q/AbCdEfGhIjKlMnOpQrStUv" };

test("ZPL 50×30 mm a 203 dpi: tamanho em pontos, layout horizontal e QR com a URL", () => {
  const r = zplDaEtiqueta(etq, { larguraMm: 50, alturaMm: 30, dpi: 203 });
  assert.equal(r.larguraPontos, 400);
  assert.equal(r.alturaPontos, 240);
  assert.equal(r.horizontal, true);
  assert.match(r.zpl, /^\^XA/);
  assert.match(r.zpl, /\^PW400\n\^LL240/);
  assert.equal(r.nivel, "M");
  assert.match(r.zpl, new RegExp(`\\^BQN,2,${r.ampliacao}\\^FDMA,${etq.url.replace(/[.?]/g, "\\$&")}\\^FS`));
  assert.match(r.zpl, /\^FDCC-7K3F9P\^FS/);
  assert.match(r.zpl, /\^XZ$/);
  // O QR cabe na altura da etiqueta.
  assert.ok(r.ampliacao * r.modulos <= 240 - 2 * 16, "QR cabe na etiqueta");
});

test("ZPL quadrada 100×100 a 300 dpi: layout vertical, QR maior e correção de erro mais alta", () => {
  const pequena = zplDaEtiqueta(etq, { larguraMm: 50, alturaMm: 30, dpi: 203 });
  const grande = zplDaEtiqueta(etq, { larguraMm: 100, alturaMm: 100, dpi: 300 });
  assert.equal(grande.horizontal, false);
  assert.equal(grande.larguraPontos, 1200);
  assert.ok(grande.ampliacao * grande.modulos > pequena.ampliacao * pequena.modulos * 2, "QR físico bem maior");
  assert.equal(grande.nivel, "H", "sobra espaço: sobe para correção H");
  assert.ok(grande.ampliacao <= 10, "limite da Zebra");
  assert.match(grande.zpl, /\^FDHA,/);
  assert.match(grande.zpl, /Escaneie para registrar/);
});

test("lote gera uma etiqueta ZPL por item; texto sem acentos/caracteres de controle ZPL", () => {
  const zpl = zplDoLote([etq, { ...etq, codigo: "CC-2222AA" }], { larguraMm: 60, alturaMm: 40, dpi: 203, titulo: "Operação ^Pátio~" });
  assert.equal(zpl.match(/\^XA/g).length, 2);
  assert.match(zpl, /\^FDOperacao Patio\^FS/);
});
