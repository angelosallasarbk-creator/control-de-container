-- v3.0: o gestor de transportadora pertence à organização que o cadastrou (aparece na tela de
-- Usuários dela). Os gestores já existentes foram cadastrados pela AS TECH LOG. Sem organização
-- ficam só os administradores da plataforma.
UPDATE "Usuario" SET "organizacaoId" = (SELECT "id" FROM "Organizacao" WHERE "nome" = 'AS TECH LOG')
WHERE "perfil" = 'GESTOR_TRANSPORTADORA' AND "organizacaoId" IS NULL;
