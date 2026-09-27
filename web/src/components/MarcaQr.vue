<script setup>
// Símbolo de QR code ao lado do número do container: indica que há etiqueta QR vinculada.
// Tamanho em "em" = acompanha a fonte do texto ao lado.
defineProps({ tamanho: { type: String, default: "0.95em" } });
</script>

<template>
  <svg
    class="marca-qr" :width="tamanho" :height="tamanho" viewBox="0 0 21 21" fill="currentColor" shape-rendering="crispEdges"
    role="img" aria-label="QR code vinculado"
  >
    <title>Etiqueta QR vinculada</title>
    <!-- 3 marcadores de canto (anel 7×7 + miolo 3×3) -->
    <path fill-rule="evenodd" d="M0 0h7v7H0zM1 1v5h5V1zM2 2h3v3H2z" />
    <path fill-rule="evenodd" d="M14 0h7v7h-7zM15 1v5h5V1zM16 2h3v3h-3z" />
    <path fill-rule="evenodd" d="M0 14h7v7H0zM1 15v5h5v-5zM2 16h3v3H2z" />
    <!-- módulos de dados -->
    <path d="M9 0h2v2H9zM8 3h2v2H8zM11 4h2v2h-2zM9 7h3v2H9zM0 9h2v2H0zM3 8h3v2H3zM4 11h2v2H4zM8 10h2v2H8zM11 10h3v2h-3zM15 8h2v2h-2zM18 9h3v2h-3zM16 12h2v2h-2zM19 13h2v3h-2zM9 13h2v3H9zM12 14h3v2h-3zM8 17h2v2H8zM11 18h3v3h-3zM15 17h2v2h-2zM18 18h3v3h-3zM16 20h2v1h-2z" />
  </svg>
</template>

<style scoped>
.marca-qr { flex-shrink: 0; color: var(--primaria); vertical-align: -0.12em; }
</style>
