-- CreateEnum
CREATE TYPE "ObligationType" AS ENUM ('PAYABLE', 'RECEIVABLE');

-- CreateEnum
CREATE TYPE "ObligationStatus" AS ENUM ('PENDING', 'PAID', 'OVERDUE', 'PARTIAL', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ObligationSource" AS ENUM ('OCR', 'MANUAL', 'ERP');

-- CreateEnum
CREATE TYPE "DocumentRole" AS ENUM ('FISCAL_ONLY', 'FISCAL_AND_CHARGE', 'PAYMENT_INSTRUMENT', 'UTILITY_BILL', 'PAYMENT_PROOF', 'CONTRACT', 'OTHER');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "obligationId" TEXT;

-- CreateTable
CREATE TABLE "FinancialObligation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "ObligationType" NOT NULL,
    "status" "ObligationStatus" NOT NULL DEFAULT 'PENDING',
    "source" "ObligationSource" NOT NULL DEFAULT 'OCR',
    "description" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "issueDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "expectedPaymentDate" TIMESTAMP(3),
    "documentNumber" TEXT,
    "barcode" TEXT,
    "earlyDiscountAmount" DECIMAL(15,2),
    "earlyDiscountPercent" DECIMAL(5,2),
    "earlyDiscountValidUntil" TIMESTAMP(3),
    "lateFeeAmount" DECIMAL(15,2),
    "lateInterestPercentPerDay" DECIMAL(5,2),
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "counterpartyId" TEXT,
    "categoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObligationDocument" (
    "id" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "role" "DocumentRole" NOT NULL,
    "matchConfidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObligationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Transaction_obligationId_idx" ON "Transaction"("obligationId");

-- CreateIndex
CREATE INDEX "FinancialObligation_companyId_idx" ON "FinancialObligation"("companyId");

-- CreateIndex
CREATE INDEX "FinancialObligation_companyId_status_idx" ON "FinancialObligation"("companyId", "status");

-- CreateIndex
CREATE INDEX "FinancialObligation_companyId_type_idx" ON "FinancialObligation"("companyId", "type");

-- CreateIndex
CREATE INDEX "FinancialObligation_counterpartyId_idx" ON "FinancialObligation"("counterpartyId");

-- CreateIndex
CREATE INDEX "FinancialObligation_dueDate_idx" ON "FinancialObligation"("dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "ObligationDocument_obligationId_documentId_key" ON "ObligationDocument"("obligationId", "documentId");

-- CreateIndex
CREATE INDEX "ObligationDocument_obligationId_idx" ON "ObligationDocument"("obligationId");

-- CreateIndex
CREATE INDEX "ObligationDocument_documentId_idx" ON "ObligationDocument"("documentId");

-- CreateIndex
CREATE INDEX "ObligationDocument_role_idx" ON "ObligationDocument"("role");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "FinancialObligation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialObligation" ADD CONSTRAINT "FinancialObligation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialObligation" ADD CONSTRAINT "FinancialObligation_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialObligation" ADD CONSTRAINT "FinancialObligation_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObligationDocument" ADD CONSTRAINT "ObligationDocument_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "FinancialObligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObligationDocument" ADD CONSTRAINT "ObligationDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
