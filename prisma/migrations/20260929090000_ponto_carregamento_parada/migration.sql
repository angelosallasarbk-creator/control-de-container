-- v1.3: Ponto de Carregamento pode ser ponto de parada no trajeto (checkbox no cadastro). Só acréscimos.
-- AlterTable
ALTER TABLE "GrupoOperacao" ADD COLUMN     "podeSerParada" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "posicaoParada" "PosicaoParada",
ADD COLUMN     "tempoParadaHoras" DECIMAL(5,1);

