import { createApp } from "vue";
import { createPinia } from "pinia";
import { Chart as ChartJS, CategoryScale, LinearScale, LineElement, PointElement, BarElement, Tooltip, Legend, Filler } from "chart.js";
import annotationPlugin from "chartjs-plugin-annotation";
import router from "./router.js";
// Fonte Inter (SIL OFL 1.1) servida pelo próprio sistema — sem depender do Google Fonts,
// funciona em rede corporativa bloqueada. Versão variável: todos os pesos em um arquivo.
import "@fontsource-variable/inter";
import "./index.css";
import App from "./App.vue";

// Gráficos na mesma fonte do sistema.
ChartJS.defaults.font.family = '"Inter Variable", "Segoe UI", system-ui, sans-serif';
ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Tooltip, Legend, Filler, annotationPlugin);

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount("#app");
