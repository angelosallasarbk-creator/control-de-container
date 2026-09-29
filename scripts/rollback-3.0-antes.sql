-- ROLLBACK 3.0 → 2.1.0: rodar ANTES de voltar o código para a v2.1.0 (com o usuário das migrações).
-- A 2.1 não conhece organizações:
--   1) cadastros novos da 2.1 não informam "organizacaoId" → a coluna ganha DEFAULT = AS TECH LOG
--      (continua obrigatória; tudo o que a 2.1 criar cai na AS TECH LOG);
--   2) a 2.1 não conhece o perfil PLATAFORMA → esses usuários viram Visualização DESATIVADOS, com a
--      marca "[plataforma-v3]" no nome (nada é apagado);
--   3) configuração: índice único temporário na chave (a 2.1 grava com ON CONFLICT);
--   4) a 2.1 enxerga TODOS os dados do banco, sem isolamento → o script PARA se existir outra
--      organização com dados (voltar exporia um cliente ao outro). Nesse caso, fale com o
--      responsável antes de decidir.
-- As tabelas e políticas da 3.0 ficam no banco; a 2.1 conecta com o usuário das migrações (dono das
-- tabelas), que não é afetado pelo RLS. rollback-3.0-desfazer.sql devolve tudo ao republicar a 3.0.
BEGIN;
DO $$
DECLARE
  org_as INTEGER;
  outras INTEGER;
  t TEXT;
BEGIN
  SELECT "id" INTO org_as FROM "Organizacao" WHERE "nome" = 'AS TECH LOG';
  IF org_as IS NULL THEN RAISE EXCEPTION 'Organização AS TECH LOG não encontrada.'; END IF;
  SELECT count(*) INTO outras FROM "Organizacao" o WHERE o."id" <> org_as
    AND (EXISTS (SELECT 1 FROM "Container" c WHERE c."organizacaoId" = o."id") OR EXISTS (SELECT 1 FROM "Usuario" u WHERE u."organizacaoId" = o."id"));
  IF outras > 0 THEN
    RAISE EXCEPTION 'Existem % outra(s) organização(ões) com dados: a v2.1 não isola clientes. Rollback interrompido.', outras;
  END IF;
  FOREACH t IN ARRAY ARRAY['Usuario','Regiao','GrupoOperacao','TipoLocal','TipoOperacao','EtapaFluxo','Local','DistanciaRota','Armador','Produto','Container','EventoContainer','LeituraTemperatura','LoteEtiquetas','EtiquetaQR','Alerta','TokenIntegracao','Configuracao','LogAuditoria','PosicaoContainer','SolicitacaoPosicao','MensagemSms','ParadaContainer','MudancaTrajeto'] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "organizacaoId" SET DEFAULT %s', t, org_as);
  END LOOP;
END $$;
-- A 2.1 grava configuração com ON CONFLICT ("chave"): precisa de índice único só na chave (na 3.0 a
-- chave é única por organização; com uma organização só, dá no mesmo).
CREATE UNIQUE INDEX IF NOT EXISTS "Configuracao_chave_rollback_v3" ON "Configuracao"("chave");
UPDATE "Usuario" SET "perfil" = 'VISUALIZACAO', "ativo" = false, "nome" = "nome" || ' [plataforma-v3]' WHERE "perfil" = 'PLATAFORMA';
SELECT count(*) AS admins_plataforma_desativados FROM "Usuario" WHERE "nome" LIKE '% [plataforma-v3]';
COMMIT;
