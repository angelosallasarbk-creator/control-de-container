-- v2.1: mudanças no trajeto do container (antes/depois), mostradas na aba Histórico. Só acréscimo.
-- CreateTable
CREATE TABLE "MudancaTrajeto" (
    "id" SERIAL NOT NULL,
    "containerId" INTEGER NOT NULL,
    "ocorridoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usuarioEmail" TEXT NOT NULL,
    "origem" TEXT NOT NULL,
    "antes" TEXT NOT NULL,
    "depois" TEXT NOT NULL,
    "detalhes" JSONB NOT NULL,
    "aposPlanejado" BOOLEAN NOT NULL,

    CONSTRAINT "MudancaTrajeto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MudancaTrajeto_containerId_idx" ON "MudancaTrajeto"("containerId");

-- AddForeignKey
ALTER TABLE "MudancaTrajeto" ADD CONSTRAINT "MudancaTrajeto_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE CASCADE ON UPDATE CASCADE;

