-- v1.4: categoria do produto (Congelado, Refrigerado, Carga Seca). Carga Seca não tem faixa de
-- temperatura, por isso setpoint/tempMin/tempMax passam a aceitar vazio. Nenhum dado é apagado: os
-- produtos existentes (todos com faixa) viram CONGELADO se o setpoint for -5 °C ou menor, senão REFRIGERADO.
-- CreateEnum
CREATE TYPE "CategoriaProduto" AS ENUM ('CONGELADO', 'REFRIGERADO', 'CARGA_SECA');

-- AlterTable
ALTER TABLE "Produto" ADD COLUMN     "categoria" "CategoriaProduto" NOT NULL DEFAULT 'REFRIGERADO',
ALTER COLUMN "setpoint" DROP NOT NULL,
ALTER COLUMN "tempMin" DROP NOT NULL,
ALTER COLUMN "tempMax" DROP NOT NULL;


-- Classificação dos produtos existentes pela faixa.
UPDATE "Produto" SET "categoria" = 'CONGELADO' WHERE "setpoint" <= -5;
