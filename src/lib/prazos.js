// Regras de prazo (estadia, demurrage, deadline) e de temperatura.
// Funções puras: recebem o container (com os prazos já copiados nele) e o "agora", sem acessar banco.

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;
const MINUTO = 60 * 1000;

// Brasília não tem horário de verão desde 2019: UTC-3 fixo. A contagem de demurrage é por dia
// de calendário local, então o corte do dia precisa ser feito nesse fuso e não no do servidor.
const OFFSET_BRASILIA = -3 * HORA;

export const STATUS_ENCERRADOS = ["ENTREGUE_PORTO", "CANCELADO"];
export const STATUS_NA_FABRICA = ["NA_FABRICA", "EM_OPERACAO", "LIBERADO"];
// Leitura fora da faixa alerta em qualquer etapa com o container ativo (da programação à
// entrega): carga fora da temperatura é problema onde quer que o container esteja.
const STATUS_MONITORA_TEMPERATURA = ["PROGRAMADO", "COLETADO", "NA_FABRICA", "EM_OPERACAO", "LIBERADO", "SAIU_FABRICA"];
// Sem leitura só é cobrado depois que a carga começou a entrar (ovação) e enquanto o
// container está na fábrica, onde a leitura manual é possível.
const STATUS_EXIGE_LEITURA = ["EM_OPERACAO", "LIBERADO"];

const num = (v) => (v === null || v === undefined ? null : Number(v));
const arred = (v, casas = 2) => Math.round(v * 10 ** casas) / 10 ** casas;

export function inicioDoDiaBrasilia(data) {
  const local = new Date(data.getTime() + OFFSET_BRASILIA);
  const meiaNoiteLocalEmUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(meiaNoiteLocalEmUtc - OFFSET_BRASILIA);
}

export function ehReefer(tipo) {
  return String(tipo).startsWith("REEFER");
}

// Estadia na fábrica: da chegada até a saída, comparada à meta do grupo (Ponto de Carregamento).
export function calcularEstadia(c, agora) {
  if (!c.chegadaFabricaEm) return null;
  const inicio = new Date(c.chegadaFabricaEm);
  const encerrada = Boolean(c.saidaFabricaEm);
  const fim = encerrada ? new Date(c.saidaFabricaEm) : agora;
  const limite = new Date(inicio.getTime() + c.metaEstadiaHoras * HORA);
  const horasDecorridas = (fim - inicio) / HORA;
  const horasRestantes = (limite - fim) / HORA;
  const horasExcedidas = Math.max(0, -horasRestantes);

  let situacao = "OK";
  if (horasRestantes < 0) situacao = "VENCIDO";
  else if (!encerrada && horasRestantes <= c.alertaEstadiaHoras) situacao = "ATENCAO";

  const custoHora = num(c.custoEstadiaPorHora);
  return {
    inicio,
    fim,
    limite,
    encerrada,
    metaHoras: c.metaEstadiaHoras,
    horasDecorridas: arred(horasDecorridas, 1),
    horasRestantes: arred(horasRestantes, 1),
    horasExcedidas: arred(horasExcedidas, 1),
    percentualConsumido: arred((horasDecorridas / c.metaEstadiaHoras) * 100, 0),
    custo: custoHora ? arred(horasExcedidas * custoHora) : null,
    situacao,
  };
}

// Demurrage: da coleta no porto até a entrega no terminal.
// Contagem por dia de calendário (Brasília): o dia da coleta é o dia 1 do free time; a partir
// do dia (freeTime + 1) cada dia iniciado é uma diária cobrada, inclusive o dia da entrega.
export function calcularDemurrage(c, agora) {
  if (!c.coletadoEm) return null;
  const inicio = new Date(c.coletadoEm);
  const encerrada = Boolean(c.entreguePortoEm);
  const fim = encerrada ? new Date(c.entreguePortoEm) : agora;

  const diaColeta = inicioDoDiaBrasilia(inicio);
  const diasUsados = Math.floor((inicioDoDiaBrasilia(fim) - diaColeta) / DIA) + 1;
  const diasRestantes = c.freeTimeDias - diasUsados; // dias livres que sobram depois do dia de hoje
  const diasExcedidos = Math.max(0, -diasRestantes);
  // Último instante ainda livre: 23:59:59.999 do último dia de free time.
  const vencimento = new Date(diaColeta.getTime() + c.freeTimeDias * DIA - 1);

  let situacao = "OK";
  if (diasExcedidos > 0) situacao = "VENCIDO";
  else if (!encerrada && diasRestantes <= c.alertaDemurrageDias) situacao = "ATENCAO";

  const valorDiaria = num(c.valorDiaria);
  return {
    inicio,
    fim,
    vencimento,
    encerrada,
    freeTimeDias: c.freeTimeDias,
    diasUsados,
    diasRestantes: Math.max(0, diasRestantes),
    diasExcedidos,
    moeda: c.moeda,
    valorDiaria,
    custo: arred(diasExcedidos * valorDiaria),
    // Quanto já estaria custando se a entrega só acontecer amanhã (ajuda a priorizar).
    custoSeEntregarAmanha: encerrada ? null : arred(Math.max(0, diasUsados + 1 - c.freeTimeDias) * valorDiaria),
    situacao,
  };
}

// Deadline (cut-off) do navio: entregar cheio no terminal até essa data/hora.
export function calcularDeadline(c, agora) {
  if (!c.deadline) return null;
  const deadline = new Date(c.deadline);
  const encerrada = Boolean(c.entreguePortoEm);
  const referencia = encerrada ? new Date(c.entreguePortoEm) : agora;
  const horasRestantes = (deadline - referencia) / HORA;
  let situacao = "OK";
  if (horasRestantes < 0) situacao = "VENCIDO";
  else if (!encerrada && horasRestantes <= 24) situacao = "ATENCAO";
  return { deadline, encerrada, horasRestantes: arred(horasRestantes, 1), situacao };
}

// Coleta programada: passou da data/hora e o container continua "Programado" (nenhuma
// atualização) → atraso. ATENÇÃO logo depois do horário; CRÍTICO após `criticoHoras`.
export const ATRASO_COLETA_CRITICO_HORAS_PADRAO = 4;
export function calcularAtrasoColeta(c, agora, criticoHoras = ATRASO_COLETA_CRITICO_HORAS_PADRAO) {
  if (!c.coletaProgramadaEm || c.status !== "PROGRAMADO") return null;
  const programadaEm = new Date(c.coletaProgramadaEm);
  const horasAtraso = (agora - programadaEm) / HORA;
  if (horasAtraso <= 0) return { programadaEm, atrasada: false, horasAtraso: 0, situacao: "OK" };
  return { programadaEm, atrasada: true, horasAtraso: arred(horasAtraso, 1), situacao: horasAtraso >= criticoHoras ? "VENCIDO" : "ATENCAO" };
}

// leituras: ordenadas da mais antiga para a mais recente.
export function avaliarTemperatura(c, leituras, agora, intervaloLeituraMinutos) {
  if (!ehReefer(c.tipo) || c.tempMin === null || c.tempMin === undefined || c.tempMax === null || c.tempMax === undefined) {
    return null;
  }
  const min = num(c.tempMin);
  const max = num(c.tempMax);
  const fora = (l) => num(l.temperatura) < min || num(l.temperatura) > max;
  const ultima = leituras.length ? leituras[leituras.length - 1] : null;
  const monitorando = STATUS_MONITORA_TEMPERATURA.includes(c.status);

  const resultado = {
    setpoint: num(c.setpoint),
    tempMin: min,
    tempMax: max,
    ultima: ultima ? { temperatura: num(ultima.temperatura), lidaEm: new Date(ultima.lidaEm), origem: ultima.origem } : null,
    monitorando,
    foraDaFaixa: false,
    desvio: null,
    minutosForaDaFaixa: 0,
    nivelTemperatura: null,
    semLeitura: false,
    minutosSemLeitura: null,
    nivelSemLeitura: null,
  };

  if (ultima && fora(ultima)) {
    // Início da sequência contínua de leituras fora da faixa que termina na última leitura.
    let i = leituras.length - 1;
    while (i > 0 && fora(leituras[i - 1])) i--;
    const minutos = (agora - new Date(leituras[i].lidaEm)) / MINUTO;
    resultado.foraDaFaixa = true;
    resultado.desvio = num(ultima.temperatura) > max ? "ACIMA" : "ABAIXO";
    resultado.minutosForaDaFaixa = Math.max(0, Math.round(minutos));
    resultado.nivelTemperatura = minutos >= (c.toleranciaMinutos ?? 0) ? "CRITICO" : "ATENCAO";
  }

  if (STATUS_EXIGE_LEITURA.includes(c.status) && intervaloLeituraMinutos > 0) {
    const referencias = [c.inicioOperacaoEm, ultima?.lidaEm].filter(Boolean).map((d) => new Date(d).getTime());
    if (referencias.length) {
      const minutos = (agora.getTime() - Math.max(...referencias)) / MINUTO;
      resultado.minutosSemLeitura = Math.max(0, Math.round(minutos));
      if (minutos > intervaloLeituraMinutos) {
        resultado.semLeitura = true;
        resultado.nivelSemLeitura = minutos > intervaloLeituraMinutos * 2 ? "CRITICO" : "ATENCAO";
      }
    }
  }
  return resultado;
}

// `previsao` = resultado de estimativa.estimarCiclo (calculado por quem chama, que tem o
// contexto de rota); null quando não há trajeto cadastrado.
export function calcularSituacao(c, leituras, agora, intervaloLeituraMinutos, previsao = null, atrasoColetaCriticoHoras = ATRASO_COLETA_CRITICO_HORAS_PADRAO) {
  return {
    atrasoColeta: calcularAtrasoColeta(c, agora, atrasoColetaCriticoHoras),
    estadia: calcularEstadia(c, agora),
    demurrage: calcularDemurrage(c, agora),
    deadline: calcularDeadline(c, agora),
    temperatura: avaliarTemperatura(c, leituras, agora, intervaloLeituraMinutos),
    previsao,
  };
}

const fmtQuando = (d) =>
  new Date(d).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const fmtHoras = (h) => {
  const abs = Math.abs(h);
  if (abs < 1) return `${Math.round(abs * 60)} min`;
  const horas = Math.floor(abs);
  const min = Math.round((abs - horas) * 60);
  return min ? `${horas}h${String(min).padStart(2, "0")}` : `${horas}h`;
};

const fmtMoeda = (valor, moeda) => {
  try {
    return valor.toLocaleString("pt-BR", { style: "currency", currency: moeda });
  } catch {
    return `${moeda} ${valor.toFixed(2)}`;
  }
};

// Alertas que deveriam estar abertos agora para este container. Container encerrado não tem alerta.
export function alertasDesejados(c, situacao) {
  if (STATUS_ENCERRADOS.includes(c.status)) return [];
  const alertas = [];
  const { estadia, demurrage, deadline, temperatura, atrasoColeta } = situacao;

  if (atrasoColeta?.atrasada) {
    alertas.push({
      tipo: "ATRASO_COLETA",
      nivel: atrasoColeta.situacao === "VENCIDO" ? "CRITICO" : "ATENCAO",
      mensagem: `Coleta programada para ${fmtQuando(atrasoColeta.programadaEm)} está atrasada há ${fmtHoras(atrasoColeta.horasAtraso)} (container ainda "Programado").`,
    });
  }

  if (estadia && !estadia.encerrada && estadia.situacao !== "OK") {
    alertas.push(
      estadia.situacao === "VENCIDO"
        ? { tipo: "ESTADIA", nivel: "CRITICO", mensagem: `Meta de estadia de ${estadia.metaHoras}h estourada em ${fmtHoras(estadia.horasExcedidas)}.` }
        : { tipo: "ESTADIA", nivel: "ATENCAO", mensagem: `Meta de estadia vence em ${fmtHoras(estadia.horasRestantes)} (meta ${estadia.metaHoras}h).` }
    );
  }

  if (demurrage && !demurrage.encerrada && demurrage.situacao !== "OK") {
    alertas.push(
      demurrage.situacao === "VENCIDO"
        ? {
            tipo: "DEMURRAGE",
            nivel: "CRITICO",
            mensagem: `Free time vencido: ${demurrage.diasExcedidos} diária(s) de demurrage (${fmtMoeda(demurrage.custo, demurrage.moeda)}).`,
          }
        : {
            tipo: "DEMURRAGE",
            nivel: "ATENCAO",
            mensagem:
              demurrage.diasRestantes === 0
                ? `Hoje é o último dia de free time. Amanhã começa a cobrança de ${fmtMoeda(demurrage.valorDiaria, demurrage.moeda)}/dia.`
                : `Free time termina em ${demurrage.diasRestantes} dia(s).`,
          }
    );
  }

  if (deadline && !deadline.encerrada && deadline.situacao !== "OK") {
    alertas.push(
      deadline.situacao === "VENCIDO"
        ? { tipo: "DEADLINE", nivel: "CRITICO", mensagem: `Deadline do navio passou há ${fmtHoras(deadline.horasRestantes)} sem entrega no terminal.` }
        : { tipo: "DEADLINE", nivel: "ATENCAO", mensagem: `Deadline do navio em ${fmtHoras(deadline.horasRestantes)}.` }
    );
  }

  if (temperatura?.monitorando && temperatura.foraDaFaixa) {
    const graus = (v) => `${v.toFixed(1).replace(".", ",")}°C`;
    alertas.push({
      tipo: "TEMPERATURA",
      nivel: temperatura.nivelTemperatura,
      mensagem: `Temperatura ${graus(temperatura.ultima.temperatura)} ${temperatura.desvio === "ACIMA" ? "acima" : "abaixo"} da faixa (${graus(temperatura.tempMin)} a ${graus(temperatura.tempMax)}) há ${fmtHoras(temperatura.minutosForaDaFaixa / 60)}.`,
    });
  }

  // Risco previsto (rota): só enquanto o prazo real ainda não venceu — depois disso o alerta
  // DEMURRAGE/DEADLINE de verdade já está aberto e o "risco" seria redundante.
  const p = situacao.previsao;
  if (p?.disponivel) {
    const naProgramada = p.hipotetico && p.coletaSimulada && new Date(p.coletaSimulada) - Date.now() > 60e3; // mensagem gerada na hora
    const seColetarAgora = p.hipotetico ? (naProgramada ? `Coletando na data programada (${fmtQuando(p.coletaSimulada)}), a` : "Mesmo coletando agora, a") : "A";
    if (demurrage?.situacao !== "VENCIDO" && ["ATENCAO", "CRITICO"].includes(p.riscoDemurrage)) {
      alertas.push({
        tipo: "RISCO_DEMURRAGE",
        nivel: p.riscoDemurrage,
        mensagem:
          p.riscoDemurrage === "CRITICO"
            ? `${seColetarAgora} entrega prevista (${fmtQuando(p.previsaoEntrega)}) passa do free time (último dia livre ${fmtQuando(p.vencimentoFreeTime)}): ~${p.diasDemurragePrevistos} diária(s), ${fmtMoeda(p.custoPrevisto, p.moeda)}.`
            : `Folga de só ${fmtHoras(p.folgaHoras)} entre a entrega prevista (${fmtQuando(p.previsaoEntrega)}) e o fim do free time.`,
      });
    }
    if (deadline?.situacao !== "VENCIDO" && ["ATENCAO", "CRITICO"].includes(p.riscoDeadline)) {
      alertas.push({
        tipo: "RISCO_DEADLINE",
        nivel: p.riscoDeadline,
        mensagem:
          p.riscoDeadline === "CRITICO"
            ? `${seColetarAgora} entrega prevista (${fmtQuando(p.previsaoEntrega)}) passa do deadline do navio em ${fmtHoras(p.folgaDeadlineHoras)}.`
            : `Folga de só ${fmtHoras(p.folgaDeadlineHoras)} entre a entrega prevista e o deadline do navio.`,
      });
    }
  }

  if (temperatura?.semLeitura) {
    alertas.push({
      tipo: "SEM_LEITURA",
      nivel: temperatura.nivelSemLeitura,
      mensagem: `Sem leitura de temperatura há ${fmtHoras(temperatura.minutosSemLeitura / 60)}.`,
    });
  }

  return alertas;
}

// Pior situação entre os prazos, usada para colorir o container no painel.
export function semaforo(situacao) {
  const niveis = [];
  for (const chave of ["estadia", "demurrage", "deadline", "atrasoColeta"]) {
    const s = situacao[chave];
    if (s && !s.encerrada) niveis.push(s.situacao === "VENCIDO" ? 2 : s.situacao === "ATENCAO" ? 1 : 0);
  }
  const t = situacao.temperatura;
  if (t?.monitorando && t.foraDaFaixa) niveis.push(t.nivelTemperatura === "CRITICO" ? 2 : 1);
  if (t?.semLeitura) niveis.push(t.nivelSemLeitura === "CRITICO" ? 2 : 1);
  const p = situacao.previsao;
  if (p?.disponivel) {
    for (const risco of [p.riscoDemurrage, p.riscoDeadline]) {
      if (risco === "CRITICO") niveis.push(2);
      else if (risco === "ATENCAO") niveis.push(1);
    }
  }
  const pior = Math.max(0, ...niveis);
  return ["VERDE", "AMARELO", "VERMELHO"][pior];
}
