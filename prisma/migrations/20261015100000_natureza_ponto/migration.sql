-- v3.12: o Tipo de Operação diz o que acontece no ponto de operação: CARREGAMENTO (ovação, o padrão)
-- ou DESCARGA (desova, ex.: Importação). O container mostra "Ponto de Carregamento" ou "Ponto de
-- Descarregamento" conforme o tipo. Só acrescenta; o tipo padrão "Importação" vira DESCARGA.
CREATE TYPE "NaturezaPonto" AS ENUM ('CARREGAMENTO', 'DESCARGA');
ALTER TABLE "TipoOperacao" ADD COLUMN "naturezaPonto" "NaturezaPonto" NOT NULL DEFAULT 'CARREGAMENTO';
UPDATE "TipoOperacao" SET "naturezaPonto" = 'DESCARGA' WHERE "nome" = 'Importação';
-- Containers já criados guardam uma cópia do fluxo do tipo: acrescenta a natureza nos de DESCARGA.
UPDATE "Container" c SET "fluxo" = jsonb_set(c."fluxo"::jsonb, '{naturezaPonto}', '"DESCARGA"')
  FROM "TipoOperacao" t
  WHERE c."tipoOperacaoId" = t."id" AND t."naturezaPonto" = 'DESCARGA' AND c."fluxo" IS NOT NULL;
