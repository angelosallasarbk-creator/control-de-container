-- v3.10: resumo do container gravado pela sincronização (read model das listas) e índices de listagem.
-- Só acrescenta. As colunas começam vazias: a varredura que roda na subida do servidor preenche, e a
-- lista preenche na hora os containers da página que ainda estiverem sem resumo.
ALTER TABLE "Container"
  ADD COLUMN "resumo" JSONB,
  ADD COLUMN "resumoEm" TIMESTAMP(3),
  ADD COLUMN "semaforoNivel" INTEGER,
  ADD COLUMN "estadiaLimiteEm" TIMESTAMP(3),
  ADD COLUMN "demurrageVenceEm" TIMESTAMP(3),
  ADD COLUMN "ultimaTemperatura" DECIMAL(5,1),
  ADD COLUMN "previsaoFolgaHoras" DECIMAL(8,1);

CREATE INDEX "Container_lista_semaforo_idx" ON "Container" ("organizacaoId", "semaforoNivel", "criadoEm" DESC, "id" DESC);
CREATE INDEX "Container_lista_status_idx" ON "Container" ("organizacaoId", "status", "criadoEm" DESC, "id" DESC);
CREATE INDEX "Container_lista_grupo_idx" ON "Container" ("organizacaoId", "grupoId", "status");
