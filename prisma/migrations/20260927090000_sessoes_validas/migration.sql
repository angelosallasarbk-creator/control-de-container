-- Invalidação de sessões lembradas (ex.: após troca de senha). Só acréscimo: coluna opcional.
ALTER TABLE "Usuario" ADD COLUMN "sessoesValidasApos" TIMESTAMP(3);
