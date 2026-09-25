-- Plano congelado do container (primeira previsão completa). Só acréscimo: coluna opcional.
ALTER TABLE "Container" ADD COLUMN "planejamento" JSONB;
