-- ROLLBACK 1.1 → 1.0: rodar ANTES de voltar o código para a v1.0.0.
-- A v1.0 não conhece o perfil GESTOR_TRANSPORTADORA (a tela Usuários quebraria). Os gestores passam
-- a VISUALIZACAO e ficam DESATIVADOS; o vínculo com a transportadora (transportadoraId) é mantido,
-- e é por ele que o script de volta (rollback-1.0-desfazer.sql) os reconhece. Nada é apagado.
BEGIN;
UPDATE "Usuario" SET "perfil" = 'VISUALIZACAO', "ativo" = false
 WHERE "perfil" = 'GESTOR_TRANSPORTADORA';
SELECT count(*) AS gestores_convertidos FROM "Usuario" WHERE "transportadoraId" IS NOT NULL;
COMMIT;
