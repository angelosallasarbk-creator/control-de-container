-- v3.13: guarda também o tempo de viagem do serviço de rota (perfil caminhão), usado no modo
-- "livre" da previsão de rota. Só acrescenta; as distâncias já guardadas (sem tempo) são
-- recalculadas sob demanda.
ALTER TABLE "DistanciaRota" ADD COLUMN "duracaoMin" DECIMAL(8,1);
