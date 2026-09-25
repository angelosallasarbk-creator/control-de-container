import { createRouter, createWebHistory } from "vue-router";

const routes = [
  { path: "/", name: "painel", component: () => import("./pages/Painel.vue"), meta: { titulo: "Home" } },
  { path: "/containers", name: "containers", component: () => import("./pages/ContainersInicio.vue"), meta: { titulo: "Containers" } },
  { path: "/containers/:id", name: "ficha", component: () => import("./pages/FichaContainer.vue"), props: true, meta: { titulo: "Container", chave: "ficha" } },
  { path: "/custos", name: "custos", component: () => import("./pages/CustoEstimado.vue"), meta: { titulo: "Custo estimado" } },
  { path: "/alertas", name: "alertas", component: () => import("./pages/Alertas.vue"), meta: { titulo: "Alertas" } },
  { path: "/etiquetas", name: "etiquetas", component: () => import("./pages/Etiquetas.vue"), meta: { titulo: "Etiquetas QR" } },
  // Telas sem menu lateral: folha de impressão e página do celular aberta pelo QR.
  { path: "/etiquetas/imprimir", name: "imprimir-etiquetas", component: () => import("./pages/ImprimirEtiquetas.vue"), meta: { titulo: "Imprimir etiquetas", layout: "simples" } },
  { path: "/leitura", name: "leitura-codigo", component: () => import("./pages/LeituraPorCodigo.vue"), meta: { titulo: "Registrar pelo código", layout: "simples" } },
  { path: "/q/:token", name: "leitura-qr", component: () => import("./pages/LeituraQR.vue"), props: true, meta: { titulo: "Registrar leitura", layout: "simples" } },
  { path: "/locais", name: "locais", component: () => import("./pages/Locais.vue"), meta: { titulo: "Locais" } },
  { path: "/cadastros/:recurso", name: "cadastros", component: () => import("./pages/Cadastros.vue"), props: true, meta: { titulo: "Cadastros" } },
  { path: "/usuarios", name: "usuarios", component: () => import("./pages/Usuarios.vue"), meta: { titulo: "Usuários", acao: "administrar" } },
  { path: "/integracao", name: "integracao", component: () => import("./pages/Integracao.vue"), meta: { titulo: "Integração", acao: "administrar" } },
  { path: "/configuracoes", name: "configuracoes", component: () => import("./pages/Configuracoes.vue"), meta: { titulo: "Configurações", acao: "cadastros" } },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

const router = createRouter({ history: createWebHistory(), routes });

router.afterEach((to) => {
  document.title = to.meta.titulo ? `${to.meta.titulo} · Controle de Container` : "Controle de Container";
});

export default router;
