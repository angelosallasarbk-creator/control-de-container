import { test } from "node:test";
import assert from "node:assert/strict";
import { avancarRodagem, chegadaDoTrecho, horasDeRodagem, estimarCiclo, percentil, haversineKm } from "./estimativa.js";

// 05h–22h (17h de janela), 500 km/dia → ~29,4 km/h de média dentro da janela.
const cfg = { rodagemInicioMin: 300, rodagemFimMin: 1320, kmPorDia: 500, riscoFolgaHoras: 24 };
// Horário de Brasília = UTC-3: "10/10 05:00 BRT" = "10/10 08:00Z".
const brt = (s) => new Date(`${s}-03:00`);

test("500 km consomem exatamente um dia de janela", () => {
  assert.equal(horasDeRodagem(500, cfg), 17);
  assert.deepEqual(chegadaDoTrecho(brt("2026-10-10T05:00:00"), 500, cfg), brt("2026-10-10T22:00:00"));
});

test("2.000 km saindo às 05h chegam no fim do 4º dia (noites paradas)", () => {
  assert.deepEqual(chegadaDoTrecho(brt("2026-10-10T05:00:00"), 2000, cfg), brt("2026-10-13T22:00:00"));
});

test("partida à noite espera abrir a janela; trecho que não cabe continua no dia seguinte", () => {
  assert.deepEqual(avancarRodagem(brt("2026-10-10T23:30:00"), 1, cfg), brt("2026-10-11T06:00:00"));
  assert.deepEqual(avancarRodagem(brt("2026-10-10T02:00:00"), 1, cfg), brt("2026-10-10T06:00:00"));
  // 20h + 5h de rodagem: 2h hoje (até 22h) + 3h amanhã (05h→08h).
  assert.deepEqual(avancarRodagem(brt("2026-10-10T20:00:00"), 5, cfg), brt("2026-10-11T08:00:00"));
});

test("janela configurável: mudar para 06h–18h muda a previsão", () => {
  const outro = { ...cfg, rodagemInicioMin: 360, rodagemFimMin: 1080 };
  assert.deepEqual(chegadaDoTrecho(brt("2026-10-10T06:00:00"), 750, outro), brt("2026-10-11T12:00:00"));
});

test("percentil 80 e distância em linha reta", () => {
  assert.equal(percentil([10, 20, 30, 40, 50], 80), 40);
  assert.equal(percentil([], 80), null);
  const santos = { latitude: -23.9608, longitude: -46.3336 };
  const campinas = { latitude: -22.9056, longitude: -47.0608 };
  const km = haversineKm(santos, campinas);
  assert.ok(km > 130 && km < 145, `linha reta Santos–Campinas ≈ 138 km (deu ${km})`);
});

const base = {
  status: "COLETADO", freeTimeDias: 7, valorDiaria: 120, moeda: "USD", metaEstadiaHoras: 24, deadline: null,
  portoRetiradaId: 1, localCarregamentoId: 2, portoEntregaId: 1,
};
const ctx = (kmIda, kmVolta, extra = {}) => ({
  kmIda, fonteIda: "ORS", kmVolta, fonteVolta: "ORS", filaEntregaHoras: 4, tempoFabricaHoras: 24, fonteTempoFabrica: "META", ...extra,
});

test("rota curta: folga grande, sem risco", () => {
  const agora = brt("2026-10-10T09:00:00");
  const c = { ...base, coletadoEm: brt("2026-10-10T08:00:00") };
  const p = estimarCiclo(c, ctx(180, 180), agora, cfg);
  assert.equal(p.disponivel, true);
  assert.equal(p.riscoDemurrage, "OK");
  assert.equal(p.diasDemurragePrevistos, 0);
  assert.ok(p.folgaHoras > 72);
});

test("rota de 2.000 km com free time de 7 dias: risco crítico e custo previsto", () => {
  const agora = brt("2026-10-10T09:00:00");
  const c = { ...base, coletadoEm: brt("2026-10-10T08:00:00") };
  const p = estimarCiclo(c, ctx(2000, 2000), agora, cfg);
  // ~4 dias de ida + 1 dia na fábrica + ~4 dias de volta > 7 dias.
  assert.equal(p.riscoDemurrage, "CRITICO");
  assert.ok(p.diasDemurragePrevistos >= 2);
  assert.equal(p.custoPrevisto, p.diasDemurragePrevistos * 120);
});

test("caminhão atrasado: evento que já devia ter acontecido é previsto para agora", () => {
  const agora = brt("2026-10-15T12:00:00");
  const c = { ...base, coletadoEm: brt("2026-10-10T08:00:00") }; // 180 km, devia ter chegado no mesmo dia
  const p = estimarCiclo(c, ctx(180, 180), agora, cfg);
  assert.deepEqual(p.previsaoChegadaFabrica, agora);
  assert.ok(p.previsaoEntrega > agora);
});

test("etapas reais substituem a estimativa; já na fábrica usa a chegada real", () => {
  const agora = brt("2026-10-11T10:00:00");
  const chegada = brt("2026-10-11T09:00:00");
  const c = { ...base, status: "NA_FABRICA", coletadoEm: brt("2026-10-10T08:00:00"), chegadaFabricaEm: chegada };
  const p = estimarCiclo(c, ctx(180, 180, { tempoFabricaHoras: 30, fonteTempoFabrica: "HISTORICO" }), agora, cfg);
  assert.deepEqual(p.previsaoChegadaFabrica, chegada);
  assert.deepEqual(p.previsaoSaidaFabrica, new Date(chegada.getTime() + 30 * 3600e3));
  assert.equal(p.trechos[0].real, true);
});

test("programado com deadline: simula coleta agora e diz até quando coletar", () => {
  const agora = brt("2026-10-10T09:00:00");
  const c = { ...base, status: "PROGRAMADO", deadline: brt("2026-10-20T18:00:00") };
  const p = estimarCiclo(c, ctx(500, 500), agora, cfg);
  assert.equal(p.hipotetico, true);
  assert.ok(p.limiteColeta < c.deadline && p.limiteColeta > agora);
  assert.equal(p.riscoDeadline, "OK");
});

test("sem locais ou sem distância: indica o que falta", () => {
  const p = estimarCiclo({ ...base, portoRetiradaId: null }, ctx(100, 100), new Date(), cfg);
  assert.equal(p.disponivel, false);
  assert.deepEqual(p.faltando, ["local de retirada"]);
  const semKm = estimarCiclo(base, ctx(null, 100), new Date(), cfg);
  assert.match(semKm.faltando[0], /distância retirada/);
  assert.equal(estimarCiclo({ ...base, status: "ENTREGUE_PORTO" }, ctx(1, 1), new Date(), cfg), null);
});

test("entrega a definir (v3.7): previsão parcial até a saída do carregamento, sem ETA final nem risco", () => {
  const p = estimarCiclo({ ...base, portoEntregaId: null }, ctx(100, 100), new Date(), cfg);
  assert.equal(p.disponivel, true);
  assert.equal(p.parcial, true);
  assert.ok(p.previsaoChegadaFabrica instanceof Date && p.previsaoSaidaFabrica > p.previsaoChegadaFabrica);
  assert.deepEqual([p.previsaoEntrega, p.cicloHoras, p.folgaHoras, p.riscoDemurrage, p.riscoDeadline], [null, null, null, null, null]);
  assert.ok(p.trechos.at(-1).aDefinir);
  // Sem local de operação não há o que prever sem a entrega.
  const direto = estimarCiclo({ ...base, portoEntregaId: null, localCarregamentoId: null, fluxo: { etapas: ["COLETADO", "ENTREGUE_PORTO"] } }, { kmDireto: 100, filaEntregaHoras: 4 }, new Date(), cfg);
  assert.equal(direto.disponivel, false);
  assert.deepEqual(direto.faltando, ["local de entrega (a definir)"]);
});

test("programado com coleta futura: a simulação parte da data programada", () => {
  const agora = brt("2026-10-10T08:00:00");
  const c = { ...base, coletaProgramadaEm: brt("2026-10-12T06:00:00") };
  const p = estimarCiclo(c, ctx(180, 100), agora, cfg);
  assert.equal(p.hipotetico, true);
  assert.equal(p.trechos[0].inicio.getTime(), brt("2026-10-12T06:00:00").getTime());
  assert.equal(p.coletaSimulada.getTime(), brt("2026-10-12T06:00:00").getTime());
  // Programada já passou: simula a partir de agora.
  const atrasado = estimarCiclo({ ...base, coletaProgramadaEm: brt("2026-10-09T06:00:00") }, ctx(180, 100), agora, cfg);
  assert.equal(atrasado.trechos[0].inicio.getTime(), agora.getTime());
});

// ---------- v3.13: velocidade configurável, modo livre e pausa/descanso ----------
test("janela com velocidade: roda na velocidade e para no km do dia (o que vier primeiro)", () => {
  const v60 = { ...cfg, velocidadeMediaKmH: 60 }; // 500 km a 60 km/h = 8h20 por dia
  assert.equal(horasDeRodagem(120, v60), 2);
  assert.deepEqual(chegadaDoTrecho(brt("2026-10-10T05:00:00"), 1000, v60), brt("2026-10-11T13:20:00"));
  // Mais devagar que a média da janela: a janela é que limita (20 km/h × 17 h = 340 km).
  assert.deepEqual(chegadaDoTrecho(brt("2026-10-10T05:00:00"), 340, { ...cfg, velocidadeMediaKmH: 20 }), brt("2026-10-10T22:00:00"));
  // Velocidade 0 = automática (regra anterior à v3.13).
  assert.deepEqual(chegadaDoTrecho(brt("2026-10-10T05:00:00"), 500, { ...cfg, velocidadeMediaKmH: 0 }), brt("2026-10-10T22:00:00"));
});

test("modo livre: tempo do serviço de rota, sem janela nem teto diário", () => {
  const livre = { ...cfg, modoRodagem: "LIVRE" };
  assert.deepEqual(chegadaDoTrecho(brt("2026-10-10T20:00:00"), 900, livre, 10), brt("2026-10-11T06:00:00"));
  // Sem o tempo do serviço de rota: velocidade configurada, ou 60 km/h.
  assert.equal(horasDeRodagem(120, livre), 2);
  assert.equal(horasDeRodagem(120, { ...livre, velocidadeMediaKmH: 80 }), 1.5);
  // No modo janela o tempo do serviço de rota é ignorado.
  assert.equal(horasDeRodagem(500, cfg, 6), 17);
});

test("pausa/descanso: a cada X h de direção, Y min parado (nos dois modos)", () => {
  const pausa = { pausaAtiva: true, pausaACadaHoras: 5.5, pausaMinutos: 30 };
  const livre = { ...cfg, modoRodagem: "LIVRE", ...pausa };
  assert.deepEqual(chegadaDoTrecho(brt("2026-10-10T20:00:00"), 900, livre, 10), brt("2026-10-11T06:30:00"), "1 pausa em 10 h");
  assert.deepEqual(chegadaDoTrecho(brt("2026-10-10T08:00:00"), 0, livre, 5.5), brt("2026-10-10T13:30:00"), "sem pausa ao chegar");
  assert.deepEqual(chegadaDoTrecho(brt("2026-10-10T08:00:00"), 0, livre, 12), brt("2026-10-10T21:00:00"), "2 pausas em 12 h");
  // Janela 05h–22h (17 h): 5h30 + pausa + 5h30 + pausa + 5h até 22h; falta 1 h no dia seguinte.
  assert.deepEqual(chegadaDoTrecho(brt("2026-10-10T05:00:00"), 500, { ...cfg, ...pausa }), brt("2026-10-11T06:00:00"));
  // Desligada: nada muda.
  assert.deepEqual(chegadaDoTrecho(brt("2026-10-10T05:00:00"), 500, { ...cfg, ...pausa, pausaAtiva: false }), brt("2026-10-10T22:00:00"));
});
