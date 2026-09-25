// Distância rodoviária entre Locais, com cache em DistanciaRota.
// Fonte principal: OpenRouteService (perfil caminhão, plano gratuito, chave em ORS_API_KEY).
// Sem chave ou com falha: linha reta × fatorLinhaReta (fonte ESTIMADA), retentada depois.
// Do ORS usamos só a DISTÂNCIA; o tempo sai da regra de rodagem configurável (estimativa.js).
import { prisma } from "./prisma.js";
import { haversineKm } from "./estimativa.js";
import { lerConfiguracao } from "./configuracao.js";

const ORS_URL = "https://api.openrouteservice.org";
const TIMEOUT_MS = 20000;
// Pontos de porto/fábrica às vezes ficam longe da via: "cola" na via mais próxima até 5 km
// (sem limite, um ponto errado poderia grudar numa estrada distante).
const RAIO_SNAP_METROS = 5000;
const RETENTAR_ESTIMADA_APOS_MS = 24 * 60 * 60 * 1000;

const chaveOrs = () => process.env.ORS_API_KEY?.trim() || null;
export const orsConfigurado = () => Boolean(chaveOrs());

async function buscarJson(url, opcoes = {}) {
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opcoes, signal: controle.signal });
    const corpo = await res.json().catch(() => ({}));
    if (!res.ok) {
      const erro = new Error(corpo?.error?.message || `HTTP ${res.status}`);
      erro.status = res.status;
      throw erro;
    }
    return corpo;
  } finally {
    clearTimeout(timer);
  }
}

const temCoordenadas = (l) => l && l.latitude !== null && l.longitude !== null;
const ponto = (l) => ({ latitude: Number(l.latitude), longitude: Number(l.longitude) });

async function distanciaOrsKm(origem, destino) {
  const corpo = await buscarJson(`${ORS_URL}/v2/directions/driving-hgv`, {
    method: "POST",
    headers: { Authorization: chaveOrs(), "Content-Type": "application/json" },
    body: JSON.stringify({
      coordinates: [
        [Number(origem.longitude), Number(origem.latitude)],
        [Number(destino.longitude), Number(destino.latitude)],
      ],
      radiuses: [RAIO_SNAP_METROS, RAIO_SNAP_METROS],
    }),
  });
  const metros = corpo?.routes?.[0]?.summary?.distance;
  if (typeof metros !== "number") throw new Error("Resposta do serviço de rota sem distância.");
  return metros / 1000;
}

/**
 * Distância em km de origem → destino (ids de Local). Usa o cache; calcula se faltar.
 * Devolve { km, fonte } ou null se algum local não tem coordenadas.
 */
export async function obterDistancia(origemId, destinoId, { forcar = false } = {}) {
  if (!origemId || !destinoId) return null;
  if (origemId === destinoId) return { km: 0, fonte: "ORS" };

  const cache = await prisma.distanciaRota.findFirst({
    where: { OR: [{ origemId, destinoId }, { origemId: destinoId, destinoId: origemId }] },
    orderBy: { calculadoEm: "desc" },
  });
  const estimadaVencida = cache?.fonte === "ESTIMADA" && orsConfigurado() && Date.now() - cache.calculadoEm.getTime() > RETENTAR_ESTIMADA_APOS_MS;
  if (cache && !forcar && !estimadaVencida) return { km: Number(cache.distanciaKm), fonte: cache.fonte };

  const [origem, destino] = await Promise.all([
    prisma.local.findUnique({ where: { id: origemId } }),
    prisma.local.findUnique({ where: { id: destinoId } }),
  ]);
  if (!temCoordenadas(origem) || !temCoordenadas(destino)) return null;

  let km;
  let fonte = "ORS";
  if (orsConfigurado()) {
    try {
      km = await distanciaOrsKm(origem, destino);
    } catch (err) {
      console.warn(`Rotas: serviço de rota falhou para ${origem.nome} → ${destino.nome} (${err.message}); usando estimativa em linha reta.`);
    }
  }
  if (km === undefined) {
    const { fatorLinhaReta } = await lerConfiguracao();
    km = haversineKm(ponto(origem), ponto(destino)) * fatorLinhaReta;
    fonte = "ESTIMADA";
  }
  km = Math.round(km * 10) / 10;
  await prisma.distanciaRota.upsert({
    where: { origemId_destinoId: { origemId, destinoId } },
    create: { origemId, destinoId, distanciaKm: km, fonte },
    update: { distanciaKm: km, fonte, calculadoEm: new Date() },
  });
  return { km, fonte };
}

// Coordenadas de um local mudaram: descarta as distâncias dele (recalculadas sob demanda).
export async function invalidarDistancias(localId) {
  await prisma.distanciaRota.deleteMany({ where: { OR: [{ origemId: localId }, { destinoId: localId }] } });
}

// Pares (ida e volta) do trajeto de um container.
export const paresDoContainer = (c) => [
  [c.portoRetiradaId, c.localCarregamentoId],
  [c.localCarregamentoId, c.portoEntregaId],
];

// Garante as distâncias dos pares informados (uma chamada por vez, para respeitar o limite
// do plano gratuito). Falha de um par não impede os demais.
export async function garantirDistancias(pares) {
  const vistos = new Set();
  for (const [o, d] of pares) {
    if (!o || !d) continue;
    const chave = `${Math.min(o, d)}-${Math.max(o, d)}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    try {
      await obterDistancia(o, d);
    } catch (err) {
      console.error(`Rotas: falha ao calcular distância ${o} → ${d}:`, err.message);
    }
  }
}

const UFS = new Set("AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" "));
// Terminais/empresas (venue) e endereços primeiro; rua solta e cidade por último.
const PRIORIDADE_CAMADA = { venue: 0, address: 1, street: 2, neighbourhood: 3, locality: 4, localadmin: 5, county: 6, region: 7 };

// Busca de endereço (ORS geocode, só Brasil).
// Achado em teste: "Porto de Paranaguá, Paranaguá PR" devolve ruas "Paranaguá" em outros
// estados (o 1º era em Natal/RN), enquanto "Porto de Paranaguá" acha o porto. Por isso:
// consulta o texto completo E só o nome (antes da 1ª vírgula), junta, põe a UF digitada
// primeiro e marca resultados de outra UF — a tela mostra o aviso e o link do mapa.
export async function geocodificar(texto) {
  if (!orsConfigurado()) {
    const erro = new Error("Busca de endereço indisponível: configure ORS_API_KEY no .env. Informe latitude/longitude manualmente.");
    erro.status = 503;
    throw erro;
  }
  const limpo = texto.trim();
  const ufPedida = limpo.match(/[\s,\-/]([A-Za-z]{2})$/)?.[1]?.toUpperCase();
  const uf = ufPedida && UFS.has(ufPedida) ? ufPedida : null;
  const consultas = [limpo];
  if (limpo.includes(",")) consultas.push(limpo.split(",")[0].trim());

  const vistos = new Map();
  for (const consulta of consultas) {
    const url = `${ORS_URL}/geocode/search?api_key=${encodeURIComponent(chaveOrs())}&text=${encodeURIComponent(consulta)}&boundary.country=BR&size=8`;
    const corpo = await buscarJson(url);
    for (const f of corpo.features ?? []) {
      const rotulo = f.properties?.label;
      if (!rotulo || vistos.has(rotulo)) continue;
      vistos.set(rotulo, {
        rotulo,
        camada: f.properties?.layer ?? null,
        endereco: [f.properties?.street, f.properties?.housenumber].filter(Boolean).join(", ") || f.properties?.name || null,
        cidade: f.properties?.locality ?? f.properties?.localadmin ?? f.properties?.county ?? null,
        uf: f.properties?.region_a ?? null,
        latitude: f.geometry?.coordinates?.[1],
        longitude: f.geometry?.coordinates?.[0],
      });
    }
  }
  return [...vistos.values()]
    .map((r) => ({ ...r, ufDiferente: Boolean(uf && r.uf && r.uf !== uf) }))
    .sort((a, b) => a.ufDiferente - b.ufDiferente || (PRIORIDADE_CAMADA[a.camada] ?? 9) - (PRIORIDADE_CAMADA[b.camada] ?? 9))
    .slice(0, 8);
}
