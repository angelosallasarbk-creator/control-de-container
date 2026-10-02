-- v3.3 (endurecimento, custo e LGPD). Só acrescenta; nada é apagado ou convertido.

-- Item 10: o pedido de código SMS do motorista passa a saber de qual cliente veio (teto por cliente).
ALTER TABLE "CodigoAcessoMotorista" ADD COLUMN "organizacaoId" INTEGER;
CREATE INDEX "CodigoAcessoMotorista_organizacaoId_criadoEm_idx" ON "CodigoAcessoMotorista" ("organizacaoId", "criadoEm");

-- Item 20: ações do motorista no log guardam também o id dele (o nome é texto livre digitado por ele).
ALTER TABLE "LogAuditoria" ADD COLUMN "motoristaId" INTEGER;

-- Item 8: o usuário da aplicação (ccs_app) deixa de poder alterar ou apagar o log (REVOKE em
-- scripts/preparar-banco.js, que roda depois desta migração). A purga de 365 dias passa por esta
-- função, que roda com o dono das tabelas e nunca apaga log mais novo que 365 dias.
CREATE OR REPLACE FUNCTION purgar_log_auditoria(dias integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  apagados integer;
BEGIN
  IF dias IS NULL OR dias < 365 THEN
    RAISE EXCEPTION 'Retenção mínima do log de auditoria: 365 dias.';
  END IF;
  DELETE FROM "LogAuditoria" WHERE "criadoEm" < now() - make_interval(days => dias);
  GET DIAGNOSTICS apagados = ROW_COUNT;
  RETURN apagados;
END $$;
REVOKE ALL ON FUNCTION purgar_log_auditoria(integer) FROM PUBLIC;
-- Supabase concede EXECUTE em funções novas aos papéis da API REST: retira.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON FUNCTION purgar_log_auditoria(integer) FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON FUNCTION purgar_log_auditoria(integer) FROM authenticated; END IF;
END $$;
