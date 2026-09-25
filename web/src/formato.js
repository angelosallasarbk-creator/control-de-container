export const FLUXO = ["PROGRAMADO", "COLETADO", "NA_FABRICA", "EM_OPERACAO", "LIBERADO", "SAIU_FABRICA", "ENTREGUE_PORTO"];

export const ROTULO_STATUS = {
  PROGRAMADO: "Programado",
  COLETADO: "Coletado no porto",
  NA_FABRICA: "Na fábrica",
  EM_OPERACAO: "Em ovação",
  LIBERADO: "Liberado",
  SAIU_FABRICA: "Saiu da fábrica",
  ENTREGUE_PORTO: "Entregue no porto",
  CANCELADO: "Cancelado",
};

// Texto do botão que leva o container para a etapa (chave = etapa de destino).
export const ACAO_ETAPA = {
  COLETADO: "Registrar coleta no porto",
  NA_FABRICA: "Registrar chegada na fábrica",
  EM_OPERACAO: "Iniciar ovação",
  LIBERADO: "Liberar (ovado e lacrado)",
  SAIU_FABRICA: "Registrar saída da fábrica",
  ENTREGUE_PORTO: "Registrar entrega no porto",
};

export const ROTULO_TIPO = {
  DRY_20: "20' Dry",
  DRY_40: "40' Dry",
  HC_40: "40' HC",
  REEFER_20: "20' Reefer",
  REEFER_40: "40' Reefer",
};

export const ROTULO_ALERTA = {
  ESTADIA: "Estadia",
  DEMURRAGE: "Demurrage",
  DEADLINE: "Deadline",
  TEMPERATURA: "Temperatura",
  SEM_LEITURA: "Sem leitura",
  RISCO_DEMURRAGE: "Risco de demurrage",
  RISCO_DEADLINE: "Risco de deadline",
  ATRASO_COLETA: "Atraso na coleta",
};

// Nome da etapa conforme o tipo do local do container (ex.: COLETADO → "Coleta ferroviária"),
// vindo do servidor em c.rotulosEtapa; sem local definido, o nome genérico.
export const rotuloEtapa = (c, status) => c?.rotulosEtapa?.[status] ?? ROTULO_STATUS[status];
// Texto do botão que leva à etapa: "Registrar coleta ferroviária".
export function acaoEtapa(c, status) {
  const r = c?.rotulosEtapa?.[status];
  return r ? `Registrar ${r.charAt(0).toLowerCase()}${r.slice(1)}` : ACAO_ETAPA[status];
}

export const ROTULO_FUNCAO_LOCAL = { RETIRADA_ENTREGA: "Retirada/entrega do container", CARREGAMENTO: "Carregamento (ovação)" };
export const ehRetiradaEntrega = (l) => l?.tipo?.funcao === "RETIRADA_ENTREGA";

// Minutos desde 00:00 ↔ "HH:MM" (janela de rodagem nas Configurações).
export const minutosParaHora = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const horaParaMinutos = (h) => {
  const [hh, mm] = String(h).split(":").map(Number);
  return hh * 60 + (mm || 0);
};

export const fmtKm = (km) => (km === null || km === undefined ? "—" : `${Number(km).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} km`);

// Folga em horas → texto ("2,5 dias" / "10h" / "-6h").
export function fmtFolga(h) {
  if (h === null || h === undefined) return "—";
  const sinal = h < 0 ? "-" : "";
  const abs = Math.abs(h);
  return abs >= 48 ? `${sinal}${(abs / 24).toFixed(1).replace(".", ",")} dias` : `${sinal}${Math.round(abs)}h`;
}

export const ROTULO_PERFIL = {
  ADMIN: "Administrador",
  SUPERVISOR: "Supervisor",
  OPERADOR: "Operador",
  VISUALIZACAO: "Visualização",
  TRANSPORTADOR: "Transportador",
  PORTARIA: "Portaria",
};

const FUSO = "America/Sao_Paulo";

export function fmtDataHora(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-BR", { timeZone: FUSO, day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function fmtData(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("pt-BR", { timeZone: FUSO });
}

export function fmtHoras(h) {
  if (h === null || h === undefined) return "—";
  const abs = Math.abs(h);
  if (abs < 1) return `${Math.round(abs * 60)} min`;
  if (abs >= 48) return `${Math.floor(abs / 24)}d ${Math.round(abs % 24)}h`;
  const horas = Math.floor(abs);
  const min = Math.round((abs - horas) * 60);
  return min ? `${horas}h${String(min).padStart(2, "0")}` : `${horas}h`;
}

export function fmtMoeda(valor, moeda = "BRL") {
  if (valor === null || valor === undefined) return "—";
  try {
    return Number(valor).toLocaleString("pt-BR", { style: "currency", currency: moeda });
  } catch {
    return `${moeda} ${Number(valor).toFixed(2)}`;
  }
}

export function fmtTemp(t) {
  if (t === null || t === undefined) return "—";
  return `${Number(t).toFixed(1).replace(".", ",")} °C`;
}

// <input type="datetime-local"> trabalha no fuso do navegador, sem offset.
export function paraInputLocal(d) {
  const data = d ? new Date(d) : new Date();
  const local = new Date(data.getTime() - data.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

export function deInputLocal(valor) {
  return valor ? new Date(valor).toISOString() : null;
}

export function tempoDesde(d) {
  if (!d) return "—";
  return fmtHoras((Date.now() - new Date(d).getTime()) / 3600000);
}

// Distância total prevista do ciclo: soma dos trechos de estrada (vazio + cheio), com os km já
// arredondados de cada trecho para o total bater com o detalhamento mostrado na tela.
export function kmDoCiclo(previsao) {
  const trechos = (previsao?.trechos ?? []).filter((t) => t.km !== null && t.km !== undefined);
  return {
    trechos,
    total: trechos.reduce((soma, t) => soma + Math.round(Number(t.km)), 0),
    aproximado: trechos.some((t) => t.fonte === "ESTIMADA"),
  };
}
