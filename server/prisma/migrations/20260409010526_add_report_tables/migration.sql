-- Migration: add_report_tables (VERSÃO FINAL MÍNIMA)
-- 
-- Estado do banco verificado em 2026-04-09:
-- ✅ status/source já convertidos para enum
-- ✅ AiInsight já existe
-- ✅ CompanyCategory já existe
-- ❌ ReportTemplate NÃO existe → criar
-- ❌ CustomIndicator NÃO existe → criar

-- CreateTable ReportTemplate
CREATE TABLE "ReportTemplate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Relatório Financeiro',
    "indicators" JSONB NOT NULL,
    "referenceMonth" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable CustomIndicator
CREATE TABLE "CustomIndicator" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "formula" TEXT NOT NULL,
    "queryTemplate" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomIndicator_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReportTemplate_companyId_key" ON "ReportTemplate"("companyId");
CREATE INDEX "ReportTemplate_companyId_idx" ON "ReportTemplate"("companyId");
CREATE INDEX "CustomIndicator_companyId_idx" ON "CustomIndicator"("companyId");
CREATE INDEX "CustomIndicator_companyId_isActive_idx" ON "CustomIndicator"("companyId", "isActive");

-- AddForeignKey
ALTER TABLE "ReportTemplate" ADD CONSTRAINT "ReportTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomIndicator" ADD CONSTRAINT "CustomIndicator_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
