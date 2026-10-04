import path from "node:path";
import { readFileSync } from "node:fs";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { requireAuth } from "./lib/auth.js";
import { carregarUsuarioAtual, restringirPerfisDeCampo } from "./lib/permissoes.js";
import { contextoDaRequisicao } from "./lib/tenant.js";
import { authRouter } from "./routes/auth.js";
import { cadastrosRouter } from "./routes/cadastros.js";
import { containersRouter } from "./routes/containers.js";
import { painelRouter } from "./routes/painel.js";
import { alertasRouter } from "./routes/alertas.js";
import { custosRouter } from "./routes/custos.js";
import { locaisRouter, rotasRouter, tiposLocalRouter } from "./routes/locais.js";
import { tiposOperacaoRouter } from "./routes/tiposOperacao.js";
import { etiquetasRouter } from "./routes/etiquetas.js";
import { qrRouter } from "./routes/qr.js";
import { posicaoRouter } from "./routes/posicao.js";
import { motoristaRouter } from "./routes/motorista.js";
import { motoristasRouter } from "./routes/motoristas.js";
import { integracaoPublicaRouter, tokensRouter } from "./routes/integracao.js";
import { usuariosRouter } from "./routes/usuarios.js";
import { configuracaoRouter, logsRouter } from "./routes/configuracao.js";
import { organizacoesRouter } from "./routes/organizacoes.js";

const VERSAO = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// App separado do listen (server.js) para os testes de API usarem o mesmo app sem abrir porta.
export function criarApp() {
  const app = express();

  // Atrás do proxy do Render: sem isso o rate limit enxergaria o IP do proxy, não o do cliente.
  app.set("trust proxy", 1);
  // Front e back são same-origin (Express serve o build do Vue; no dev o Vite faz proxy).
  // CSP (v3.3, item 20): só scripts do próprio site; imagens também do OpenStreetMap (mapa) e
  // data:/blob: (QR, ícone); estilo inline liberado (Vue :style e Leaflet posicionam por estilo).
  // Fora de produção não força https (teste do celular na rede local por http://IP).
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:", "https://tile.openstreetmap.org"],
        "font-src": ["'self'", "data:"],
        "connect-src": ["'self'"],
        "frame-ancestors": ["'none'"],
        "object-src": ["'none'"],
        "upgrade-insecure-requests": process.env.NODE_ENV === "production" ? [] : null,
      },
    },
  }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  // versao: qual versão está no ar (conferência depois de publicar ou de um rollback).
  app.get("/api/saude", (_req, res) => res.json({ ok: true, versao: VERSAO }));
  app.use("/api/auth", authRouter);
  // Porta automática de temperatura: autenticada por token próprio, não pelo login.
  app.use("/api/integracao", integracaoPublicaRouter);
  // Link do SMS de rastreamento: autenticado pelo código do link, não pelo login.
  app.use("/api/posicao", posicaoRouter);
  // Motorista (sem usuário): entra pelo celular com código SMS; sessão própria (cookie cc_motorista).
  app.use("/api/motorista", motoristaRouter);

  // Tudo em /api daqui para baixo exige sessão válida — e relê o usuário no banco (conta
  // desativada ou permissão alterada vale na hora, sem esperar a sessão expirar).
  // Daqui para baixo, toda consulta roda na organização do usuário (lib/tenant.js).
  app.use("/api", requireAuth, carregarUsuarioAtual, contextoDaRequisicao, restringirPerfisDeCampo);
  app.use("/api", cadastrosRouter);
  app.use("/api/containers", containersRouter);
  app.use("/api/painel", painelRouter);
  app.use("/api/alertas", alertasRouter);
  app.use("/api/custos", custosRouter);
  app.use("/api/locais", locaisRouter);
  app.use("/api/tipos-local", tiposLocalRouter);
  app.use("/api/tipos-operacao", tiposOperacaoRouter);
  app.use("/api/rotas", rotasRouter);
  app.use("/api/etiquetas", etiquetasRouter);
  app.use("/api/qr", qrRouter);
  app.use("/api/tokens", tokensRouter);
  app.use("/api/usuarios", usuariosRouter);
  app.use("/api/motoristas", motoristasRouter);
  app.use("/api/configuracao", configuracaoRouter);
  app.use("/api/logs", logsRouter);
  app.use("/api/organizacoes", organizacoesRouter);
  app.use("/api", (_req, res) => res.status(404).json({ erro: "Rota não encontrada." }));

  const webDist = path.resolve("web/dist");
  app.use(express.static(webDist));
  app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));

  // Precisa ser o último: o middleware de erro só recebe o que vier antes dele.
  app.use((err, _req, res, _next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ erro: "JSON inválido no corpo da requisição." });
    if (err.type === "entity.too.large") return res.status(413).json({ erro: "Arquivo grande demais (máximo 1 MB — até 1.000 containers ou 5.000 motoristas por arquivo)." });
    // 4xx e os 502/503 que o próprio código cria (serviço externo fora/não configurado) têm
    // mensagem pensada para o usuário; qualquer outro erro vira "erro interno" genérico.
    if (err.status && (err.status < 500 || err.status === 502 || err.status === 503)) {
      return res.status(err.status).json({ erro: err.message, ...err.extras });
    }
    console.error(err);
    res.status(500).json({ erro: "Erro interno no servidor." });
  });

  return app;
}
