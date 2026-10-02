-- v3.2 (segurança, antes do primeiro cliente real). Só acrescenta; nada é apagado ou convertido.

-- Item 2: bloqueio do motorista POR CLIENTE. O bloqueio em "Motorista" passa a ser só o da
-- transportadora (gestor: "não trabalha mais conosco", vale para todos os clientes).
ALTER TABLE "MotoristaOrganizacao"
  ADD COLUMN "bloqueado" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bloqueadoEm" TIMESTAMP(3),
  ADD COLUMN "bloqueadoPor" TEXT;

-- Item 5: no máximo UM container ativo por número em cada organização (cadastros simultâneos do
-- mesmo número não duplicam). Índice parcial: o Prisma 5 não representa no schema.prisma — um
-- "prisma migrate dev" futuro vai propor removê-lo; NÃO aceite (ver README, "Banco de dados").
CREATE UNIQUE INDEX "Container_numero_ativo_unico" ON "Container" ("organizacaoId", "numero")
  WHERE "status" NOT IN ('ENTREGUE_PORTO', 'CANCELADO');
