-- CreateEnum
CREATE TYPE "CounterpartyType" AS ENUM ('SUPPLIER', 'CLIENT', 'BOTH');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('PENDING', 'RECONCILED', 'DIVERGENT', 'PARTIAL');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('INVOICE', 'RECEIPT', 'BANK_STATEMENT', 'CONTRACT', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ReconciliationMethod" AS ENUM ('MANUAL', 'AUTO_EXACT', 'AUTO_FUZZY', 'AI_SUGGESTED');

-- CreateTable
CREATE TABLE "Counterparty" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "document" TEXT,
    "type" "CounterpartyType" NOT NULL DEFAULT 'SUPPLIER',
    "email" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Counterparty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionDetail" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "counterpartyId" TEXT,
    "reconciliationStatus" "ReconciliationStatus" NOT NULL DEFAULT 'PENDING',
    "dueDate" TIMESTAMP(3),
    "paymentDate" TIMESTAMP(3),
    "documentNumber" TEXT,
    "bankReference" TEXT,
    "notes" TEXT,
    "reconciledBy" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransactionDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "counterpartyId" TEXT,
    "type" "DocumentType" NOT NULL,
    "number" TEXT NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "description" TEXT,
    "fileUrl" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reconciliation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "transactionDetailId" TEXT NOT NULL,
    "documentId" TEXT,
    "method" "ReconciliationMethod" NOT NULL DEFAULT 'MANUAL',
    "confidence" DECIMAL(3,2),
    "notes" TEXT,
    "reconciledBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Counterparty_companyId_idx" ON "Counterparty"("companyId");

-- CreateIndex
CREATE INDEX "Counterparty_companyId_type_idx" ON "Counterparty"("companyId", "type");

-- CreateIndex
CREATE INDEX "Counterparty_document_idx" ON "Counterparty"("document");

-- CreateIndex
CREATE INDEX "TransactionDetail_reconciliationStatus_idx" ON "TransactionDetail"("reconciliationStatus");

-- CreateIndex
CREATE INDEX "TransactionDetail_counterpartyId_idx" ON "TransactionDetail"("counterpartyId");

-- CreateIndex
CREATE INDEX "TransactionDetail_dueDate_idx" ON "TransactionDetail"("dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionDetail_transactionId_key" ON "TransactionDetail"("transactionId");

-- CreateIndex
CREATE INDEX "Document_companyId_idx" ON "Document"("companyId");

-- CreateIndex
CREATE INDEX "Document_companyId_type_idx" ON "Document"("companyId", "type");

-- CreateIndex
CREATE INDEX "Document_counterpartyId_idx" ON "Document"("counterpartyId");

-- CreateIndex
CREATE INDEX "Document_number_idx" ON "Document"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Reconciliation_transactionDetailId_key" ON "Reconciliation"("transactionDetailId");

-- CreateIndex
CREATE UNIQUE INDEX "Reconciliation_documentId_key" ON "Reconciliation"("documentId");

-- CreateIndex
CREATE INDEX "Reconciliation_companyId_idx" ON "Reconciliation"("companyId");

-- CreateIndex
CREATE INDEX "Reconciliation_companyId_createdAt_idx" ON "Reconciliation"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "Counterparty" ADD CONSTRAINT "Counterparty_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionDetail" ADD CONSTRAINT "TransactionDetail_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionDetail" ADD CONSTRAINT "TransactionDetail_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_transactionDetailId_fkey" FOREIGN KEY ("transactionDetailId") REFERENCES "TransactionDetail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
