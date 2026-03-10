-- Migration: Converter campo sector de String para enum CompanySector
-- Seguro para rodar múltiplas vezes (idempotente)

-- 1. Criar o enum CompanySector se não existir
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CompanySector') THEN
    CREATE TYPE "CompanySector" AS ENUM ('VAREJO', 'SERVICOS', 'INDUSTRIA', 'SAAS', 'MISTO');
  END IF;
END $$;

-- 2. Normalizar valores existentes antes da conversão
UPDATE "Company" SET sector = 'MISTO' WHERE sector IS NULL OR sector = '';
UPDATE "Company" SET sector = 'SERVICOS' WHERE LOWER(sector) IN ('serviços', 'servicos', 'consultoria', 'serviço', 'servico');
UPDATE "Company" SET sector = 'SAAS' WHERE LOWER(sector) IN ('saas', 'tecnologia', 'tech', 'software', 'ti');
UPDATE "Company" SET sector = 'VAREJO' WHERE LOWER(sector) IN ('varejo', 'comércio', 'comercio', 'loja', 'retail');
UPDATE "Company" SET sector = 'INDUSTRIA' WHERE LOWER(sector) IN ('indústria', 'industria', 'manufatura', 'fábrica', 'fabrica');
-- Qualquer valor não mapeado vira MISTO
UPDATE "Company" SET sector = 'MISTO' WHERE sector NOT IN ('VAREJO', 'SERVICOS', 'INDUSTRIA', 'SAAS', 'MISTO');

-- 3. Converter a coluna de TEXT para enum
-- Primeiro renomear a coluna antiga
ALTER TABLE "Company" RENAME COLUMN "sector" TO "sector_old";

-- Criar a nova coluna com o tipo enum
ALTER TABLE "Company" ADD COLUMN "sector" "CompanySector" NOT NULL DEFAULT 'MISTO';

-- Copiar os valores
UPDATE "Company" SET "sector" = "sector_old"::"CompanySector";

-- Remover a coluna antiga
ALTER TABLE "Company" DROP COLUMN "sector_old";
