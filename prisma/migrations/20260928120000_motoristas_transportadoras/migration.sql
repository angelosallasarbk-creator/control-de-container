-- v1.1 Fase 2: transportadoras, motoristas (acesso pelo celular com código SMS, sem usuário), sessões,
-- gestor da transportadora e rastreamento apontando para o motorista.
-- Sem perda de dados: só acréscimos + SolicitacaoPosicao.usuarioId passa a aceitar vazio (destinatário
-- pode ser motorista). A versão 1.0 continua funcionando com este banco (rollback de código seguro).
-- AlterEnum
ALTER TYPE "Perfil" ADD VALUE 'GESTOR_TRANSPORTADORA';

-- DropForeignKey
ALTER TABLE "SolicitacaoPosicao" DROP CONSTRAINT "SolicitacaoPosicao_usuarioId_fkey";

-- AlterTable
ALTER TABLE "Container" ADD COLUMN     "rastreioMotoristaId" INTEGER;

-- AlterTable
ALTER TABLE "MensagemSms" ADD COLUMN     "motoristaId" INTEGER;

-- AlterTable
ALTER TABLE "PosicaoContainer" ADD COLUMN     "motoristaId" INTEGER;

-- AlterTable
ALTER TABLE "SolicitacaoPosicao" ADD COLUMN     "motoristaId" INTEGER,
ALTER COLUMN "usuarioId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Usuario" ADD COLUMN     "transportadoraId" INTEGER;

-- CreateTable
CREATE TABLE "Transportadora" (
    "id" SERIAL NOT NULL,
    "nome" TEXT NOT NULL,
    "cnpj" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transportadora_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Motorista" (
    "id" SERIAL NOT NULL,
    "nome" TEXT NOT NULL,
    "celular" TEXT NOT NULL,
    "cpf" TEXT,
    "placa" TEXT,
    "transportadoraId" INTEGER NOT NULL,
    "bloqueado" BOOLEAN NOT NULL DEFAULT false,
    "bloqueadoEm" TIMESTAMP(3),
    "bloqueadoPor" TEXT,
    "consentimentoEm" TIMESTAMP(3),
    "ultimoAcessoEm" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "criadoPor" TEXT,

    CONSTRAINT "Motorista_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodigoAcessoMotorista" (
    "id" SERIAL NOT NULL,
    "celular" TEXT NOT NULL,
    "codigoHash" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiraEm" TIMESTAMP(3) NOT NULL,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "encerradoEm" TIMESTAMP(3),
    "ip" TEXT,

    CONSTRAINT "CodigoAcessoMotorista_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessaoMotorista" (
    "id" SERIAL NOT NULL,
    "motoristaId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "criadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiraEm" TIMESTAMP(3) NOT NULL,
    "ultimoUsoEm" TIMESTAMP(3),
    "revogadaEm" TIMESTAMP(3),
    "revogadaPor" TEXT,
    "dispositivo" TEXT,

    CONSTRAINT "SessaoMotorista_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Transportadora_nome_key" ON "Transportadora"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "Motorista_celular_key" ON "Motorista"("celular");

-- CreateIndex
CREATE INDEX "Motorista_transportadoraId_idx" ON "Motorista"("transportadoraId");

-- CreateIndex
CREATE INDEX "CodigoAcessoMotorista_celular_criadoEm_idx" ON "CodigoAcessoMotorista"("celular", "criadoEm");

-- CreateIndex
CREATE UNIQUE INDEX "SessaoMotorista_tokenHash_key" ON "SessaoMotorista"("tokenHash");

-- CreateIndex
CREATE INDEX "SessaoMotorista_motoristaId_idx" ON "SessaoMotorista"("motoristaId");

-- AddForeignKey
ALTER TABLE "Usuario" ADD CONSTRAINT "Usuario_transportadoraId_fkey" FOREIGN KEY ("transportadoraId") REFERENCES "Transportadora"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Container" ADD CONSTRAINT "Container_rastreioMotoristaId_fkey" FOREIGN KEY ("rastreioMotoristaId") REFERENCES "Motorista"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosicaoContainer" ADD CONSTRAINT "PosicaoContainer_motoristaId_fkey" FOREIGN KEY ("motoristaId") REFERENCES "Motorista"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitacaoPosicao" ADD CONSTRAINT "SolicitacaoPosicao_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitacaoPosicao" ADD CONSTRAINT "SolicitacaoPosicao_motoristaId_fkey" FOREIGN KEY ("motoristaId") REFERENCES "Motorista"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MensagemSms" ADD CONSTRAINT "MensagemSms_motoristaId_fkey" FOREIGN KEY ("motoristaId") REFERENCES "Motorista"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Motorista" ADD CONSTRAINT "Motorista_transportadoraId_fkey" FOREIGN KEY ("transportadoraId") REFERENCES "Transportadora"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessaoMotorista" ADD CONSTRAINT "SessaoMotorista_motoristaId_fkey" FOREIGN KEY ("motoristaId") REFERENCES "Motorista"("id") ON DELETE CASCADE ON UPDATE CASCADE;

