-- v3.0 Fase 3: Row-Level Security — 2ª barreira do isolamento entre organizações.
-- Cada consulta do sistema roda numa transação que define (src/lib/prisma.js):
--   app.org_id     = organização da requisição/rotina
--   app.plataforma = on  → admin da plataforma / gestor de transportadora (registros sem organização)
--   app.sistema    = on  → rotina interna explícita (login pelo e-mail, varredura por organização)
-- Sem nada definido, nenhuma linha é visível (falha fechada).
-- ENABLE sem FORCE: o dono das tabelas (usuário das migrações) não fica sujeito ao RLS — assim uma
-- migração de dados futura nunca "enxerga zero linhas" por engano. O sistema conecta com o usuário
-- ccs_app (sem BYPASSRLS, não é dono), criado por scripts/preparar-banco.js.

ALTER TABLE "Usuario" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "Usuario" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int OR ("organizacaoId" IS NULL AND current_setting('app.plataforma', true) = 'on')) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int OR ("organizacaoId" IS NULL AND current_setting('app.plataforma', true) = 'on'));

ALTER TABLE "Regiao" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "Regiao" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "GrupoOperacao" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "GrupoOperacao" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "TipoLocal" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "TipoLocal" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "TipoOperacao" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "TipoOperacao" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "EtapaFluxo" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "EtapaFluxo" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "Local" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "Local" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "DistanciaRota" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "DistanciaRota" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "Armador" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "Armador" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "Produto" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "Produto" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "Container" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "Container" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "EventoContainer" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "EventoContainer" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "LeituraTemperatura" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "LeituraTemperatura" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "LoteEtiquetas" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "LoteEtiquetas" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "EtiquetaQR" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "EtiquetaQR" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "Alerta" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "Alerta" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "TokenIntegracao" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "TokenIntegracao" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "Configuracao" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "Configuracao" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "LogAuditoria" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "LogAuditoria" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int OR ("organizacaoId" IS NULL AND current_setting('app.plataforma', true) = 'on')) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int OR ("organizacaoId" IS NULL AND current_setting('app.plataforma', true) = 'on'));

ALTER TABLE "PosicaoContainer" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "PosicaoContainer" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "SolicitacaoPosicao" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "SolicitacaoPosicao" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "MensagemSms" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "MensagemSms" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int OR ("organizacaoId" IS NULL AND current_setting('app.plataforma', true) = 'on')) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int OR ("organizacaoId" IS NULL AND current_setting('app.plataforma', true) = 'on'));

ALTER TABLE "ParadaContainer" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "ParadaContainer" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

ALTER TABLE "MudancaTrajeto" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "MudancaTrajeto" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);

