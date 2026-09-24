// Agregações da tela Custo estimado sobre a resposta de GET /api/custos.
// Valores sempre por moeda ({ BRL: x, USD: y }); só consolida em R$ quando há cotação
// para todas as moedas envolvidas (nunca soma moedas diferentes às cegas).
import { fmtMoeda } from "./formato.js";

const DIA_MS = 86400000;

export function somarEm(alvo, porMoeda) {
  for (const [m, v] of Object.entries(porMoeda ?? {})) alvo[m] = Math.round(((alvo[m] ?? 0) + v) * 100) / 100;
  return alvo;
}

export function emReais(porMoeda, cotacoes) {
  let total = 0;
  for (const [m, v] of Object.entries(porMoeda ?? {})) {
    if (!v) continue;
    const cot = cotacoes[m];
    if (!cot) return null;
    total += v * cot;
  }
  return Math.round(total * 100) / 100;
}

export function fmtPorMoeda(porMoeda) {
  const partes = Object.entries(porMoeda ?? {}).filter(([, v]) => v).map(([m, v]) => fmtMoeda(v, m));
  return partes.length ? partes.join(" + ") : fmtMoeda(0);
}

export function moedasSemCotacao(porMoeda, cotacoes) {
  return Object.entries(porMoeda ?? {}).filter(([m, v]) => v && !cotacoes[m]).map(([m]) => m);
}

export function totalContainer(c, cotacoes) {
  return emReais({ [c.estadiaMoeda]: c.estadiaValor, [c.demurrageMoeda]: c.demurrageValor }, cotacoes);
}

// ---------- Resumo de um escopo (conjunto de Cliente/Fábrica) ----------
export function resumir(dados, grupoIds) {
  const ids = new Set(grupoIds);
  const r = { estadia: {}, demurrage: {}, estadiaHoras: 0, diarias: 0, containersComCusto: 0, containersNoPeriodo: 0, horasSemValor: 0 };
  for (const d of dados.dias) {
    if (!ids.has(d.grupoId)) continue;
    somarEm(r.estadia, d.estadia);
    somarEm(r.demurrage, d.demurrage);
    r.estadiaHoras += d.estadiaHoras;
    r.diarias += d.diarias;
  }
  for (const c of dados.containers) {
    if (!ids.has(c.grupoId)) continue;
    r.containersComCusto++;
    if (c.semCustoHora) r.horasSemValor += c.estadiaHoras;
  }
  for (const g of dados.grupos) if (ids.has(g.id)) r.containersNoPeriodo += g.containersNoPeriodo;
  r.estadiaHoras = Math.round(r.estadiaHoras * 10) / 10;
  r.horasSemValor = Math.round(r.horasSemValor * 10) / 10;
  r.total = somarEm(somarEm({}, r.estadia), r.demurrage);
  r.estadiaReais = emReais(r.estadia, dados.cotacoes);
  r.demurrageReais = emReais(r.demurrage, dados.cotacoes);
  r.totalReais = emReais(r.total, dados.cotacoes);
  return r;
}

// ---------- Tendência ----------
export function granularidade(de, ate) {
  const dias = (Date.parse(ate) - Date.parse(de)) / DIA_MS + 1;
  return dias <= 31 ? "dia" : dias <= 186 ? "semana" : "mes";
}

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const dd = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

// Chave do balde de um dia "AAAA-MM-DD" (semana começa na segunda-feira).
function chaveBalde(dia, gran) {
  if (gran === "dia") return dia;
  if (gran === "mes") return dia.slice(0, 7);
  const t = Date.parse(`${dia}T00:00:00Z`);
  const semana = (new Date(t).getUTCDay() + 6) % 7; // 0 = segunda
  return new Date(t - semana * DIA_MS).toISOString().slice(0, 10);
}

function rotuloBalde(chave, gran) {
  if (gran === "dia") return dd(chave);
  if (gran === "mes") return `${MESES[Number(chave.slice(5, 7)) - 1]}/${chave.slice(2, 4)}`;
  return `sem. ${dd(chave)}`;
}

// Todos os baldes do período (inclusive os vazios, para a linha do tempo não "pular").
export function serieTendencia(dados, grupoIds) {
  const gran = granularidade(dados.de, dados.ate);
  const baldes = new Map();
  for (let t = Date.parse(`${dados.de}T00:00:00Z`); t <= Date.parse(`${dados.ate}T00:00:00Z`); t += DIA_MS) {
    const chave = chaveBalde(new Date(t).toISOString().slice(0, 10), gran);
    if (!baldes.has(chave)) baldes.set(chave, { chave, rotulo: rotuloBalde(chave, gran), estadia: {}, demurrage: {}, estadiaHoras: 0, diarias: 0 });
  }
  const ids = new Set(grupoIds);
  for (const d of dados.dias) {
    if (!ids.has(d.grupoId)) continue;
    const b = baldes.get(chaveBalde(d.dia, gran));
    if (!b) continue;
    somarEm(b.estadia, d.estadia);
    somarEm(b.demurrage, d.demurrage);
    b.estadiaHoras += d.estadiaHoras;
    b.diarias += d.diarias;
  }
  return { granularidade: gran, baldes: [...baldes.values()] };
}

// ---------- Principais impactos ----------
const pct = (parte, todo) => (todo ? Math.round((parte / todo) * 100) : 0);
const fmtH = (h) => (h >= 48 ? `${(h / 24).toFixed(1).replace(".", ",")} dias` : `${Math.round(h)}h`);
const ETAPAS = { ateFabrica: "a caminho da fábrica (coleta → chegada)", naFabrica: "dentro da fábrica", atePorto: "a caminho do porto (saída → entrega)" };

export function impactos(dados, grupoIds, gruposPorId) {
  const ids = new Set(grupoIds);
  const cot = dados.cotacoes;
  const conts = dados.containers.filter((c) => ids.has(c.grupoId));
  const r = resumir(dados, grupoIds);
  const itens = [];
  if (!conts.length) return itens;

  // 1. Estadia × demurrage
  if (r.totalReais) {
    const maior = r.demurrageReais >= r.estadiaReais ? "Demurrage" : "Estadia";
    const valor = maior === "Demurrage" ? r.demurrageReais : r.estadiaReais;
    itens.push({ nivel: "alto", texto: `${maior} representa ${pct(valor, r.totalReais)}% do custo estimado (${fmtMoeda(valor)} de ${fmtMoeda(r.totalReais)}).` });
  }

  // 2. Concentração por Cliente/Fábrica (só quando há mais de um no escopo)
  if (ids.size > 1 && r.totalReais) {
    const porGrupo = new Map();
    for (const c of conts) porGrupo.set(c.grupoId, (porGrupo.get(c.grupoId) ?? 0) + (totalContainer(c, cot) ?? 0));
    const [topId, topValor] = [...porGrupo].sort((a, b) => b[1] - a[1])[0];
    const g = gruposPorId.get(topId);
    if (g && topValor > 0) {
      itens.push({ nivel: "alto", texto: `${g.cliente} / ${g.fabrica} concentra ${pct(topValor, r.totalReais)}% do custo (${fmtMoeda(topValor)}).` });
    }
  }

  // 3. Armador que mais gerou demurrage
  const porArmador = new Map();
  for (const c of conts) {
    if (!c.diarias) continue;
    const a = porArmador.get(c.armador) ?? { diarias: 0, valor: {} };
    a.diarias += c.diarias;
    somarEm(a.valor, { [c.demurrageMoeda]: c.demurrageValor });
    porArmador.set(c.armador, a);
  }
  const totalDiarias = [...porArmador.values()].reduce((s, a) => s + a.diarias, 0);
  if (porArmador.size) {
    const [nome, a] = [...porArmador].sort((x, y) => y[1].diarias - x[1].diarias)[0];
    itens.push({
      nivel: "medio",
      texto: `${nome} responde por ${pct(a.diarias, totalDiarias)}% das diárias de demurrage (${a.diarias} diária(s), ${fmtPorMoeda(a.valor)}).`,
    });
  }

  // 4. Onde o tempo foi perdido nos containers que pagaram demurrage
  const comDemurrage = conts.filter((c) => c.diarias > 0);
  if (comDemurrage.length) {
    const medias = {};
    for (const etapa of Object.keys(ETAPAS)) {
      const valores = comDemurrage.map((c) => c.tempos[etapa]).filter((v) => v !== null);
      medias[etapa] = valores.length ? valores.reduce((s, v) => s + v, 0) / valores.length : 0;
    }
    const total = Object.values(medias).reduce((s, v) => s + v, 0);
    const [pior, horas] = Object.entries(medias).sort((a, b) => b[1] - a[1])[0];
    if (total > 0) {
      itens.push({
        nivel: "alto",
        texto: `Nos ${comDemurrage.length} container(s) que pagaram demurrage, a maior parte do tempo foi ${ETAPAS[pior]}: média de ${fmtH(horas)} (${pct(horas, total)}% do ciclo).`,
      });
    }
  }

  // 5. Estouro da meta de estadia
  const comEstadia = conts.filter((c) => c.estadiaHoras > 0);
  if (comEstadia.length) {
    const media = comEstadia.reduce((s, c) => s + c.estadiaHoras, 0) / comEstadia.length;
    itens.push({ nivel: "medio", texto: `${comEstadia.length} container(s) estouraram a meta de estadia, com média de ${fmtH(media)} além da meta.` });
  }

  // 6. Concentração nos mais caros
  if (r.totalReais && conts.length > 3) {
    const top3 = conts.map((c) => totalContainer(c, cot) ?? 0).sort((a, b) => b - a).slice(0, 3).reduce((s, v) => s + v, 0);
    itens.push({ nivel: "medio", texto: `Os 3 containers mais caros somam ${pct(top3, r.totalReais)}% do custo do período.` });
  }

  // 7. Tendência: 2ª metade × 1ª metade do período (só com valores consolidados)
  const { baldes } = serieTendencia(dados, grupoIds);
  if (baldes.length >= 4) {
    const meio = Math.floor(baldes.length / 2);
    const soma = (lista) => lista.reduce((s, b) => s + (emReais(somarEm(somarEm({}, b.estadia), b.demurrage), cot) ?? NaN), 0);
    const a = soma(baldes.slice(0, meio));
    const b = soma(baldes.slice(meio));
    if (Number.isFinite(a) && Number.isFinite(b) && (a > 0 || b > 0)) {
      const variacao = a > 0 ? Math.round(((b - a) / a) * 100) : null;
      itens.push({
        nivel: b > a ? "alto" : "baixo",
        texto:
          variacao === null
            ? `Todo o custo do período se concentrou na segunda metade (${fmtMoeda(b)}).`
            : `Custo na segunda metade do período ${variacao >= 0 ? "subiu" : "caiu"} ${Math.abs(variacao)}% em relação à primeira (${fmtMoeda(a)} → ${fmtMoeda(b)}).`,
      });
    }
  }

  // 8. Horas excedidas sem valor cadastrado
  if (r.horasSemValor > 0) {
    itens.push({ nivel: "aviso", texto: `${fmtH(r.horasSemValor)} de estadia excedida estão sem valor: cadastre o custo por hora em Cliente / Fábrica para estimar esse custo.` });
  }
  return itens;
}
