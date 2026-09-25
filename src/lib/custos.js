// Custo estimado lançado DIA A DIA (competência), para tendência e recorte por período:
// - demurrage: cada diária cai no dia de calendário (Brasília) em que é cobrada;
// - estadia: cada hora além da meta cai no dia em que passou, × custo/h do Ponto de Carregamento.
// Mesmas regras de src/lib/prazos.js — a soma dos dias bate com calcularEstadia/calcularDemurrage.
import { inicioDoDiaBrasilia } from "./prazos.js";

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;
const OFFSET_BRASILIA = -3 * HORA;

// Moeda do custo de estadia (cadastro "Custo por hora excedida (R$)").
export const MOEDA_ESTADIA = "BRL";

export function diaBrasilia(data) {
  return new Date(new Date(data).getTime() + OFFSET_BRASILIA).toISOString().slice(0, 10);
}

// "YYYY-MM-DD" (Brasília) → instante da meia-noite local.
export function inicioDoDiaISO(dia) {
  return new Date(Date.parse(`${dia}T00:00:00Z`) - OFFSET_BRASILIA);
}

const arred = (v, casas = 2) => Math.round(v * 10 ** casas) / 10 ** casas;

// Devolve Map dia → { estadiaHoras, estadiaValor, diarias, demurrageValor }.
export function custosDiarios(c, agora) {
  const dias = new Map();
  const no = (dia) => {
    if (!dias.has(dia)) dias.set(dia, { estadiaHoras: 0, estadiaValor: 0, diarias: 0, demurrageValor: 0 });
    return dias.get(dia);
  };

  if (c.chegadaFabricaEm) {
    const limite = new Date(c.chegadaFabricaEm).getTime() + c.metaEstadiaHoras * HORA;
    const fim = (c.saidaFabricaEm ? new Date(c.saidaFabricaEm) : agora).getTime();
    const custoHora = c.custoEstadiaPorHora === null || c.custoEstadiaPorHora === undefined ? 0 : Number(c.custoEstadiaPorHora);
    // Quebra o intervalo excedido nas meias-noites de Brasília.
    for (let t = limite; t < fim; ) {
      const proximaMeiaNoite = inicioDoDiaBrasilia(new Date(t)).getTime() + DIA;
      const ate = Math.min(proximaMeiaNoite, fim);
      const horas = (ate - t) / HORA;
      const d = no(diaBrasilia(t));
      d.estadiaHoras += horas;
      d.estadiaValor += horas * custoHora;
      t = ate;
    }
  }

  if (c.coletadoEm) {
    const diaColeta = inicioDoDiaBrasilia(new Date(c.coletadoEm)).getTime();
    const fim = c.entreguePortoEm ? new Date(c.entreguePortoEm) : agora;
    const diasUsados = Math.floor((inicioDoDiaBrasilia(fim).getTime() - diaColeta) / DIA) + 1;
    // Dia k do processo (1 = dia da coleta); a partir de freeTime+1 cada dia é uma diária.
    for (let k = c.freeTimeDias + 1; k <= diasUsados; k++) {
      const d = no(diaBrasilia(diaColeta + (k - 1) * DIA));
      d.diarias += 1;
      d.demurrageValor += Number(c.valorDiaria);
    }
  }

  for (const d of dias.values()) {
    d.estadiaHoras = arred(d.estadiaHoras, 2);
    d.estadiaValor = arred(d.estadiaValor);
    d.demurrageValor = arred(d.demurrageValor);
  }
  return dias;
}

// Horas gastas em cada trecho (a etapa em andamento conta até agora). null = trecho não iniciado.
export function temposPorEtapa(c, agora) {
  const h = (a, b) => (a ? arred(((b ? new Date(b) : agora) - new Date(a)) / HORA, 1) : null);
  return {
    ateFabrica: c.coletadoEm ? h(c.coletadoEm, c.chegadaFabricaEm) : null,
    naFabrica: c.chegadaFabricaEm ? h(c.chegadaFabricaEm, c.saidaFabricaEm) : null,
    atePorto: c.saidaFabricaEm ? h(c.saidaFabricaEm, c.entreguePortoEm) : null,
  };
}
