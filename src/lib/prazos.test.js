import { test } from "node:test";
import assert from "node:assert/strict";
import { calcularEstadia, calcularDemurrage, calcularDeadline, avaliarTemperatura, alertasDesejados, calcularSituacao, semaforo, inicioDoDiaBrasilia } from "./prazos.js";
import { validarNumeroContainer, calcularDigitoVerificador } from "./iso6346.js";

const HORA = 3600 * 1000;
// Horário de Brasília = UTC-3. 2026-09-24T12:00-03:00 = 15:00Z.
const agora = new Date("2026-09-24T15:00:00Z");
const base = {
  tipo: "DRY_40", status: "NA_FABRICA", metaEstadiaHoras: 24, alertaEstadiaHoras: 6, custoEstadiaPorHora: null,
  freeTimeDias: 7, valorDiaria: 100, moeda: "USD", alertaDemurrageDias: 2,
};

// ---------- ISO 6346 ----------

test("ISO 6346: número de exemplo oficial CSQU3054383 é válido", () => {
  assert.equal(calcularDigitoVerificador("CSQU305438"), 3);
  assert.deepEqual(validarNumeroContainer("csqu 305438-3"), { numero: "CSQU3054383", formatoValido: true, digitoValido: true });
});

test("ISO 6346: dígito errado e formato inválido são detectados", () => {
  assert.equal(validarNumeroContainer("CSQU3054384").digitoValido, false);
  assert.equal(validarNumeroContainer("CSQ3054383").formatoValido, false);
  assert.equal(validarNumeroContainer("").formatoValido, false);
});

// ---------- Estadia ----------

test("estadia: sem chegada na fábrica não há estadia", () => {
  assert.equal(calcularEstadia({ ...base, chegadaFabricaEm: null }, agora), null);
});

test("estadia: dentro da meta e longe do limite = OK", () => {
  const e = calcularEstadia({ ...base, chegadaFabricaEm: new Date(agora - 10 * HORA) }, agora);
  assert.equal(e.situacao, "OK");
  assert.equal(e.horasRestantes, 14);
});

test("estadia: faltando menos que a antecedência configurada = ATENCAO", () => {
  const e = calcularEstadia({ ...base, chegadaFabricaEm: new Date(agora - 19 * HORA) }, agora);
  assert.equal(e.situacao, "ATENCAO");
});

test("estadia: meta estourada = VENCIDO, com custo quando há valor por hora", () => {
  const e = calcularEstadia({ ...base, custoEstadiaPorHora: 50, chegadaFabricaEm: new Date(agora - 30 * HORA) }, agora);
  assert.equal(e.situacao, "VENCIDO");
  assert.equal(e.horasExcedidas, 6);
  assert.equal(e.custo, 300);
});

test("estadia: encerrada congela no horário de saída", () => {
  const e = calcularEstadia({ ...base, chegadaFabricaEm: new Date(agora - 50 * HORA), saidaFabricaEm: new Date(agora - 30 * HORA) }, agora);
  assert.equal(e.encerrada, true);
  assert.equal(e.horasDecorridas, 20);
  assert.equal(e.situacao, "OK");
});

// ---------- Demurrage ----------

test("demurrage: corte do dia é meia-noite de Brasília, não UTC", () => {
  // 02:00Z do dia 25 ainda é 23:00 do dia 24 em Brasília.
  assert.equal(inicioDoDiaBrasilia(new Date("2026-09-25T02:00:00Z")).toISOString(), "2026-09-24T03:00:00.000Z");
});

test("demurrage: dia da coleta conta como dia 1 do free time", () => {
  const d = calcularDemurrage({ ...base, coletadoEm: new Date("2026-09-24T10:00:00Z") }, agora);
  assert.equal(d.diasUsados, 1);
  assert.equal(d.diasRestantes, 6);
  assert.equal(d.situacao, "OK");
  // Último instante livre: 30/09 23:59:59.999 em Brasília.
  assert.equal(d.vencimento.toISOString(), "2026-10-01T02:59:59.999Z");
});

test("demurrage: último dia de free time = ATENCAO sem custo", () => {
  const d = calcularDemurrage({ ...base, coletadoEm: new Date("2026-09-18T12:00:00Z") }, agora);
  assert.equal(d.diasUsados, 7);
  assert.equal(d.diasRestantes, 0);
  assert.equal(d.situacao, "ATENCAO");
  assert.equal(d.custo, 0);
  assert.equal(d.custoSeEntregarAmanha, 100);
});

test("demurrage: dias além do free time geram diárias", () => {
  const d = calcularDemurrage({ ...base, coletadoEm: new Date("2026-09-15T12:00:00Z") }, agora);
  assert.equal(d.diasUsados, 10);
  assert.equal(d.diasExcedidos, 3);
  assert.equal(d.custo, 300);
  assert.equal(d.situacao, "VENCIDO");
});

test("demurrage: entregue dentro do prazo encerra sem custo nem alerta", () => {
  const c = { ...base, status: "ENTREGUE_PORTO", coletadoEm: new Date("2026-09-20T12:00:00Z"), entreguePortoEm: new Date("2026-09-23T12:00:00Z") };
  const d = calcularDemurrage(c, agora);
  assert.equal(d.encerrada, true);
  assert.equal(d.custo, 0);
  assert.deepEqual(alertasDesejados(c, calcularSituacao(c, [], agora, 240)), []);
});

// ---------- Deadline ----------

test("deadline: menos de 24h = ATENCAO; passado = VENCIDO", () => {
  assert.equal(calcularDeadline({ deadline: new Date(agora.getTime() + 10 * HORA) }, agora).situacao, "ATENCAO");
  assert.equal(calcularDeadline({ deadline: new Date(agora.getTime() - 1 * HORA) }, agora).situacao, "VENCIDO");
  assert.equal(calcularDeadline({ deadline: new Date(agora.getTime() + 48 * HORA) }, agora).situacao, "OK");
});

// ---------- Temperatura ----------

const reefer = { ...base, tipo: "REEFER_40", status: "EM_OPERACAO", setpoint: -18, tempMin: -22, tempMax: -16, toleranciaMinutos: 30, inicioOperacaoEm: new Date(agora - 2 * HORA) };
const leitura = (t, minutosAtras) => ({ temperatura: t, lidaEm: new Date(agora.getTime() - minutosAtras * 60000), origem: "MANUAL" });

test("temperatura: container dry não é avaliado", () => {
  assert.equal(avaliarTemperatura(base, [], agora, 240), null);
});

test("temperatura: leitura dentro da faixa não gera alerta", () => {
  const t = avaliarTemperatura(reefer, [leitura(-18, 10)], agora, 240);
  assert.equal(t.foraDaFaixa, false);
});

test("temperatura: fora da faixa há menos que a tolerância = ATENCAO", () => {
  const t = avaliarTemperatura(reefer, [leitura(-18, 60), leitura(-15, 10)], agora, 240);
  assert.equal(t.foraDaFaixa, true);
  assert.equal(t.desvio, "ACIMA");
  assert.equal(t.nivelTemperatura, "ATENCAO");
});

test("temperatura: fora da faixa por mais que a tolerância = CRITICO (conta desde a 1ª leitura fora)", () => {
  const t = avaliarTemperatura(reefer, [leitura(-18, 90), leitura(-15, 45), leitura(-14, 5)], agora, 240);
  assert.equal(t.minutosForaDaFaixa, 45);
  assert.equal(t.nivelTemperatura, "CRITICO");
});

test("temperatura: abaixo do mínimo também alerta", () => {
  const t = avaliarTemperatura(reefer, [leitura(-25, 5)], agora, 240);
  assert.equal(t.desvio, "ABAIXO");
});

test("temperatura: voltou para a faixa encerra o alerta", () => {
  const t = avaliarTemperatura(reefer, [leitura(-14, 60), leitura(-18, 5)], agora, 240);
  assert.equal(t.foraDaFaixa, false);
});

test("sem leitura: conta a partir do início da ovação e escala para CRITICO no dobro do intervalo", () => {
  const semNada = avaliarTemperatura({ ...reefer, inicioOperacaoEm: new Date(agora - 5 * HORA) }, [], agora, 240);
  assert.equal(semNada.semLeitura, true);
  assert.equal(semNada.nivelSemLeitura, "ATENCAO");
  const muitoTempo = avaliarTemperatura({ ...reefer, inicioOperacaoEm: new Date(agora - 9 * HORA) }, [], agora, 240);
  assert.equal(muitoTempo.nivelSemLeitura, "CRITICO");
});

test("sem leitura: não é cobrado antes da ovação (container só chegou)", () => {
  const t = avaliarTemperatura({ ...reefer, status: "NA_FABRICA", inicioOperacaoEm: null }, [], agora, 240);
  assert.equal(t.semLeitura, false);
});

// ---------- Alertas / semáforo ----------

test("alertas: container cancelado não tem alerta mesmo com prazo vencido", () => {
  const c = { ...base, status: "CANCELADO", chegadaFabricaEm: new Date(agora - 100 * HORA) };
  assert.deepEqual(alertasDesejados(c, calcularSituacao(c, [], agora, 240)), []);
});

test("alertas e semáforo refletem o pior caso", () => {
  const c = { ...reefer, chegadaFabricaEm: new Date(agora - 30 * HORA), coletadoEm: new Date(agora - 2 * 24 * HORA) };
  const s = calcularSituacao(c, [leitura(-18, 10)], agora, 240);
  const alertas = alertasDesejados(c, s);
  assert.deepEqual(alertas.map((a) => `${a.tipo}:${a.nivel}`), ["ESTADIA:CRITICO"]);
  assert.equal(semaforo(s), "VERMELHO");
});
