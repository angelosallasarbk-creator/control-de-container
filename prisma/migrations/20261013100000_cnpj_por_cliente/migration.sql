-- v3.9 (reauditoria): o CNPJ deixa de ser único na plataforma inteira. Com ele único, quem cadastrava
-- primeiro um CNPJ (que é público) virava dono do cadastro e a empresa verdadeira, ao digitar o mesmo
-- CNPJ, recebia o cadastro dele (com o nome dele) sem poder corrigir. Agora cada cliente tem o seu
-- cadastro: o CNPJ é único só dentro do cliente dono. Não apaga nada.
DROP INDEX IF EXISTS "Transportadora_cnpj_key";
CREATE UNIQUE INDEX "Transportadora_organizacaoDonaId_cnpj_key" ON "Transportadora" ("organizacaoDonaId", "cnpj");
