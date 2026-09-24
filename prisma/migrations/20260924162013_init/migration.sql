-- CreateEnum
CREATE TYPE "Perfil" AS ENUM ('ADMIN', 'SUPERVISOR', 'OPERADOR', 'VISUALIZACAO');

-- CreateEnum
CREATE TYPE "StatusContainer" AS ENUM ('PROGRAMADO', 'COLETADO', 'NA_FABRICA', 'EM_OPERACAO', 'LIBERADO', 'SAIU_FABRICA', 'ENTREGUE_PORTO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "TipoContainer" AS ENUM ('DRY_20', 'DRY_40', 'HC_40', 'REEFER_20', 'REEFER_40');

-- CreateEnum
CREATE TYPE "TipoAlerta" AS ENUM ('ESTADIA', 'DEMURRAGE', 'DEADLINE', 'TEMPERATURA', 'SEM_LEITURA');

-- CreateEnum
CREATE TYPE "NivelAlerta" AS ENUM ('ATENCAO', 'CRITICO');

-- CreateEnum
CREATE TYPE "OrigemLeitura" AS ENUM ('MANUAL', 'INTEGRACAO');

-- CreateTable
CREATE TABLE "Usuario" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "senhaHash" TEXT NOT NULL,
    "perfil" "Perfil" NOT NULL DEFAULT 'VISUALIZACAO',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrupoOperacao" (
    "id" SERIAL NOT NULL,
    "cliente" TEXT NOT NULL,
    "fabrica" TEXT NOT NULL,
    "metaEstadiaHoras" INTEGER NOT NULL,
    "alertaEstadiaHoras" INTEGER NOT NULL DEFAULT 6,
    "custoEstadiaPorHora" DECIMAL(12,2),
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrupoOperacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Armador" (
    "id" SERIAL NOT NULL,
    "nome" TEXT NOT NULL,
    "freeTimeDias" INTEGER NOT NULL,
    "valorDiaria" DECIMAL(12,2) NOT NULL,
    "moeda" TEXT NOT NULL DEFAULT 'USD',
    "alertaDemurrageDias" INTEGER NOT NULL DEFAULT 2,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Armador_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Produto" (
    "id" SERIAL NOT NULL,
    "nome" TEXT NOT NULL,
    "setpoint" DECIMAL(5,1) NOT NULL,
    "tempMin" DECIMAL(5,1) NOT NULL,
    "tempMax" DECIMAL(5,1) NOT NULL,
    "toleranciaMinutos" INTEGER NOT NULL DEFAULT 30,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Produto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Container" (
    "id" SERIAL NOT NULL,
    "numero" TEXT NOT NULL,
    "tipo" "TipoContainer" NOT NULL,
    "status" "StatusContainer" NOT NULL DEFAULT 'PROGRAMADO',
    "grupoId" INTEGER NOT NULL,
    "armadorId" INTEGER NOT NULL,
    "produtoId" INTEGER,
    "booking" TEXT,
    "lacre" TEXT,
    "navio" TEXT,
    "deadline" TIMESTAMP(3),
    "placa" TEXT,
    "motorista" TEXT,
    "posicaoPatio" TEXT,
    "observacao" TEXT,
    "metaEstadiaHoras" INTEGER NOT NULL,
    "alertaEstadiaHoras" INTEGER NOT NULL,
    "custoEstadiaPorHora" DECIMAL(12,2),
    "freeTimeDias" INTEGER NOT NULL,
    "valorDiaria" DECIMAL(12,2) NOT NULL,
    "moeda" TEXT NOT NULL,
    "alertaDemurrageDias" INTEGER NOT NULL,
    "setpoint" DECIMAL(5,1),
    "tempMin" DECIMAL(5,1),
    "tempMax" DECIMAL(5,1),
    "toleranciaMinutos" INTEGER,
    "coletadoEm" TIMESTAMP(3),
    "chegadaFabricaEm" TIMESTAMP(3),
    "inicioOperacaoEm" TIMESTAMP(3),
    "liberadoEm" TIMESTAMP(3),
    "saidaFabricaEm" TIMESTAMP(3),
    "entreguePortoEm" TIMESTAMP(3),
    "canceladoEm" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "criadoPor" TEXT NOT NULL,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Container_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventoContainer" (
    "id" SERIAL NOT NULL,
    "containerId" INTEGER NOT NULL,
    "statusDe" "StatusContainer",
    "statusPara" "StatusContainer" NOT NULL,
    "ocorridoEm" TIMESTAMP(3) NOT NULL,
    "registradoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usuarioEmail" TEXT NOT NULL,
    "observacao" TEXT,

    CONSTRAINT "EventoContainer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeituraTemperatura" (
    "id" SERIAL NOT NULL,
    "containerId" INTEGER NOT NULL,
    "temperatura" DECIMAL(5,1) NOT NULL,
    "lidaEm" TIMESTAMP(3) NOT NULL,
    "origem" "OrigemLeitura" NOT NULL,
    "fonte" TEXT,
    "registradaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeituraTemperatura_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alerta" (
    "id" SERIAL NOT NULL,
    "containerId" INTEGER NOT NULL,
    "tipo" "TipoAlerta" NOT NULL,
    "nivel" "NivelAlerta" NOT NULL,
    "mensagem" TEXT NOT NULL,
    "abertoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "encerradoEm" TIMESTAMP(3),
    "reconhecidoEm" TIMESTAMP(3),
    "reconhecidoPor" TEXT,
    "acaoTomada" TEXT,
    "chaveAberta" TEXT,

    CONSTRAINT "Alerta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenIntegracao" (
    "id" SERIAL NOT NULL,
    "nome" TEXT NOT NULL,
    "prefixo" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "criadoPor" TEXT NOT NULL,
    "ultimoUsoEm" TIMESTAMP(3),

    CONSTRAINT "TokenIntegracao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Configuracao" (
    "chave" TEXT NOT NULL,
    "valor" TEXT NOT NULL,

    CONSTRAINT "Configuracao_pkey" PRIMARY KEY ("chave")
);

-- CreateTable
CREATE TABLE "LogAuditoria" (
    "id" SERIAL NOT NULL,
    "usuarioEmail" TEXT NOT NULL,
    "acao" TEXT NOT NULL,
    "entidade" TEXT NOT NULL,
    "entidadeId" TEXT,
    "descricao" TEXT NOT NULL,
    "dadosAntes" TEXT,
    "dadosDepois" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LogAuditoria_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Usuario_email_key" ON "Usuario"("email");

-- CreateIndex
CREATE UNIQUE INDEX "GrupoOperacao_cliente_fabrica_key" ON "GrupoOperacao"("cliente", "fabrica");

-- CreateIndex
CREATE UNIQUE INDEX "Armador_nome_key" ON "Armador"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "Produto_nome_key" ON "Produto"("nome");

-- CreateIndex
CREATE INDEX "Container_numero_idx" ON "Container"("numero");

-- CreateIndex
CREATE INDEX "Container_status_idx" ON "Container"("status");

-- CreateIndex
CREATE INDEX "Container_grupoId_idx" ON "Container"("grupoId");

-- CreateIndex
CREATE INDEX "EventoContainer_containerId_idx" ON "EventoContainer"("containerId");

-- CreateIndex
CREATE INDEX "LeituraTemperatura_containerId_lidaEm_idx" ON "LeituraTemperatura"("containerId", "lidaEm");

-- CreateIndex
CREATE UNIQUE INDEX "LeituraTemperatura_containerId_lidaEm_key" ON "LeituraTemperatura"("containerId", "lidaEm");

-- CreateIndex
CREATE UNIQUE INDEX "Alerta_chaveAberta_key" ON "Alerta"("chaveAberta");

-- CreateIndex
CREATE INDEX "Alerta_containerId_idx" ON "Alerta"("containerId");

-- CreateIndex
CREATE INDEX "Alerta_encerradoEm_idx" ON "Alerta"("encerradoEm");

-- CreateIndex
CREATE UNIQUE INDEX "TokenIntegracao_tokenHash_key" ON "TokenIntegracao"("tokenHash");

-- CreateIndex
CREATE INDEX "LogAuditoria_criadoEm_idx" ON "LogAuditoria"("criadoEm");

-- AddForeignKey
ALTER TABLE "Container" ADD CONSTRAINT "Container_grupoId_fkey" FOREIGN KEY ("grupoId") REFERENCES "GrupoOperacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Container" ADD CONSTRAINT "Container_armadorId_fkey" FOREIGN KEY ("armadorId") REFERENCES "Armador"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Container" ADD CONSTRAINT "Container_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventoContainer" ADD CONSTRAINT "EventoContainer_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeituraTemperatura" ADD CONSTRAINT "LeituraTemperatura_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alerta" ADD CONSTRAINT "Alerta_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE CASCADE ON UPDATE CASCADE;
