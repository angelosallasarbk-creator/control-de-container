-- Ao republicar a 1.2 depois de um rollback: devolve a função PARADA aos tipos marcados por
-- rollback-1.2-antes.sql, tira a marca do nome e reativa os locais de parada (os que têm posição no trajeto).
BEGIN;
UPDATE "TipoLocal" SET "funcao" = 'PARADA', "ativo" = true, "nome" = replace("nome", ' [parada-v1.2]', '') WHERE "nome" LIKE '% [parada-v1.2]';
UPDATE "Local" SET "ativo" = true WHERE "posicaoParada" IS NOT NULL AND "tipoId" IN (SELECT "id" FROM "TipoLocal" WHERE "funcao" = 'PARADA');
SELECT count(*) AS tipos_restaurados FROM "TipoLocal" WHERE "funcao" = 'PARADA';
COMMIT;
