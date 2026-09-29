-- v3.0: tabelas GLOBAIS da plataforma (sem organizacaoId) com RLS ligado e regra explícita
-- liberando tudo. Motivo (achado no ensaio com a cópia de produção): o Supabase tem o gatilho
-- "ensure_rls", que LIGA o RLS em toda tabela criada — sem política, o usuário ccs_app não
-- enxergaria nenhuma linha dessas tabelas (login de motorista, organizações, vínculos). Com a regra
-- aqui, o comportamento é o mesmo no banco local (sem o gatilho) e no Supabase.
-- O isolamento dessas tabelas é feito na aplicação (motoristas/transportadoras visíveis ao cliente
-- pelos vínculos MotoristaOrganizacao / TransportadoraOrganizacao).
-- ATENÇÃO para migrações futuras: toda tabela NOVA precisa de uma política (de organização ou
-- global), senão no Supabase ela nasce bloqueada para o sistema.

ALTER TABLE "Organizacao" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tabela_global" ON "Organizacao" USING (true) WITH CHECK (true);

ALTER TABLE "Motorista" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tabela_global" ON "Motorista" USING (true) WITH CHECK (true);

ALTER TABLE "Transportadora" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tabela_global" ON "Transportadora" USING (true) WITH CHECK (true);

ALTER TABLE "MotoristaOrganizacao" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tabela_global" ON "MotoristaOrganizacao" USING (true) WITH CHECK (true);

ALTER TABLE "TransportadoraOrganizacao" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tabela_global" ON "TransportadoraOrganizacao" USING (true) WITH CHECK (true);

ALTER TABLE "CodigoAcessoMotorista" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tabela_global" ON "CodigoAcessoMotorista" USING (true) WITH CHECK (true);

ALTER TABLE "SessaoMotorista" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tabela_global" ON "SessaoMotorista" USING (true) WITH CHECK (true);

