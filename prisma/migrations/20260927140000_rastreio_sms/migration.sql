-- Rastreamento por SMS: Etiqueta QR → Container → Usuário responsável → Celular; posições GPS,
-- pedidos de posição (link com hash) e registro dos SMS. Só acréscimos.
-- AlterTable
ALTER TABLE "Container" ADD COLUMN     "rastreioDesde" TIMESTAMP(3),
ADD COLUMN     "rastreioResponsavelId" INTEGER,
ADD COLUMN     "rastreioUltimoEnvioEm" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Usuario" ADD COLUMN     "celular" TEXT;

-- CreateTable
CREATE TABLE "PosicaoContainer" (
    "id" SERIAL NOT NULL,
    "containerId" INTEGER NOT NULL,
    "usuarioId" INTEGER,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "precisaoM" INTEGER,
    "origem" TEXT NOT NULL,
    "etapa" TEXT NOT NULL,
    "registradaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosicaoContainer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolicitacaoPosicao" (
    "id" SERIAL NOT NULL,
    "containerId" INTEGER NOT NULL,
    "usuarioId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "criadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiraEm" TIMESTAMP(3) NOT NULL,
    "respondidaEm" TIMESTAMP(3),

    CONSTRAINT "SolicitacaoPosicao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MensagemSms" (
    "id" SERIAL NOT NULL,
    "containerId" INTEGER,
    "usuarioId" INTEGER,
    "telefone" TEXT,
    "tipo" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "texto" TEXT NOT NULL,
    "erro" TEXT,
    "criadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MensagemSms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PosicaoContainer_containerId_registradaEm_idx" ON "PosicaoContainer"("containerId", "registradaEm");

-- CreateIndex
CREATE UNIQUE INDEX "SolicitacaoPosicao_tokenHash_key" ON "SolicitacaoPosicao"("tokenHash");

-- CreateIndex
CREATE INDEX "SolicitacaoPosicao_containerId_idx" ON "SolicitacaoPosicao"("containerId");

-- CreateIndex
CREATE INDEX "MensagemSms_containerId_criadaEm_idx" ON "MensagemSms"("containerId", "criadaEm");

-- AddForeignKey
ALTER TABLE "Container" ADD CONSTRAINT "Container_rastreioResponsavelId_fkey" FOREIGN KEY ("rastreioResponsavelId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosicaoContainer" ADD CONSTRAINT "PosicaoContainer_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosicaoContainer" ADD CONSTRAINT "PosicaoContainer_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitacaoPosicao" ADD CONSTRAINT "SolicitacaoPosicao_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitacaoPosicao" ADD CONSTRAINT "SolicitacaoPosicao_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MensagemSms" ADD CONSTRAINT "MensagemSms_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MensagemSms" ADD CONSTRAINT "MensagemSms_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

