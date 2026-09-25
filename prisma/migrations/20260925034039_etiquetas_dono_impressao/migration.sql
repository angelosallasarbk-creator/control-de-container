-- AlterTable
ALTER TABLE "EtiquetaQR" ADD COLUMN     "impressaEm" TIMESTAMP(3),
ADD COLUMN     "impressaPor" TEXT,
ADD COLUMN     "vezesImpressa" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "LoteEtiquetas_criadoPor_idx" ON "LoteEtiquetas"("criadoPor");
