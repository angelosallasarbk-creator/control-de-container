-- Perfil Portaria: registra entrada/saída nos pontos de carregamento lendo o QR; consulta o Pátio.
ALTER TYPE "Perfil" ADD VALUE IF NOT EXISTS 'PORTARIA';
