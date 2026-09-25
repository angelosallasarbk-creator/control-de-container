-- CreateEnum
CREATE TYPE "StatusEtiqueta" AS ENUM ('LIVRE', 'VINCULADA', 'CANCELADA');

-- AlterEnum
ALTER TYPE "OrigemLeitura" ADD VALUE 'QRCODE';

-- AlterTable
ALTER TABLE "LeituraTemperatura" ADD COLUMN     "etiquetaId" INTEGER,
ADD COLUMN     "latitude" DECIMAL(9,6),
ADD COLUMN     "longitude" DECIMAL(9,6),
ADD COLUMN     "precisaoM" INTEGER;

-- CreateTable
CREATE TABLE "LoteEtiquetas" (
    "id" SERIAL NOT NULL,
    "quantidade" INTEGER NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "criadoPor" TEXT NOT NULL,

    CONSTRAINT "LoteEtiquetas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EtiquetaQR" (
    "id" SERIAL NOT NULL,
    "codigo" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "loteId" INTEGER NOT NULL,
    "status" "StatusEtiqueta" NOT NULL DEFAULT 'LIVRE',
    "containerId" INTEGER,
    "vinculadaEm" TIMESTAMP(3),
    "vinculadaPor" TEXT,
    "canceladaEm" TIMESTAMP(3),
    "canceladaPor" TEXT,
    "motivoCancelamento" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EtiquetaQR_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EtiquetaQR_codigo_key" ON "EtiquetaQR"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "EtiquetaQR_token_key" ON "EtiquetaQR"("token");

-- CreateIndex
CREATE INDEX "EtiquetaQR_containerId_idx" ON "EtiquetaQR"("containerId");

-- CreateIndex
CREATE INDEX "EtiquetaQR_loteId_idx" ON "EtiquetaQR"("loteId");

-- CreateIndex
CREATE INDEX "EtiquetaQR_status_idx" ON "EtiquetaQR"("status");

-- AddForeignKey
ALTER TABLE "LeituraTemperatura" ADD CONSTRAINT "LeituraTemperatura_etiquetaId_fkey" FOREIGN KEY ("etiquetaId") REFERENCES "EtiquetaQR"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EtiquetaQR" ADD CONSTRAINT "EtiquetaQR_loteId_fkey" FOREIGN KEY ("loteId") REFERENCES "LoteEtiquetas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EtiquetaQR" ADD CONSTRAINT "EtiquetaQR_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE SET NULL ON UPDATE CASCADE;
