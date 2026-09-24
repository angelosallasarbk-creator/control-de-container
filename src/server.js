import "dotenv/config";
import { criarApp } from "./app.js";
import { purgarLogsExpirados } from "./lib/auditoria.js";
import { iniciarVerificador } from "./lib/verificador.js";
import { criarAdminInicialSeNecessario } from "./lib/adminInicial.js";

await criarAdminInicialSeNecessario().catch((err) => console.error("Falha ao criar admin inicial:", err));

const app = criarApp();
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Controle de Container rodando em http://localhost:${port}`);
});

// Recalcula prazos e abre/encerra alertas periodicamente (ver VERIFICADOR_INTERVALO_MINUTOS).
iniciarVerificador();

purgarLogsExpirados().catch((err) => console.error("Falha na purga inicial de logs:", err));
setInterval(() => {
  purgarLogsExpirados().catch((err) => console.error("Falha na purga periódica de logs:", err));
}, 24 * 60 * 60 * 1000);
