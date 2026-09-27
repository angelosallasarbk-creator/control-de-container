-- "Esqueci minha senha": hash do código do link de redefinição, validade e último pedido.
-- Só acréscimos: colunas opcionais.
ALTER TABLE "Usuario" ADD COLUMN "resetTokenHash" TEXT;
ALTER TABLE "Usuario" ADD COLUMN "resetExpiraEm" TIMESTAMP(3);
ALTER TABLE "Usuario" ADD COLUMN "resetSolicitadoEm" TIMESTAMP(3);
CREATE UNIQUE INDEX "Usuario_resetTokenHash_key" ON "Usuario"("resetTokenHash");
