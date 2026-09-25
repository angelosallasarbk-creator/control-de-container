-- Data/hora programada da coleta e alerta de atraso quando ela passa sem coleta registrada.
-- Só acréscimos: coluna opcional nova e valor novo no enum de alertas.
ALTER TYPE "TipoAlerta" ADD VALUE IF NOT EXISTS 'ATRASO_COLETA';
ALTER TABLE "Container" ADD COLUMN "coletaProgramadaEm" TIMESTAMP(3);
