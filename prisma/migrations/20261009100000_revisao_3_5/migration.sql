-- v3.5 (revisão da v3.4). Só acrescenta; nada é apagado.

-- Item 3: cliente DONO da transportadora — só ele edita o cadastro; outros clientes vinculados
-- (mesmo CNPJ, ou motorista dela que registrou pelo QR) só usam. Existentes: o primeiro vinculado.
ALTER TABLE "Transportadora" ADD COLUMN "organizacaoDonaId" INTEGER;
UPDATE "Transportadora" t SET "organizacaoDonaId" = (
  SELECT v."organizacaoId" FROM "TransportadoraOrganizacao" v WHERE v."transportadoraId" = t.id ORDER BY v."desde", v."organizacaoId" LIMIT 1
);

-- Item 6: o pedido de código SMS guarda a etiqueta usada e se o celular já era de um motorista
-- do cliente (os conhecidos não consomem o teto de números novos).
ALTER TABLE "CodigoAcessoMotorista" ADD COLUMN "etiquetaId" INTEGER, ADD COLUMN "conhecido" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "CodigoAcessoMotorista_etiquetaId_criadoEm_idx" ON "CodigoAcessoMotorista" ("etiquetaId", "criadoEm");
