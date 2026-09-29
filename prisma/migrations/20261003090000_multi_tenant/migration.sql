-- v3.0 multi-tenant: Organizacao + "organizacaoId" em todas as tabelas de cliente.
-- Todos os dados existentes passam para a organização AS TECH LOG. Motoristas e transportadoras
-- continuam globais (cadastro único na plataforma); os vínculos MotoristaOrganizacao /
-- TransportadoraOrganizacao dizem quais cada cliente enxerga. Nomes passam a ser únicos por
-- organização. Coluna criada vazia → preenchida → obrigatória (nada falha com dado existente).

-- CreateTable
CREATE TABLE "Organizacao" (
    "id" SERIAL NOT NULL,
    "nome" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "criadoPor" TEXT,

    CONSTRAINT "Organizacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MotoristaOrganizacao" (
    "motoristaId" INTEGER NOT NULL,
    "organizacaoId" INTEGER NOT NULL,
    "desde" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MotoristaOrganizacao_pkey" PRIMARY KEY ("motoristaId","organizacaoId")
);

-- CreateTable
CREATE TABLE "TransportadoraOrganizacao" (
    "transportadoraId" INTEGER NOT NULL,
    "organizacaoId" INTEGER NOT NULL,
    "desde" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransportadoraOrganizacao_pkey" PRIMARY KEY ("transportadoraId","organizacaoId")
);

INSERT INTO "Organizacao" ("nome", "criadoPor") VALUES ('AS TECH LOG', 'migração v3.0');

ALTER TABLE "Alerta" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "Alerta" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "Alerta" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "Armador" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "Armador" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "Armador" ALTER COLUMN "organizacaoId" SET NOT NULL;

-- Configuracao: chave única por organização.
ALTER TABLE "Configuracao" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "Configuracao" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "Configuracao" ALTER COLUMN "organizacaoId" SET NOT NULL;
ALTER TABLE "Configuracao" DROP CONSTRAINT "Configuracao_pkey", ADD CONSTRAINT "Configuracao_pkey" PRIMARY KEY ("organizacaoId", "chave");

ALTER TABLE "Container" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "Container" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "Container" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "DistanciaRota" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "DistanciaRota" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "DistanciaRota" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "EtapaFluxo" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "EtapaFluxo" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "EtapaFluxo" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "EtiquetaQR" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "EtiquetaQR" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "EtiquetaQR" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "EventoContainer" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "EventoContainer" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "EventoContainer" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "GrupoOperacao" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "GrupoOperacao" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "GrupoOperacao" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "LeituraTemperatura" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "LeituraTemperatura" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "LeituraTemperatura" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "Local" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "Local" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "Local" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "LogAuditoria" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "LogAuditoria" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');

ALTER TABLE "LoteEtiquetas" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "LoteEtiquetas" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "LoteEtiquetas" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "MensagemSms" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "MensagemSms" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');

ALTER TABLE "MudancaTrajeto" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "MudancaTrajeto" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "MudancaTrajeto" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "ParadaContainer" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "ParadaContainer" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "ParadaContainer" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "PosicaoContainer" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "PosicaoContainer" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "PosicaoContainer" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "Produto" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "Produto" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "Produto" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "Regiao" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "Regiao" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "Regiao" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "SolicitacaoPosicao" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "SolicitacaoPosicao" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "SolicitacaoPosicao" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "TipoLocal" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "TipoLocal" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "TipoLocal" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "TipoOperacao" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "TipoOperacao" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "TipoOperacao" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "TokenIntegracao" ADD COLUMN "organizacaoId" INTEGER;
UPDATE "TokenIntegracao" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG');
ALTER TABLE "TokenIntegracao" ALTER COLUMN "organizacaoId" SET NOT NULL;

ALTER TABLE "Usuario" ADD COLUMN "organizacaoId" INTEGER;
-- Gestor da transportadora (transportadora é global) fica sem organização.
UPDATE "Usuario" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG') WHERE "perfil" <> 'GESTOR_TRANSPORTADORA';

-- Vínculos: a AS TECH LOG já enxerga os motoristas e transportadoras existentes.
INSERT INTO "MotoristaOrganizacao" ("motoristaId", "organizacaoId") SELECT "id", (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG') FROM "Motorista";
INSERT INTO "TransportadoraOrganizacao" ("transportadoraId", "organizacaoId") SELECT "id", (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG') FROM "Transportadora";

-- DropIndex
DROP INDEX "Armador_nome_key";

-- DropIndex
DROP INDEX "GrupoOperacao_cliente_fabrica_key";

-- DropIndex
DROP INDEX "Local_nome_key";

-- DropIndex
DROP INDEX "Produto_nome_key";

-- DropIndex
DROP INDEX "Regiao_nome_key";

-- DropIndex
DROP INDEX "TipoLocal_nome_key";

-- DropIndex
DROP INDEX "TipoOperacao_nome_key";

-- CreateIndex
CREATE UNIQUE INDEX "Organizacao_nome_key" ON "Organizacao"("nome");

-- CreateIndex
CREATE INDEX "MotoristaOrganizacao_organizacaoId_idx" ON "MotoristaOrganizacao"("organizacaoId");

-- CreateIndex
CREATE INDEX "TransportadoraOrganizacao_organizacaoId_idx" ON "TransportadoraOrganizacao"("organizacaoId");

-- CreateIndex
CREATE INDEX "Alerta_organizacaoId_idx" ON "Alerta"("organizacaoId");

-- CreateIndex
CREATE INDEX "Armador_organizacaoId_idx" ON "Armador"("organizacaoId");

-- CreateIndex
CREATE UNIQUE INDEX "Armador_organizacaoId_nome_key" ON "Armador"("organizacaoId", "nome");

-- CreateIndex
CREATE INDEX "Container_organizacaoId_idx" ON "Container"("organizacaoId");

-- CreateIndex
CREATE INDEX "DistanciaRota_organizacaoId_idx" ON "DistanciaRota"("organizacaoId");

-- CreateIndex
CREATE INDEX "EtapaFluxo_organizacaoId_idx" ON "EtapaFluxo"("organizacaoId");

-- CreateIndex
CREATE INDEX "EtiquetaQR_organizacaoId_idx" ON "EtiquetaQR"("organizacaoId");

-- CreateIndex
CREATE INDEX "EventoContainer_organizacaoId_idx" ON "EventoContainer"("organizacaoId");

-- CreateIndex
CREATE INDEX "GrupoOperacao_organizacaoId_idx" ON "GrupoOperacao"("organizacaoId");

-- CreateIndex
CREATE UNIQUE INDEX "GrupoOperacao_organizacaoId_cliente_fabrica_key" ON "GrupoOperacao"("organizacaoId", "cliente", "fabrica");

-- CreateIndex
CREATE INDEX "LeituraTemperatura_organizacaoId_idx" ON "LeituraTemperatura"("organizacaoId");

-- CreateIndex
CREATE INDEX "Local_organizacaoId_idx" ON "Local"("organizacaoId");

-- CreateIndex
CREATE UNIQUE INDEX "Local_organizacaoId_nome_key" ON "Local"("organizacaoId", "nome");

-- CreateIndex
CREATE INDEX "LogAuditoria_organizacaoId_idx" ON "LogAuditoria"("organizacaoId");

-- CreateIndex
CREATE INDEX "LoteEtiquetas_organizacaoId_idx" ON "LoteEtiquetas"("organizacaoId");

-- CreateIndex
CREATE INDEX "MensagemSms_organizacaoId_idx" ON "MensagemSms"("organizacaoId");

-- CreateIndex
CREATE INDEX "MudancaTrajeto_organizacaoId_idx" ON "MudancaTrajeto"("organizacaoId");

-- CreateIndex
CREATE INDEX "ParadaContainer_organizacaoId_idx" ON "ParadaContainer"("organizacaoId");

-- CreateIndex
CREATE INDEX "PosicaoContainer_organizacaoId_idx" ON "PosicaoContainer"("organizacaoId");

-- CreateIndex
CREATE INDEX "Produto_organizacaoId_idx" ON "Produto"("organizacaoId");

-- CreateIndex
CREATE UNIQUE INDEX "Produto_organizacaoId_nome_key" ON "Produto"("organizacaoId", "nome");

-- CreateIndex
CREATE INDEX "Regiao_organizacaoId_idx" ON "Regiao"("organizacaoId");

-- CreateIndex
CREATE UNIQUE INDEX "Regiao_organizacaoId_nome_key" ON "Regiao"("organizacaoId", "nome");

-- CreateIndex
CREATE INDEX "SolicitacaoPosicao_organizacaoId_idx" ON "SolicitacaoPosicao"("organizacaoId");

-- CreateIndex
CREATE INDEX "TipoLocal_organizacaoId_idx" ON "TipoLocal"("organizacaoId");

-- CreateIndex
CREATE UNIQUE INDEX "TipoLocal_organizacaoId_nome_key" ON "TipoLocal"("organizacaoId", "nome");

-- CreateIndex
CREATE INDEX "TipoOperacao_organizacaoId_idx" ON "TipoOperacao"("organizacaoId");

-- CreateIndex
CREATE UNIQUE INDEX "TipoOperacao_organizacaoId_nome_key" ON "TipoOperacao"("organizacaoId", "nome");

-- CreateIndex
CREATE INDEX "TokenIntegracao_organizacaoId_idx" ON "TokenIntegracao"("organizacaoId");

-- CreateIndex
CREATE INDEX "Usuario_organizacaoId_idx" ON "Usuario"("organizacaoId");

-- AddForeignKey
ALTER TABLE "Usuario" ADD CONSTRAINT "Usuario_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Regiao" ADD CONSTRAINT "Regiao_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrupoOperacao" ADD CONSTRAINT "GrupoOperacao_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TipoLocal" ADD CONSTRAINT "TipoLocal_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TipoOperacao" ADD CONSTRAINT "TipoOperacao_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EtapaFluxo" ADD CONSTRAINT "EtapaFluxo_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Local" ADD CONSTRAINT "Local_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistanciaRota" ADD CONSTRAINT "DistanciaRota_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Armador" ADD CONSTRAINT "Armador_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Produto" ADD CONSTRAINT "Produto_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Container" ADD CONSTRAINT "Container_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventoContainer" ADD CONSTRAINT "EventoContainer_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeituraTemperatura" ADD CONSTRAINT "LeituraTemperatura_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoteEtiquetas" ADD CONSTRAINT "LoteEtiquetas_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EtiquetaQR" ADD CONSTRAINT "EtiquetaQR_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alerta" ADD CONSTRAINT "Alerta_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenIntegracao" ADD CONSTRAINT "TokenIntegracao_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Configuracao" ADD CONSTRAINT "Configuracao_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LogAuditoria" ADD CONSTRAINT "LogAuditoria_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosicaoContainer" ADD CONSTRAINT "PosicaoContainer_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitacaoPosicao" ADD CONSTRAINT "SolicitacaoPosicao_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MensagemSms" ADD CONSTRAINT "MensagemSms_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParadaContainer" ADD CONSTRAINT "ParadaContainer_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MudancaTrajeto" ADD CONSTRAINT "MudancaTrajeto_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MotoristaOrganizacao" ADD CONSTRAINT "MotoristaOrganizacao_motoristaId_fkey" FOREIGN KEY ("motoristaId") REFERENCES "Motorista"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MotoristaOrganizacao" ADD CONSTRAINT "MotoristaOrganizacao_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportadoraOrganizacao" ADD CONSTRAINT "TransportadoraOrganizacao_transportadoraId_fkey" FOREIGN KEY ("transportadoraId") REFERENCES "Transportadora"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportadoraOrganizacao" ADD CONSTRAINT "TransportadoraOrganizacao_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;
