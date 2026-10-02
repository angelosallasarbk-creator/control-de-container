-- v3.4 (item 9): o NOME da transportadora deixa de ser único na plataforma (clientes diferentes
-- podem ter transportadoras homônimas — empresas diferentes). O CNPJ, quando preenchido, é único:
-- mesmo CNPJ = mesma empresa, e o cadastro é reaproveitado (só o vínculo com o cliente é criado).
-- Não apaga nada. Se já houver dois cadastros com o mesmo CNPJ, a criação do índice falha e a
-- migração inteira volta (nada muda) — juntar os duplicados antes.
DROP INDEX IF EXISTS "Transportadora_nome_key";
CREATE INDEX "Transportadora_nome_idx" ON "Transportadora" ("nome");
CREATE UNIQUE INDEX "Transportadora_cnpj_key" ON "Transportadora" ("cnpj");
