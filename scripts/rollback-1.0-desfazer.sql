-- Ao republicar a v1.1 depois de um rollback: devolve o perfil de Gestor da transportadora a quem
-- tem transportadora vinculada (convertidos por rollback-1.0-antes.sql) e reativa.
BEGIN;
UPDATE "Usuario" SET "perfil" = 'GESTOR_TRANSPORTADORA', "ativo" = true
 WHERE "transportadoraId" IS NOT NULL AND "perfil" = 'VISUALIZACAO';
SELECT count(*) AS gestores_restaurados FROM "Usuario" WHERE "perfil" = 'GESTOR_TRANSPORTADORA';
COMMIT;
