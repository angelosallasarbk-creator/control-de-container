-- v3.6: chaves estrangeiras COMPOSTAS (id, organizacaoId) entre tabelas de cliente.
-- Motivo: a conferência de chave estrangeira do PostgreSQL não passa pelo RLS — antes, o banco
-- aceitava gravar num registro do cliente A o id de um cadastro do cliente B (só a validação das
-- rotas impedia). Agora o próprio banco recusa (erro 23503).
-- Como: as chaves simples atuais FICAM (cuidam de cascata / restrição / esvaziar o campo); cada
-- ligação ganha uma segunda chave (campo, organizacaoId) → (id, organizacaoId), sem ação própria
-- (NO ACTION): só confere que o registro apontado é do MESMO cliente. Campo vazio não é conferido.
-- Se algum dado existente apontar para outro cliente, esta migração falha inteira e nada muda.
-- ⚠ O Prisma 5 não representa estas chaves no schema.prisma: um "prisma migrate dev" futuro vai
-- propor removê-las (DROP CONSTRAINT ..._org_fkey) — não aceite (README, "Banco de dados").

-- 1) Índices únicos (id, organizacaoId) nos 11 cadastros referenciados.
CREATE UNIQUE INDEX "Armador_id_organizacaoId_key" ON "Armador" ("id", "organizacaoId");
CREATE UNIQUE INDEX "Container_id_organizacaoId_key" ON "Container" ("id", "organizacaoId");
CREATE UNIQUE INDEX "EtiquetaQR_id_organizacaoId_key" ON "EtiquetaQR" ("id", "organizacaoId");
CREATE UNIQUE INDEX "GrupoOperacao_id_organizacaoId_key" ON "GrupoOperacao" ("id", "organizacaoId");
CREATE UNIQUE INDEX "Local_id_organizacaoId_key" ON "Local" ("id", "organizacaoId");
CREATE UNIQUE INDEX "LoteEtiquetas_id_organizacaoId_key" ON "LoteEtiquetas" ("id", "organizacaoId");
CREATE UNIQUE INDEX "Produto_id_organizacaoId_key" ON "Produto" ("id", "organizacaoId");
CREATE UNIQUE INDEX "Regiao_id_organizacaoId_key" ON "Regiao" ("id", "organizacaoId");
CREATE UNIQUE INDEX "TipoLocal_id_organizacaoId_key" ON "TipoLocal" ("id", "organizacaoId");
CREATE UNIQUE INDEX "TipoOperacao_id_organizacaoId_key" ON "TipoOperacao" ("id", "organizacaoId");
CREATE UNIQUE INDEX "Usuario_id_organizacaoId_key" ON "Usuario" ("id", "organizacaoId");

-- 2) 31 chaves compostas.
ALTER TABLE "Alerta" ADD CONSTRAINT "Alerta_containerId_org_fkey" FOREIGN KEY ("containerId", "organizacaoId") REFERENCES "Container" ("id", "organizacaoId");
ALTER TABLE "Container" ADD CONSTRAINT "Container_armadorId_org_fkey" FOREIGN KEY ("armadorId", "organizacaoId") REFERENCES "Armador" ("id", "organizacaoId");
ALTER TABLE "Container" ADD CONSTRAINT "Container_grupoId_org_fkey" FOREIGN KEY ("grupoId", "organizacaoId") REFERENCES "GrupoOperacao" ("id", "organizacaoId");
ALTER TABLE "Container" ADD CONSTRAINT "Container_localCarregamentoId_org_fkey" FOREIGN KEY ("localCarregamentoId", "organizacaoId") REFERENCES "Local" ("id", "organizacaoId");
ALTER TABLE "Container" ADD CONSTRAINT "Container_portoEntregaId_org_fkey" FOREIGN KEY ("portoEntregaId", "organizacaoId") REFERENCES "Local" ("id", "organizacaoId");
ALTER TABLE "Container" ADD CONSTRAINT "Container_portoRetiradaId_org_fkey" FOREIGN KEY ("portoRetiradaId", "organizacaoId") REFERENCES "Local" ("id", "organizacaoId");
ALTER TABLE "Container" ADD CONSTRAINT "Container_produtoId_org_fkey" FOREIGN KEY ("produtoId", "organizacaoId") REFERENCES "Produto" ("id", "organizacaoId");
ALTER TABLE "Container" ADD CONSTRAINT "Container_rastreioResponsavelId_org_fkey" FOREIGN KEY ("rastreioResponsavelId", "organizacaoId") REFERENCES "Usuario" ("id", "organizacaoId");
ALTER TABLE "Container" ADD CONSTRAINT "Container_tipoOperacaoId_org_fkey" FOREIGN KEY ("tipoOperacaoId", "organizacaoId") REFERENCES "TipoOperacao" ("id", "organizacaoId");
ALTER TABLE "DistanciaRota" ADD CONSTRAINT "DistanciaRota_destinoId_org_fkey" FOREIGN KEY ("destinoId", "organizacaoId") REFERENCES "Local" ("id", "organizacaoId");
ALTER TABLE "DistanciaRota" ADD CONSTRAINT "DistanciaRota_origemId_org_fkey" FOREIGN KEY ("origemId", "organizacaoId") REFERENCES "Local" ("id", "organizacaoId");
ALTER TABLE "EtapaFluxo" ADD CONSTRAINT "EtapaFluxo_localSugeridoId_org_fkey" FOREIGN KEY ("localSugeridoId", "organizacaoId") REFERENCES "Local" ("id", "organizacaoId");
ALTER TABLE "EtapaFluxo" ADD CONSTRAINT "EtapaFluxo_tipoLocalId_org_fkey" FOREIGN KEY ("tipoLocalId", "organizacaoId") REFERENCES "TipoLocal" ("id", "organizacaoId");
ALTER TABLE "EtapaFluxo" ADD CONSTRAINT "EtapaFluxo_tipoOperacaoId_org_fkey" FOREIGN KEY ("tipoOperacaoId", "organizacaoId") REFERENCES "TipoOperacao" ("id", "organizacaoId");
ALTER TABLE "EtiquetaQR" ADD CONSTRAINT "EtiquetaQR_containerId_org_fkey" FOREIGN KEY ("containerId", "organizacaoId") REFERENCES "Container" ("id", "organizacaoId");
ALTER TABLE "EtiquetaQR" ADD CONSTRAINT "EtiquetaQR_loteId_org_fkey" FOREIGN KEY ("loteId", "organizacaoId") REFERENCES "LoteEtiquetas" ("id", "organizacaoId");
ALTER TABLE "EventoContainer" ADD CONSTRAINT "EventoContainer_containerId_org_fkey" FOREIGN KEY ("containerId", "organizacaoId") REFERENCES "Container" ("id", "organizacaoId");
ALTER TABLE "GrupoOperacao" ADD CONSTRAINT "GrupoOperacao_localId_org_fkey" FOREIGN KEY ("localId", "organizacaoId") REFERENCES "Local" ("id", "organizacaoId");
ALTER TABLE "GrupoOperacao" ADD CONSTRAINT "GrupoOperacao_regiaoId_org_fkey" FOREIGN KEY ("regiaoId", "organizacaoId") REFERENCES "Regiao" ("id", "organizacaoId");
ALTER TABLE "LeituraTemperatura" ADD CONSTRAINT "LeituraTemperatura_containerId_org_fkey" FOREIGN KEY ("containerId", "organizacaoId") REFERENCES "Container" ("id", "organizacaoId");
ALTER TABLE "LeituraTemperatura" ADD CONSTRAINT "LeituraTemperatura_etiquetaId_org_fkey" FOREIGN KEY ("etiquetaId", "organizacaoId") REFERENCES "EtiquetaQR" ("id", "organizacaoId");
ALTER TABLE "Local" ADD CONSTRAINT "Local_tipoId_org_fkey" FOREIGN KEY ("tipoId", "organizacaoId") REFERENCES "TipoLocal" ("id", "organizacaoId");
ALTER TABLE "MensagemSms" ADD CONSTRAINT "MensagemSms_containerId_org_fkey" FOREIGN KEY ("containerId", "organizacaoId") REFERENCES "Container" ("id", "organizacaoId");
ALTER TABLE "MensagemSms" ADD CONSTRAINT "MensagemSms_usuarioId_org_fkey" FOREIGN KEY ("usuarioId", "organizacaoId") REFERENCES "Usuario" ("id", "organizacaoId");
ALTER TABLE "MudancaTrajeto" ADD CONSTRAINT "MudancaTrajeto_containerId_org_fkey" FOREIGN KEY ("containerId", "organizacaoId") REFERENCES "Container" ("id", "organizacaoId");
ALTER TABLE "ParadaContainer" ADD CONSTRAINT "ParadaContainer_containerId_org_fkey" FOREIGN KEY ("containerId", "organizacaoId") REFERENCES "Container" ("id", "organizacaoId");
ALTER TABLE "ParadaContainer" ADD CONSTRAINT "ParadaContainer_localId_org_fkey" FOREIGN KEY ("localId", "organizacaoId") REFERENCES "Local" ("id", "organizacaoId");
ALTER TABLE "PosicaoContainer" ADD CONSTRAINT "PosicaoContainer_containerId_org_fkey" FOREIGN KEY ("containerId", "organizacaoId") REFERENCES "Container" ("id", "organizacaoId");
ALTER TABLE "PosicaoContainer" ADD CONSTRAINT "PosicaoContainer_usuarioId_org_fkey" FOREIGN KEY ("usuarioId", "organizacaoId") REFERENCES "Usuario" ("id", "organizacaoId");
ALTER TABLE "SolicitacaoPosicao" ADD CONSTRAINT "SolicitacaoPosicao_containerId_org_fkey" FOREIGN KEY ("containerId", "organizacaoId") REFERENCES "Container" ("id", "organizacaoId");
ALTER TABLE "SolicitacaoPosicao" ADD CONSTRAINT "SolicitacaoPosicao_usuarioId_org_fkey" FOREIGN KEY ("usuarioId", "organizacaoId") REFERENCES "Usuario" ("id", "organizacaoId");
