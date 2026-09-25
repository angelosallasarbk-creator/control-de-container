-- Tipo de local deixa de ser enum fixo (FABRICA/ARMAZEM/PORTO) e vira cadastro (TipoLocal),
-- com função (RETIRADA_ENTREGA | CARREGAMENTO) e rótulos das etapas do container.
-- Conversão 1:1 dos locais existentes, tudo numa transação: qualquer falha desfaz tudo.
-- Se algum local ficasse sem tipo, o SET NOT NULL abaixo falha e nada é aplicado.
BEGIN;

ALTER TYPE "TipoLocal" RENAME TO "TipoLocal_antigo";

CREATE TYPE "FuncaoLocal" AS ENUM ('RETIRADA_ENTREGA', 'CARREGAMENTO');

CREATE TABLE "TipoLocal" (
    "id" SERIAL NOT NULL,
    "nome" TEXT NOT NULL,
    "funcao" "FuncaoLocal" NOT NULL,
    "rotuloColeta" TEXT,
    "rotuloEntrega" TEXT,
    "rotuloChegada" TEXT,
    "rotuloSaida" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TipoLocal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TipoLocal_nome_key" ON "TipoLocal"("nome");

-- Tipos padrão.
INSERT INTO "TipoLocal" ("nome", "funcao", "rotuloColeta", "rotuloEntrega", "rotuloChegada", "rotuloSaida") VALUES
  ('Fábrica',              'CARREGAMENTO',     NULL,                 NULL,                              'Chegada na fábrica', 'Saída da fábrica'),
  ('Armazém',              'CARREGAMENTO',     NULL,                 NULL,                              'Chegada no armazém', 'Saída do armazém'),
  ('Porto / Terminal',     'RETIRADA_ENTREGA', 'Coleta no porto',    'Entrega no porto',                NULL,                 NULL),
  ('Terminal Ferroviário', 'RETIRADA_ENTREGA', 'Coleta ferroviária', 'Entrega no terminal ferroviário', NULL,                 NULL);

-- Locais existentes: cada valor do enum antigo vai para o tipo equivalente.
ALTER TABLE "Local" ADD COLUMN "tipoId" INTEGER;
UPDATE "Local" l SET "tipoId" = t."id"
FROM "TipoLocal" t
WHERE t."nome" = CASE l."tipo"
  WHEN 'FABRICA' THEN 'Fábrica'
  WHEN 'ARMAZEM' THEN 'Armazém'
  WHEN 'PORTO'   THEN 'Porto / Terminal'
END;
ALTER TABLE "Local" ALTER COLUMN "tipoId" SET NOT NULL;

ALTER TABLE "Local" DROP COLUMN "tipo";
DROP TYPE "TipoLocal_antigo";

CREATE INDEX "Local_tipoId_idx" ON "Local"("tipoId");
ALTER TABLE "Local" ADD CONSTRAINT "Local_tipoId_fkey" FOREIGN KEY ("tipoId") REFERENCES "TipoLocal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
