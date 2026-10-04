-- v3.8: VIAGEM — o mesmo caminhão levando mais de um container (cada um com o seu QR e o seu
-- trajeto; podem ter sido coletados em lugares diferentes e ficar em pontos diferentes).
-- Um SMS de posição por viagem; a posição recebida vale para todos os containers dela.
-- Só acrescenta tabelas novas.

CREATE TABLE "Viagem" (
  "organizacaoId" INTEGER NOT NULL,
  "id" SERIAL NOT NULL,
  "motoristaId" INTEGER,
  "usuarioId" INTEGER,
  "placa" TEXT,
  "criadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "criadaPor" TEXT NOT NULL,
  "encerradaEm" TIMESTAMP(3),
  CONSTRAINT "Viagem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Viagem_organizacaoId_idx" ON "Viagem" ("organizacaoId");
CREATE UNIQUE INDEX "Viagem_id_organizacaoId_key" ON "Viagem" ("id", "organizacaoId");
ALTER TABLE "Viagem" ADD CONSTRAINT "Viagem_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Viagem" ADD CONSTRAINT "Viagem_motoristaId_fkey" FOREIGN KEY ("motoristaId") REFERENCES "Motorista" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Viagem" ADD CONSTRAINT "Viagem_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Viagem" ADD CONSTRAINT "Viagem_usuarioId_org_fkey" FOREIGN KEY ("usuarioId", "organizacaoId") REFERENCES "Usuario" ("id", "organizacaoId");

CREATE TABLE "ViagemContainer" (
  "organizacaoId" INTEGER NOT NULL,
  "id" SERIAL NOT NULL,
  "viagemId" INTEGER NOT NULL,
  "containerId" INTEGER NOT NULL,
  "entrouEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "saiuEm" TIMESTAMP(3),
  "motivoSaida" TEXT,
  CONSTRAINT "ViagemContainer_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ViagemContainer_organizacaoId_idx" ON "ViagemContainer" ("organizacaoId");
CREATE INDEX "ViagemContainer_viagemId_idx" ON "ViagemContainer" ("viagemId");
CREATE INDEX "ViagemContainer_containerId_idx" ON "ViagemContainer" ("containerId");
ALTER TABLE "ViagemContainer" ADD CONSTRAINT "ViagemContainer_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ViagemContainer" ADD CONSTRAINT "ViagemContainer_viagemId_fkey" FOREIGN KEY ("viagemId") REFERENCES "Viagem" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ViagemContainer" ADD CONSTRAINT "ViagemContainer_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Mesmo cliente garantido pelo banco (chaves compostas, como na v3.6).
ALTER TABLE "ViagemContainer" ADD CONSTRAINT "ViagemContainer_viagemId_org_fkey" FOREIGN KEY ("viagemId", "organizacaoId") REFERENCES "Viagem" ("id", "organizacaoId");
ALTER TABLE "ViagemContainer" ADD CONSTRAINT "ViagemContainer_containerId_org_fkey" FOREIGN KEY ("containerId", "organizacaoId") REFERENCES "Container" ("id", "organizacaoId");

-- Isolamento por organização (RLS), igual às outras tabelas de cliente.
ALTER TABLE "Viagem" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "Viagem" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);
ALTER TABLE "ViagemContainer" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "isolamento_organizacao" ON "ViagemContainer" USING (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int) WITH CHECK (current_setting('app.sistema', true) = 'on' OR "organizacaoId" = NULLIF(current_setting('app.org_id', true), '')::int);
