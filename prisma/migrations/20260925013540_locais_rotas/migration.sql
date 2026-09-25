-- CreateEnum
CREATE TYPE "TipoLocal" AS ENUM ('FABRICA', 'ARMAZEM', 'PORTO');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TipoAlerta" ADD VALUE 'RISCO_DEMURRAGE';
ALTER TYPE "TipoAlerta" ADD VALUE 'RISCO_DEADLINE';

-- AlterTable
ALTER TABLE "Container" ADD COLUMN     "localCarregamentoId" INTEGER,
ADD COLUMN     "portoEntregaId" INTEGER,
ADD COLUMN     "portoRetiradaId" INTEGER;

-- AlterTable
ALTER TABLE "GrupoOperacao" ADD COLUMN     "localId" INTEGER;

-- CreateTable
CREATE TABLE "Local" (
    "id" SERIAL NOT NULL,
    "nome" TEXT NOT NULL,
    "tipo" "TipoLocal" NOT NULL,
    "endereco" TEXT,
    "cidade" TEXT,
    "uf" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "filaHoras" DECIMAL(5,1),
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Local_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistanciaRota" (
    "id" SERIAL NOT NULL,
    "origemId" INTEGER NOT NULL,
    "destinoId" INTEGER NOT NULL,
    "distanciaKm" DECIMAL(8,1) NOT NULL,
    "fonte" TEXT NOT NULL,
    "calculadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DistanciaRota_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Local_nome_key" ON "Local"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "DistanciaRota_origemId_destinoId_key" ON "DistanciaRota"("origemId", "destinoId");

-- CreateIndex
CREATE INDEX "Container_localCarregamentoId_idx" ON "Container"("localCarregamentoId");

-- AddForeignKey
ALTER TABLE "GrupoOperacao" ADD CONSTRAINT "GrupoOperacao_localId_fkey" FOREIGN KEY ("localId") REFERENCES "Local"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistanciaRota" ADD CONSTRAINT "DistanciaRota_origemId_fkey" FOREIGN KEY ("origemId") REFERENCES "Local"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistanciaRota" ADD CONSTRAINT "DistanciaRota_destinoId_fkey" FOREIGN KEY ("destinoId") REFERENCES "Local"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Container" ADD CONSTRAINT "Container_portoRetiradaId_fkey" FOREIGN KEY ("portoRetiradaId") REFERENCES "Local"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Container" ADD CONSTRAINT "Container_localCarregamentoId_fkey" FOREIGN KEY ("localCarregamentoId") REFERENCES "Local"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Container" ADD CONSTRAINT "Container_portoEntregaId_fkey" FOREIGN KEY ("portoEntregaId") REFERENCES "Local"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Dados: cada fábrica já cadastrada (texto em Cliente/Fábrica) vira um Local do tipo FABRICA,
-- ainda sem endereço/coordenadas (o usuário completa). Nomes iguais sem diferenciar maiúsculas
-- viram um único Local. Só insere; nada existente é apagado ou sobrescrito.
INSERT INTO "Local" ("nome", "tipo")
SELECT DISTINCT ON (lower("fabrica")) "fabrica", 'FABRICA'::"TipoLocal"
FROM "GrupoOperacao"
ORDER BY lower("fabrica"), "id";

UPDATE "GrupoOperacao" g SET "localId" = l."id"
FROM "Local" l
WHERE lower(l."nome") = lower(g."fabrica") AND g."localId" IS NULL;

-- Containers existentes carregam no local padrão do seu Cliente/Fábrica.
UPDATE "Container" c SET "localCarregamentoId" = g."localId"
FROM "GrupoOperacao" g
WHERE g."id" = c."grupoId" AND c."localCarregamentoId" IS NULL;
