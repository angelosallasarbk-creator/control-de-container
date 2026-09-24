import { test } from "node:test";
import assert from "node:assert/strict";
import { custosDiarios, temposPorEtapa, diaBrasilia } from "./custos.js";
import { calcularDemurrage, calcularEstadia } from "./prazos.js";

const HORA = 3600e3;
const base = {
  metaEstadiaHoras: 24, alertaEstadiaHoras: 6, custoEstadiaPorHora: 100,
  freeTimeDias: 3, valorDiaria: 120, moeda: "USD", alertaDemurrageDias: 1,
};
const somar = (mapa, campo) => [...mapa.values()].reduce((s, d) => s + d[campo], 0);

test("dia de Brasília: 01:00Z ainda é o dia anterior", () => {
  assert.equal(diaBrasilia("2026-09-25T01:00:00Z"), "2026-09-24");
  assert.equal(diaBrasilia("2026-09-25T03:00:00Z"), "2026-09-25");
});

test("demurrage: cada diária cai no seu dia e a soma bate com calcularDemurrage", () => {
  // Coleta 10/09 10:00 (Brasília), entrega 15/09 → 6 dias usados, free time 3 → diárias em 13, 14 e 15/09.
  const c = { ...base, coletadoEm: new Date("2026-09-10T13:00:00Z"), entreguePortoEm: new Date("2026-09-15T20:00:00Z") };
  const dias = custosDiarios(c, new Date("2026-09-30T12:00:00Z"));
  assert.deepEqual([...dias.keys()].sort(), ["2026-09-13", "2026-09-14", "2026-09-15"]);
  assert.equal(somar(dias, "diarias"), 3);
  assert.equal(somar(dias, "demurrageValor"), calcularDemurrage(c, new Date()).custo);
});

test("estadia: horas excedidas são quebradas na meia-noite e a soma bate com calcularEstadia", () => {
  // Chegada 20/09 18:00 BRT, meta 24h → limite 21/09 18:00; saída 22/09 04:00 → 10h excedidas (6h no dia 21, 4h no dia 22).
  const c = { ...base, chegadaFabricaEm: new Date("2026-09-20T21:00:00Z"), saidaFabricaEm: new Date("2026-09-22T07:00:00Z") };
  const dias = custosDiarios(c, new Date("2026-09-30T12:00:00Z"));
  assert.equal(dias.get("2026-09-21").estadiaHoras, 6);
  assert.equal(dias.get("2026-09-22").estadiaHoras, 4);
  assert.equal(somar(dias, "estadiaValor"), calcularEstadia(c, new Date()).custo);
});

test("container ativo acumula até agora; sem custo/h registra horas com valor zero", () => {
  const agora = new Date("2026-09-24T15:00:00Z");
  const c = { ...base, custoEstadiaPorHora: null, chegadaFabricaEm: new Date(agora - 30 * HORA) };
  const dias = custosDiarios(c, agora);
  assert.equal(somar(dias, "estadiaHoras"), 6);
  assert.equal(somar(dias, "estadiaValor"), 0);
});

test("dentro do prazo não gera nenhum dia de custo", () => {
  const agora = new Date("2026-09-24T15:00:00Z");
  const c = { ...base, coletadoEm: new Date(agora - 30 * HORA), chegadaFabricaEm: new Date(agora - 5 * HORA) };
  assert.equal(custosDiarios(c, agora).size, 0);
});

test("tempos por etapa: trecho em andamento conta até agora", () => {
  const agora = new Date("2026-09-24T15:00:00Z");
  const t = temposPorEtapa({ coletadoEm: new Date(agora - 50 * HORA), chegadaFabricaEm: new Date(agora - 20 * HORA) }, agora);
  assert.deepEqual(t, { ateFabrica: 30, naFabrica: 20, atePorto: null });
});
