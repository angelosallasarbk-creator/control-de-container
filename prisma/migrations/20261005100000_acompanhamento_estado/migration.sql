-- v3.1.2: situação do acompanhamento pela página do link (reforço do SMS), para a ficha mostrar
-- quando ele parou. Só acrescenta colunas opcionais (nada é apagado ou convertido).
ALTER TABLE "Container"
  ADD COLUMN "acompanhamentoEstado" TEXT,
  ADD COLUMN "acompanhamentoEstadoEm" TIMESTAMP(3),
  ADD COLUMN "acompanhamentoSinalEm" TIMESTAMP(3);
