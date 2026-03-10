-- ============================================
-- Migration: Adicionar modelos de Conciliação
-- Novos modelos: Counterparty, TransactionDetail, Document
-- Novos campos em Transaction: counterpartyId, status, source
-- ============================================

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CounterpartyType" AS ENUM ('SUPPLIER', 'CLIENT', 'BOTH');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable: Counterparty
CREATE TABLE IF NOT EXISTS "Counterparty" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "document" TEXT,
    "type" "CounterpartyType" NOT NULL DEFAULT 'SUPPLIER',
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Counterparty_pkey" PRIMARY KEY ("id")
);

-- CreateTable: TransactionDetail
CREATE TABLE IF NOT EXISTS "TransactionDetail" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "reconciliationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "dueDate" TIMESTAMP(3),
    "paymentDate" TIMESTAMP(3),
    "receiptDate" TIMESTAMP(3),
    "documentNumber" TEXT,
    "bankReference" TEXT,
    "amountOriginal" DECIMAL(15,2),
    "amountPaid" DECIMAL(15,2),
    "amountReceived" DECIMAL(15,2),
    "discount" DECIMAL(15,2),
    "interest" DECIMAL(15,2),
    "counterpartyId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransactionDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Document
CREATE TABLE IF NOT EXISTS "Document" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(15,2),
    "issueDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "counterpartyId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- Adicionar novos campos em Transaction (se não existirem)
DO $$ BEGIN
  ALTER TABLE "Transaction" ADD COLUMN "counterpartyId" TEXT;
EXCEPTION
  WHEN duplicate_column THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "Transaction" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PENDING';
EXCEPTION
  WHEN duplicate_column THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "Transaction" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'CSV';
EXCEPTION
  WHEN duplicate_column THEN null;
END $$;

-- CreateIndex: Counterparty
CREATE INDEX IF NOT EXISTS "Counterparty_companyId_idx" ON "Counterparty"("companyId");
CREATE INDEX IF NOT EXISTS "Counterparty_companyId_isActive_idx" ON "Counterparty"("companyId", "isActive");
CREATE INDEX IF NOT EXISTS "Counterparty_companyId_type_idx" ON "Counterparty"("companyId", "type");

-- CreateIndex: TransactionDetail
CREATE UNIQUE INDEX IF NOT EXISTS "TransactionDetail_transactionId_key" ON "TransactionDetail"("transactionId");
CREATE INDEX IF NOT EXISTS "TransactionDetail_reconciliationStatus_idx" ON "TransactionDetail"("reconciliationStatus");
CREATE INDEX IF NOT EXISTS "TransactionDetail_counterpartyId_idx" ON "TransactionDetail"("counterpartyId");

-- CreateIndex: Document
CREATE INDEX IF NOT EXISTS "Document_companyId_idx" ON "Document"("companyId");
CREATE INDEX IF NOT EXISTS "Document_companyId_type_idx" ON "Document"("companyId", "type");
CREATE INDEX IF NOT EXISTS "Document_counterpartyId_idx" ON "Document"("counterpartyId");

-- CreateIndex: Transaction novos índices
CREATE INDEX IF NOT EXISTS "Transaction_counterpartyId_idx" ON "Transaction"("counterpartyId");
CREATE INDEX IF NOT EXISTS "Transaction_status_idx" ON "Transaction"("status");

-- AddForeignKey: Counterparty -> Company
DO $$ BEGIN
  ALTER TABLE "Counterparty" ADD CONSTRAINT "Counterparty_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey: TransactionDetail -> Transaction
DO $$ BEGIN
  ALTER TABLE "TransactionDetail" ADD CONSTRAINT "TransactionDetail_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey: TransactionDetail -> Counterparty
DO $$ BEGIN
  ALTER TABLE "TransactionDetail" ADD CONSTRAINT "TransactionDetail_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey: Document -> Company
DO $$ BEGIN
  ALTER TABLE "Document" ADD CONSTRAINT "Document_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey: Document -> Counterparty
DO $$ BEGIN
  ALTER TABLE "Document" ADD CONSTRAINT "Document_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey: Transaction -> Counterparty
DO $$ BEGIN
  ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
