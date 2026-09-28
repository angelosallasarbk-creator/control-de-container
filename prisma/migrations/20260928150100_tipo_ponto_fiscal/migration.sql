-- v1.2: tipo de local padrão "Ponto Fiscal" (função PARADA). Separado da migração anterior porque o
-- Postgres só deixa usar o valor novo do enum depois que ele foi criado (commit).
INSERT INTO "TipoLocal" ("nome", "funcao", "ativo") VALUES ('Ponto Fiscal', 'PARADA', true) ON CONFLICT ("nome") DO NOTHING;
