import "dotenv/config";
import { criarApp } from "./app.js";
import { purgarLogsExpirados } from "./lib/auditoria.js";
import { iniciarVerificador } from "./lib/verificador.js";
import { iniciarRastreamento, purgarDadosAntigos } from "./lib/rastreamento.js";
import { criarAdminInicialSeNecessario } from "./lib/adminInicial.js";

await criarAdminInicialSeNecessario().catch((err) => console.error("Falha ao criar admin inicial:", err));

const app = criarApp();
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Controle de Container rodando em http://localhost:${port}`);
});

// Recalcula prazos e abre/encerra alertas periodicamente (ver VERIFICADOR_INTERVALO_MINUTOS).
iniciarVerificador();
// Pedidos de posição por SMS (só age com o rastreamento ligado em Configurações).
iniciarRastreamento();

// Retenção: logs (365 dias) e dados do rastreamento/motoristas (posições 90 dias — LGPD).
const purgar = () => {
  purgarLogsExpirados().catch((err) => console.error("Falha na purga de logs:", err));
  purgarDadosAntigos().catch((err) => console.error("Falha na purga do rastreamento:", err));
};
purgar();
setInterval(purgar, 24 * 60 * 60 * 1000);
