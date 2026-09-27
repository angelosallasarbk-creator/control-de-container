-- Motivo de cada pedido de posição (trecho crítico, intervalo personalizado ou pedido manual). Só acréscimos.
ALTER TABLE "SolicitacaoPosicao" ADD COLUMN "motivo" TEXT;
ALTER TABLE "MensagemSms" ADD COLUMN "motivo" TEXT;
