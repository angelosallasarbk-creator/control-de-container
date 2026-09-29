-- v2.0: Tipo de Operação com fluxo de etapas personalizável. Só acréscimos: enum AcaoEtapa, tabelas
-- TipoOperacao/EtapaFluxo, Container.tipoOperacaoId e Container.fluxo (cópia do fluxo na criação).
-- Cadastra os 4 tipos padrão e liga os containers existentes à "Exportação padrão" (fluxo vazio =
-- o de sempre, nada muda para eles). Voltar para a 1.4: scripts/rollback-1.4-antes.sql.

-- CreateEnum
CREATE TYPE "AcaoEtapa" AS ENUM ('COLETA', 'CHEGADA', 'INICIO_OPERACAO', 'LIBERACAO', 'SAIDA', 'PASSAGEM', 'ENTREGA');

-- CreateTable
CREATE TABLE "TipoOperacao" (
    "id" SERIAL NOT NULL,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "padrao" BOOLEAN NOT NULL DEFAULT false,
    "freeTimeInicio" "StatusContainer" NOT NULL DEFAULT 'COLETADO',
    "freeTimeFim" "StatusContainer" NOT NULL DEFAULT 'ENTREGUE_PORTO',
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TipoOperacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EtapaFluxo" (
    "id" SERIAL NOT NULL,
    "tipoOperacaoId" INTEGER NOT NULL,
    "ordem" INTEGER NOT NULL,
    "acao" "AcaoEtapa" NOT NULL,
    "nome" TEXT,
    "funcaoLocal" "FuncaoLocal",
    "tipoLocalId" INTEGER,
    "localSugeridoId" INTEGER,

    CONSTRAINT "EtapaFluxo_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Container" ADD COLUMN     "fluxo" JSONB,
ADD COLUMN     "tipoOperacaoId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "TipoOperacao_nome_key" ON "TipoOperacao"("nome");

-- CreateIndex
CREATE INDEX "EtapaFluxo_tipoOperacaoId_idx" ON "EtapaFluxo"("tipoOperacaoId");

-- AddForeignKey
ALTER TABLE "EtapaFluxo" ADD CONSTRAINT "EtapaFluxo_tipoOperacaoId_fkey" FOREIGN KEY ("tipoOperacaoId") REFERENCES "TipoOperacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EtapaFluxo" ADD CONSTRAINT "EtapaFluxo_tipoLocalId_fkey" FOREIGN KEY ("tipoLocalId") REFERENCES "TipoLocal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EtapaFluxo" ADD CONSTRAINT "EtapaFluxo_localSugeridoId_fkey" FOREIGN KEY ("localSugeridoId") REFERENCES "Local"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Container" ADD CONSTRAINT "Container_tipoOperacaoId_fkey" FOREIGN KEY ("tipoOperacaoId") REFERENCES "TipoOperacao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tipos padrão e seus fluxos (locais por função; o local sugerido fica para o usuário escolher).
INSERT INTO "TipoOperacao" ("nome", "descricao", "padrao", "freeTimeInicio", "freeTimeFim") VALUES
  ('Exportação padrão', 'Retira o vazio no porto, ova no ponto de carregamento e entrega o cheio no porto.', true, 'COLETADO', 'ENTREGUE_PORTO'),
  ('Coleta de cheio', 'Coleta o container já carregado na fábrica/armazém e entrega no destino.', false, 'COLETADO', 'ENTREGUE_PORTO'),
  ('Importação', 'Retira o cheio no porto, desova no cliente e devolve o vazio.', false, 'COLETADO', 'ENTREGUE_PORTO'),
  ('Transferência', 'Leva o container de um local a outro, com paradas se necessário.', false, 'COLETADO', 'ENTREGUE_PORTO');

INSERT INTO "EtapaFluxo" ("tipoOperacaoId", "ordem", "acao", "nome", "funcaoLocal")
SELECT t."id", e."ordem", e."acao"::"AcaoEtapa", e."nome", e."funcao"::"FuncaoLocal"
FROM "TipoOperacao" t
JOIN (VALUES
  ('Exportação padrão', 1, 'COLETA', NULL, 'RETIRADA_ENTREGA'),
  ('Exportação padrão', 2, 'CHEGADA', NULL, 'CARREGAMENTO'),
  ('Exportação padrão', 3, 'INICIO_OPERACAO', NULL, NULL),
  ('Exportação padrão', 4, 'LIBERACAO', NULL, NULL),
  ('Exportação padrão', 5, 'SAIDA', NULL, NULL),
  ('Exportação padrão', 6, 'ENTREGA', NULL, 'RETIRADA_ENTREGA'),
  ('Coleta de cheio', 1, 'COLETA', 'Coleta do cheio', 'CARREGAMENTO'),
  ('Coleta de cheio', 2, 'ENTREGA', 'Entrega do cheio', 'RETIRADA_ENTREGA'),
  ('Importação', 1, 'COLETA', 'Retirada do cheio', 'RETIRADA_ENTREGA'),
  ('Importação', 2, 'CHEGADA', 'Chegada no cliente', 'CARREGAMENTO'),
  ('Importação', 3, 'INICIO_OPERACAO', 'Em desova', NULL),
  ('Importação', 4, 'LIBERACAO', 'Desova concluída', NULL),
  ('Importação', 5, 'SAIDA', 'Saída do cliente', NULL),
  ('Importação', 6, 'ENTREGA', 'Devolução do vazio', 'RETIRADA_ENTREGA'),
  ('Transferência', 1, 'COLETA', NULL, NULL),
  ('Transferência', 2, 'ENTREGA', NULL, NULL)
) AS e("tipo", "ordem", "acao", "nome", "funcao") ON e."tipo" = t."nome";

-- Containers existentes: Exportação padrão (fluxo vazio = o de sempre).
UPDATE "Container" SET "tipoOperacaoId" = (SELECT "id" FROM "TipoOperacao" WHERE "nome" = 'Exportação padrão');
