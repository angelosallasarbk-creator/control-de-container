-- v1.2: pontos de parada no trajeto (ex.: Ponto Fiscal). Só acréscimos: função PARADA, posição e
-- tempo de parada no local, e as paradas de cada container (com a passagem registrada).
-- CreateEnum
CREATE TYPE "PosicaoParada" AS ENUM ('ANTES_CARREGAMENTO', 'APOS_CARREGAMENTO');

-- AlterEnum
ALTER TYPE "FuncaoLocal" ADD VALUE 'PARADA';

-- AlterTable
ALTER TABLE "Local" ADD COLUMN     "posicaoParada" "PosicaoParada",
ADD COLUMN     "tempoParadaHoras" DECIMAL(5,1);

-- CreateTable
CREATE TABLE "ParadaContainer" (
    "id" SERIAL NOT NULL,
    "containerId" INTEGER NOT NULL,
    "localId" INTEGER NOT NULL,
    "fase" "PosicaoParada" NOT NULL,
    "ordem" INTEGER NOT NULL,
    "passouEm" TIMESTAMP(3),
    "registradoPor" TEXT,
    "origemRegistro" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "precisaoM" INTEGER,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParadaContainer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ParadaContainer_containerId_idx" ON "ParadaContainer"("containerId");

-- AddForeignKey
ALTER TABLE "ParadaContainer" ADD CONSTRAINT "ParadaContainer_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParadaContainer" ADD CONSTRAINT "ParadaContainer_localId_fkey" FOREIGN KEY ("localId") REFERENCES "Local"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

