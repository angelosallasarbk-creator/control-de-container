<script setup>
// Mapa das posições do container (Leaflet + OpenStreetMap, sem chave de API).
// Cada posição registrada é um ponto; a última fica destacada. Passar o mouse mostra a data/hora.
// Os locais do trajeto (retirada, carregamento, paradas, entrega) aparecem como referência.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { fmtDataHora } from "../formato.js";

const props = defineProps({
  // Da mais recente para a mais antiga (como vem da API): a primeira é a última posição.
  posicoes: { type: Array, default: () => [] },
  // [{ papel: "Retirada", nome, latitude, longitude }]
  locais: { type: Array, default: () => [] },
  rotuloEtapa: { type: Function, default: (s) => s },
});

const refMapa = ref(null);
let mapa = null;
let camada = null;

const escapar = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const temCoord = (p) => Number.isFinite(Number(p?.latitude)) && Number.isFinite(Number(p?.longitude)) && p.latitude !== null && p.longitude !== null;

function desenhar() {
  if (!mapa) return;
  camada.clearLayers();
  const pontos = props.posicoes.filter(temCoord);
  const locais = props.locais.filter(temCoord);
  const limites = [];

  for (const l of locais) {
    const ll = [Number(l.latitude), Number(l.longitude)];
    limites.push(ll);
    L.marker(ll, { icon: L.divIcon({ className: "mapa-local", html: "<span></span>", iconSize: [14, 14] }), keyboard: false })
      .bindTooltip(`<strong>${escapar(l.papel)}</strong><br>${escapar(l.nome)}`, { direction: "top", offset: [0, -6] })
      .addTo(camada);
  }

  // Caminho percorrido, em ordem cronológica.
  const cronologico = [...pontos].reverse().map((p) => [Number(p.latitude), Number(p.longitude)]);
  if (cronologico.length > 1) L.polyline(cronologico, { color: "#1f5fa8", weight: 2, opacity: 0.55, dashArray: "6 6" }).addTo(camada);

  pontos.forEach((p, i) => {
    const ll = [Number(p.latitude), Number(p.longitude)];
    limites.push(ll);
    const ultima = i === 0;
    const texto = `${ultima ? "<strong>Última posição</strong><br>" : ""}${escapar(fmtDataHora(p.registradaEm))}` +
      `<br><span class="mapa-sub">${escapar(props.rotuloEtapa(p.etapa))}${p.usuario ? ` · ${escapar(p.usuario)}` : ""}${p.precisaoM !== null && p.precisaoM !== undefined ? ` · ±${p.precisaoM} m` : ""}</span>`;
    const marcador = ultima
      ? L.marker(ll, { icon: L.divIcon({ className: "mapa-ultima", html: "<span class='pulso'></span><span class='nucleo'></span>", iconSize: [26, 26] }), zIndexOffset: 1000 })
      : L.circleMarker(ll, { radius: 6, color: "#fff", weight: 2, fillColor: "#1f5fa8", fillOpacity: 0.9 });
    marcador.bindTooltip(texto, { direction: "top", offset: ultima ? [0, -10] : [0, -4] }).addTo(camada);
  });

  if (limites.length === 1) mapa.setView(limites[0], 13);
  else if (limites.length) mapa.fitBounds(L.latLngBounds(limites), { padding: [30, 30], maxZoom: 14 });
  else mapa.setView([-15.8, -47.9], 4); // Brasil
}

onMounted(() => {
  mapa = L.map(refMapa.value, { scrollWheelZoom: false, attributionControl: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(mapa);
  camada = L.layerGroup().addTo(mapa);
  // Rolagem do mouse só dá zoom depois de clicar no mapa (não "prende" a rolagem da página).
  mapa.on("click", () => mapa.scrollWheelZoom.enable());
  mapa.on("mouseout", () => mapa.scrollWheelZoom.disable());
  desenhar();
});
watch(() => [props.posicoes, props.locais], desenhar, { deep: true });
onBeforeUnmount(() => {
  mapa?.remove();
  mapa = null;
});
</script>

<template>
  <div class="mapa-posicoes">
    <div ref="refMapa" class="mapa" role="region" aria-label="Mapa das posições do container"></div>
    <div class="legenda pequeno mudo">
      <span><i class="leg ponto"></i> posição registrada</span>
      <span><i class="leg ultima"></i> última posição</span>
      <span v-if="locais.length"><i class="leg local"></i> local do trajeto</span>
      <span>· passe o mouse para ver a data/hora</span>
    </div>
  </div>
</template>

<style scoped>
.mapa { height: 380px; border-radius: 8px; border: 1px solid var(--borda); z-index: 0; }
.legenda { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
.leg { display: inline-block; width: 10px; height: 10px; border-radius: 50%; vertical-align: -1px; margin-right: 4px; }
.leg.ponto { background: #1f5fa8; border: 2px solid #fff; box-shadow: 0 0 0 1px #1f5fa8; }
.leg.ultima { background: #d9480f; box-shadow: 0 0 0 3px rgba(217, 72, 15, 0.3); }
.leg.local { background: #13263d; border-radius: 2px; }
@media (max-width: 640px) { .mapa { height: 300px; } }
</style>

<style>
/* Marcadores (fora do escopo: o Leaflet cria os elementos). */
.mapa-local span { display: block; width: 14px; height: 14px; background: #13263d; border: 2px solid #fff; border-radius: 3px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4); }
.mapa-ultima { position: relative; }
.mapa-ultima .nucleo { position: absolute; inset: 6px; background: #d9480f; border: 3px solid #fff; border-radius: 50%; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45); }
.mapa-ultima .pulso { position: absolute; inset: 0; border-radius: 50%; background: rgba(217, 72, 15, 0.35); animation: mapa-pulso 1.8s ease-out infinite; }
@keyframes mapa-pulso { from { transform: scale(0.6); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .mapa-ultima .pulso { animation: none; } }
.leaflet-tooltip .mapa-sub { color: #5b6776; }
</style>
