import { createApp } from "vue";
import { createPinia } from "pinia";
import { Chart as ChartJS, CategoryScale, LinearScale, LineElement, PointElement, Tooltip, Legend, Filler } from "chart.js";
import annotationPlugin from "chartjs-plugin-annotation";
import router from "./router.js";
import "./index.css";
import App from "./App.vue";

ChartJS.register(CategoryScale, LinearScale, LineElement, PointElement, Tooltip, Legend, Filler, annotationPlugin);

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount("#app");
