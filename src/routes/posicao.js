// Link do SMS de rastreamento (/p/:codigo): público, sem login — o código aleatório do link é a
// credencial (só o hash fica no banco). Só aceita a posição do responsável atual do container.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler, erroHttp } from "../lib/asyncHandler.js";
import { decimal, inteiro } from "../lib/validacao.js";
import { conferirPedido, registrarPosicaoDoLink, registrarAcompanhamento, organizacaoDoCodigo } from "../lib/rastreamento.js";
import { comOrganizacao, comoPlataforma } from "../lib/tenant.js";

export const posicaoRouter = Router();

posicaoRouter.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: "Muitas tentativas. Aguarde alguns minutos e tente novamente." },
}));

// A organização vem do próprio link (código). Código desconhecido: sem organização → "Link inválido".
posicaoRouter.param("codigo", (req, _res, next, codigo) => {
  organizacaoDoCodigo(codigo)
    .then((org) => (org ? comOrganizacao(org, next) : comoPlataforma(next)))
    .catch(next);
});

posicaoRouter.get("/:codigo", asyncHandler(async (req, res) => {
  res.json(await conferirPedido(req.params.codigo));
}));

function lerPosicao(b = {}) {
  return {
    latitude: decimal(b.latitude, "Latitude", { obrigatorio: true, min: -90, max: 90 }),
    longitude: decimal(b.longitude, "Longitude", { obrigatorio: true, min: -180, max: 180 }),
    precisaoM: b.precisaoM === undefined || b.precisaoM === null ? null : inteiro(Math.round(Number(b.precisaoM)), "Precisão", { min: 0, max: 100000 }),
  };
}

// Acompanhamento pela página aberta (reforço do SMS): posições seguintes do mesmo link.
posicaoRouter.post("/:codigo/acompanhar", asyncHandler(async (req, res) => {
  const r = await registrarAcompanhamento({ codigo: req.params.codigo, ...lerPosicao(req.body ?? {}) });
  if (!r.ok) throw erroHttp(r.cedo ? 429 : 409, r.mensagem);
  res.status(201).json({ ok: true });
}));

posicaoRouter.post("/:codigo", asyncHandler(async (req, res) => {
  const { latitude, longitude, precisaoM } = lerPosicao(req.body ?? {});
  const r = await registrarPosicaoDoLink({ codigo: req.params.codigo, latitude, longitude, precisaoM });
  if (!r.ok) throw erroHttp(409, r.mensagem);
  res.status(201).json({ mensagem: `Posição do container ${r.numero} enviada. Obrigado!` });
}));
