-- ROLLBACK 1.2 → 1.1.x: rodar ANTES de voltar o código para a v1.1.1.
-- A 1.1 não conhece a função PARADA (Ponto Fiscal): os tipos com essa função viram CARREGAMENTO
-- INATIVO com a marca "[parada-v1.2]" no nome, e os locais deles ficam inativos (não aparecem para
-- escolha). As paradas dos containers (ParadaContainer) ficam guardadas e a 1.1 simplesmente as ignora.
-- Nada é apagado; rollback-1.2-desfazer.sql devolve tudo ao republicar a 1.2.
BEGIN;
UPDATE "Local" SET "ativo" = false WHERE "tipoId" IN (SELECT "id" FROM "TipoLocal" WHERE "funcao" = 'PARADA');
UPDATE "TipoLocal" SET "funcao" = 'CARREGAMENTO', "ativo" = false, "nome" = "nome" || ' [parada-v1.2]' WHERE "funcao" = 'PARADA';
SELECT count(*) AS tipos_convertidos FROM "TipoLocal" WHERE "nome" LIKE '% [parada-v1.2]';
COMMIT;
