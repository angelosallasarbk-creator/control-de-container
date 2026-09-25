-- Perfil Transportador: acessa só as telas do QR e registra a coleta ao ler a etiqueta.
ALTER TYPE "Perfil" ADD VALUE IF NOT EXISTS 'TRANSPORTADOR';
