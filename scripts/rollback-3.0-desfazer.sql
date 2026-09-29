-- Ao republicar a 3.0 depois de um rollback para a 2.1: tira os valores padrão de "organizacaoId"
-- (na 3.0 a organização vem sempre do contexto) e devolve o perfil aos administradores da plataforma
-- marcados por rollback-3.0-antes.sql. Tudo o que a 2.1 cadastrou nesse meio tempo já está na
-- AS TECH LOG.
BEGIN;
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['Usuario','Regiao','GrupoOperacao','TipoLocal','TipoOperacao','EtapaFluxo','Local','DistanciaRota','Armador','Produto','Container','EventoContainer','LeituraTemperatura','LoteEtiquetas','EtiquetaQR','Alerta','TokenIntegracao','Configuracao','LogAuditoria','PosicaoContainer','SolicitacaoPosicao','MensagemSms','ParadaContainer','MudancaTrajeto'] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "organizacaoId" DROP DEFAULT', t);
  END LOOP;
END $$;
DROP INDEX IF EXISTS "Configuracao_chave_rollback_v3";
-- Usuários criados pela 2.1 (sem perfil PLATAFORMA) já têm a AS TECH LOG pelo DEFAULT.
UPDATE "Usuario" SET "perfil" = 'PLATAFORMA', "ativo" = true, "organizacaoId" = NULL, "nome" = replace("nome", ' [plataforma-v3]', '') WHERE "nome" LIKE '% [plataforma-v3]';
SELECT count(*) AS admins_plataforma_restaurados FROM "Usuario" WHERE "perfil" = 'PLATAFORMA';
COMMIT;
