import { test } from "node:test";
import assert from "node:assert/strict";
import { avaliarTemperatura, avaliarTemperaturaResumida, resumirLeituras, calcularSituacao, semaforo } from "./prazos.js";
import { situacaoDoResumo, construirResumo, resumoMudou, NIVEL_DO_SEMAFORO } from "./resumoContainer.js";

// Gerador determinístico (os testes não podem depender de sorte).
let semente = 20261010;
const alea = () => ((semente = (semente * 1103515245 + 12345) % 2147483648) / 2147483648);
const entre = (a, b) => a + Math.floor(alea() * (b - a + 1));
const escolhe = (l) => l[entre(0, l.length - 1)];
const MIN = 60e3;
const HORA = 3600e3;
const STATUS = ["PROGRAMADO", "COLETADO", "NA_FABRICA", "EM_OPERACAO", "LIBERADO", "SAIU_FABRICA", "ENTREGUE_PORTO", "CANCELADO"];

function containerAleatorio(agora) {
  const reefer = alea() < 0.7;
  const min = entre(-25, 2);
  const status = escolhe(STATUS);
  const antes = (maxH) => new Date(agora.getTime() - entre(0, maxH * 60) * MIN);
  return {
    tipo: reefer ? "REEFER_40" : "DRY_40", status,
    tempMin: reefer && alea() < 0.95 ? min : null, tempMax: reefer ? min + entre(2, 8) : null, setpoint: min + 1, toleranciaMinutos: escolhe([0, 15, 30, 90, null]),
    metaEstadiaHoras: entre(6, 72), alertaEstadiaHoras: entre(1, 8), custoEstadiaPorHora: escolhe([null, 55.5, 120]),
    freeTimeDias: entre(1, 10), valorDiaria: 100, moeda: "USD", alertaDemurrageDias: entre(0, 3),
    portoEntregaId: alea() < 0.9 ? 1 : null, fluxo: null,
    coletaProgramadaEm: status === "PROGRAMADO" && alea() < 0.6 ? antes(48) : null,
    deadline: alea() < 0.7 ? new Date(agora.getTime() + entre(-30, 200) * HORA) : null,
    coletadoEm: status !== "PROGRAMADO" ? antes(150) : null,
    chegadaFabricaEm: ["NA_FABRICA", "EM_OPERACAO", "LIBERADO", "SAIU_FABRICA", "ENTREGUE_PORTO"].includes(status) ? antes(100) : null,
    inicioOperacaoEm: ["EM_OPERACAO", "LIBERADO", "SAIU_FABRICA", "ENTREGUE_PORTO"].includes(status) ? antes(60) : null,
    saidaFabricaEm: ["SAIU_FABRICA", "ENTREGUE_PORTO"].includes(status) ? antes(30) : null,
    entreguePortoEm: status === "ENTREGUE_PORTO" ? antes(5) : null,
  };
}
function leiturasAleatorias(c, agora) {
  const n = entre(0, 40);
  const faixa = c.tempMin === null ? [-20, 5] : [Number(c.tempMin), Number(c.tempMax)];
  const lista = [];
  let t = agora.getTime() - n * entre(5, 90) * MIN;
  for (let i = 0; i < n; i++) {
    t += entre(1, 90) * MIN;
    const fora = alea() < 0.35;
    const temperatura = fora ? faixa[1] + entre(1, 6) * escolhe([1, -1]) * 1.5 : faixa[0] + alea() * (faixa[1] - faixa[0]);
    lista.push({ temperatura: Math.round(temperatura * 100) / 100, lidaEm: new Date(Math.min(t, agora.getTime())), origem: escolhe(["MANUAL", "QRCODE", "INTEGRACAO"]) });
  }
  return lista;
}

test("resumo: a avaliação de temperatura pelo resumo é IDÊNTICA à feita com as leituras (3.000 casos)", () => {
  const vistos = { fora: 0, semLeitura: 0, semControle: 0, critico: 0 };
  for (let i = 0; i < 3000; i++) {
    const agora = new Date(Date.UTC(2026, 8, 24, 15) + entre(0, 5000) * MIN);
    const c = containerAleatorio(agora);
    const leituras = leiturasAleatorias(c, agora);
    const intervalo = escolhe([0, 60, 120, 240]);
    const direto = avaliarTemperatura(c, leituras, agora, intervalo);
    if (!direto) vistos.semControle++;
    if (direto?.foraDaFaixa) vistos.fora++;
    if (direto?.semLeitura) vistos.semLeitura++;
    if (direto?.nivelTemperatura === "CRITICO") vistos.critico++;
    // Passa pelo JSON como o banco faz (datas viram texto).
    const resumo = JSON.parse(JSON.stringify(resumirLeituras(c, leituras)));
    assert.deepEqual(avaliarTemperaturaResumida(c, resumo, agora, intervalo), direto, `caso ${i}: ${JSON.stringify(c)}`);
  }
  // O teste só vale se os casos difíceis aparecem de verdade.
  assert.ok(vistos.fora > 300 && vistos.semLeitura > 100 && vistos.semControle > 100 && vistos.critico > 100, JSON.stringify(vistos));
});

test("resumo: situação e semáforo pelo resumo = situação calculada com leituras e previsão (3.000 casos)", () => {
  const cfg = { intervaloLeituraMinutos: 240, atrasoColetaCriticoHoras: 4 };
  const cores = { VERMELHO: 0, AMARELO: 0, VERDE: 0 };
  for (let i = 0; i < 3000; i++) {
    const agora = new Date(Date.UTC(2026, 8, 24, 15) + entre(0, 5000) * MIN);
    const c = containerAleatorio(agora);
    const leituras = leiturasAleatorias(c, agora);
    const previsao = alea() < 0.7
      ? { disponivel: true, parcial: alea() < 0.1, hipotetico: alea() < 0.3, previsaoEntrega: new Date(agora.getTime() + entre(1, 300) * HORA), folgaHoras: entre(-60, 60) + 0.5, diasDemurragePrevistos: entre(0, 4), riscoDemurrage: escolhe(["OK", "ATENCAO", "CRITICO"]), riscoDeadline: escolhe([null, "OK", "ATENCAO", "CRITICO"]), trechos: [{ km: 1 }] }
      : escolhe([null, { disponivel: false, faltando: ["x"] }]);
    const { resumo } = construirResumo(c, leituras, previsao, agora, cfg);
    const viaResumo = situacaoDoResumo(c, JSON.parse(JSON.stringify(resumo)), agora, cfg);
    const direto = calcularSituacao(c, leituras, agora, cfg.intervaloLeituraMinutos, previsao, cfg.atrasoColetaCriticoHoras);
    const { previsao: pr, ...restoResumo } = viaResumo;
    const { previsao: pd, ...restoDireto } = direto;
    assert.deepEqual(restoResumo, restoDireto, `caso ${i}`);
    // A previsão do resumo é a mesma sem os campos que só a ficha mostra.
    assert.equal(pr?.disponivel ?? null, pd?.disponivel ?? null);
    assert.equal(semaforo(viaResumo), semaforo(direto), `semáforo do caso ${i}`);
    cores[semaforo(direto)]++;
  }
  assert.ok(cores.VERMELHO > 300 && cores.AMARELO > 100 && cores.VERDE > 100, JSON.stringify(cores));
});

test("resumo: colunas de ordenação e 'mudou?' (sem gravar à toa; chaves reordenadas pelo jsonb não contam)", () => {
  const cfg = { intervaloLeituraMinutos: 240, atrasoColetaCriticoHoras: 4 };
  const agora = new Date("2026-09-24T15:00:00Z");
  const c = { ...containerAleatorio(agora), tipo: "REEFER_40", tempMin: -20, tempMax: -15, status: "NA_FABRICA", chegadaFabricaEm: new Date(agora - 30 * HORA), saidaFabricaEm: null, metaEstadiaHoras: 24 };
  const leituras = [{ temperatura: -18.04, lidaEm: new Date(agora - 2 * HORA), origem: "MANUAL" }, { temperatura: -12.26, lidaEm: new Date(agora - HORA), origem: "QRCODE" }];
  const novo = construirResumo(c, leituras, { disponivel: true, parcial: false, folgaHoras: 12.34, riscoDemurrage: "OK", riscoDeadline: null, trechos: [1, 2, 3] }, agora, cfg);
  assert.equal(novo.semaforoNivel, NIVEL_DO_SEMAFORO.VERMELHO, "estadia estourada e temperatura fora: crítico");
  assert.equal(novo.ultimaTemperatura, -12.3, "1 casa, como a coluna");
  assert.equal(novo.previsaoFolgaHoras, 12.3);
  assert.equal(new Date(novo.estadiaLimiteEm).getTime(), new Date(c.chegadaFabricaEm).getTime() + 24 * HORA);
  assert.equal(novo.demurrageVenceEm === null || novo.demurrageVenceEm instanceof Date, true);
  assert.equal("trechos" in novo.resumo.previsao, false, "a previsão do resumo não leva os trechos");
  // Como o banco devolve: jsonb reordena as chaves e as datas viram texto; decimais voltam como Decimal.
  const gravado = {
    resumo: JSON.parse(JSON.stringify(novo.resumo, (k, v) => v)),
    semaforoNivel: novo.semaforoNivel, estadiaLimiteEm: new Date(novo.estadiaLimiteEm), demurrageVenceEm: novo.demurrageVenceEm,
    ultimaTemperatura: { toString: () => "-12.3", valueOf: () => -12.3 }, previsaoFolgaHoras: 12.3,
  };
  gravado.resumo = Object.fromEntries(Object.entries(gravado.resumo).reverse());
  gravado.resumo.previsao = Object.fromEntries(Object.entries(gravado.resumo.previsao).reverse());
  assert.equal(resumoMudou(gravado, novo), false, "igual: não grava");
  assert.equal(resumoMudou({ ...gravado, resumo: null }, novo), true, "sem resumo: grava");
  assert.equal(resumoMudou(gravado, { ...novo, semaforoNivel: 1 }), true);
  const outraLeitura = construirResumo(c, [...leituras, { temperatura: -18, lidaEm: new Date(agora - 60 * 1000), origem: "MANUAL" }], null, agora, cfg);
  assert.equal(resumoMudou(gravado, outraLeitura), true, "leitura nova muda o resumo");
});
