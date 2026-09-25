import path from "node:path";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { requireAuth } from "./lib/auth.js";
import { carregarUsuarioAtual } from "./lib/permissoes.js";
import { authRouter } from "./routes/auth.js";
import { cadastrosRouter } from "./routes/cadastros.js";
import { containersRouter } from "./routes/containers.js";
import { painelRouter } from "./routes/painel.js";
import { alertasRouter } from "./routes/alertas.js";
import { custosRouter } from "./routes/custos.js";
import { locaisRouter, rotasRouter, tiposLocalRouter } from "./routes/locais.js";
import { etiquetasRouter } from "./routes/etiquetas.js";
import { qrRouter } from "./routes/qr.js";
import { integracaoPublicaRouter, tokensRouter } from "./routes/integracao.js";
import { usuariosRouter } from "./routes/usuarios.js";
import { configuracaoRouter, logsRouter } from "./routes/configuracao.js";

// App separado do listen (server.js) para os testes de API usarem o mesmo app sem abrir porta.
export function criarApp() {
  const app = express();

  // Atrás do proxy do Render: sem isso o rate limit enxergaria o IP do proxy, não o do cliente.
  app.set("trust proxy", 1);
  // Front e back são same-origin (Express serve o build do Vue; no dev o Vite faz proxy).
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.get("/api/saude", (_req, res) => res.json({ ok: true }));
  app.use("/api/auth", authRouter);
  // Porta automática de temperatura: autenticada por token próprio, não pelo login.
  app.use("/api/integracao", integracaoPublicaRouter);

  // Tudo em /api daqui para baixo exige sessão válida — e relê o usuário no banco (conta
  // desativada ou permissão alterada vale na hora, sem esperar a sessão expirar).
  app.use("/api", requireAuth, carregarUsuarioAtual);
  app.use("/api", cadastrosRouter);
  app.use("/api/containers", containersRouter);
  app.use("/api/painel", painelRouter);
  app.use("/api/alertas", alertasRouter);
  app.use("/api/custos", custosRouter);
  app.use("/api/locais", locaisRouter);
  app.use("/api/tipos-local", tiposLocalRouter);
  app.use("/api/rotas", rotasRouter);
  app.use("/api/etiquetas", etiquetasRouter);
  app.use("/api/qr", qrRouter);
  app.use("/api/tokens", tokensRouter);
  app.use("/api/usuarios", usuariosRouter);
  app.use("/api/configuracao", configuracaoRouter);
  app.use("/api/logs", logsRouter);
  app.use("/api", (_req, res) => res.status(404).json({ erro: "Rota não encontrada." }));

  const webDist = path.resolve("web/dist");
  app.use(express.static(webDist));
  app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));

  // Precisa ser o último: o middleware de erro só recebe o que vier antes dele.
  app.use((err, _req, res, _next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ erro: "JSON inválido no corpo da requisição." });
    // 4xx e os 502/503 que o próprio código cria (serviço externo fora/não configurado) têm
    // mensagem pensada para o usuário; qualquer outro erro vira "erro interno" genérico.
    if (err.status && (err.status < 500 || err.status === 502 || err.status === 503)) {
      return res.status(err.status).json({ erro: err.message });
    }
    console.error(err);
    res.status(500).json({ erro: "Erro interno no servidor." });
  });

  return app;
}
