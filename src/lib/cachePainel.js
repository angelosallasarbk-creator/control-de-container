// Cache curto do cálculo do Painel, uma entrada por organização (v3.11).
//
// Por que existe: o painel precisa somar TODOS os containers ativos da organização (totais, semáforo,
// custos). Com ~2.500 ativos isso custava ~600 ms de CPU por chamada (medido), e a Home chama a cada
// minuto de cada navegador. Aqui o cálculo roda no máximo uma vez a cada PAINEL_CACHE_SEGUNDOS (padrão
// 10) por organização; chamadas simultâneas esperam o mesmo cálculo (sem estouro de requisições).
//
// Isolamento: a chave é SEMPRE a organização do contexto da requisição, nunca um parâmetro vindo do
// cliente. Sem organização (plataforma, rotina do sistema) não usa cache.
// Custo: a Home pode mostrar até PAINEL_CACHE_SEGUNDOS de atraso (ela já atualiza sozinha a cada 60 s).
// PAINEL_CACHE_SEGUNDOS=0 desliga.
const MAX_ORGANIZACOES = 20;
const cache = new Map(); // organizacaoId → { ate, promessa }

const ttlMs = () => Math.max(0, Number(process.env.PAINEL_CACHE_SEGUNDOS ?? 10) || 0) * 1000;

export function comCachePainel(organizacaoId, calcular) {
  const ttl = ttlMs();
  if (!ttl || !Number.isInteger(organizacaoId)) return calcular();
  const agora = Date.now();
  const atual = cache.get(organizacaoId);
  if (atual && atual.ate > agora) return atual.promessa;
  const promessa = calcular();
  const entrada = { ate: agora + ttl, promessa };
  cache.delete(organizacaoId);
  cache.set(organizacaoId, entrada);
  // Falhou: não guarda o erro.
  promessa.catch(() => { if (cache.get(organizacaoId) === entrada) cache.delete(organizacaoId); });
  while (cache.size > MAX_ORGANIZACOES) cache.delete(cache.keys().next().value);
  return promessa;
}

export const limparCachePainel = () => cache.clear();

// Solta da memória o que já venceu.
setInterval(() => {
  const agora = Date.now();
  for (const [org, e] of cache) if (e.ate <= agora) cache.delete(org);
}, 30_000).unref();
