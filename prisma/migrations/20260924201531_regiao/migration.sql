-- AlterTable
ALTER TABLE "GrupoOperacao" ADD COLUMN     "regiaoId" INTEGER;

-- CreateTable
CREATE TABLE "Regiao" (
    "id" SERIAL NOT NULL,
    "nome" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Regiao_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Regiao_nome_key" ON "Regiao"("nome");

-- CreateIndex
CREATE INDEX "GrupoOperacao_regiaoId_idx" ON "GrupoOperacao"("regiaoId");

-- AddForeignKey
ALTER TABLE "GrupoOperacao" ADD CONSTRAINT "GrupoOperacao_regiaoId_fkey" FOREIGN KEY ("regiaoId") REFERENCES "Regiao"("id") ON DELETE SET NULL ON UPDATE CASCADE;
