-- Add installment support for financial obligations.
CREATE TABLE "ObligationInstallment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "installmentNumber" INTEGER NOT NULL DEFAULT 1,
    "totalInstallments" INTEGER NOT NULL DEFAULT 1,
    "status" "ObligationStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(15,2) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "expectedPaymentDate" TIMESTAMP(3),
    "documentNumber" TEXT,
    "barcode" TEXT,
    "earlyDiscountAmount" DECIMAL(15,2),
    "earlyDiscountPercent" DECIMAL(5,2),
    "earlyDiscountValidUntil" TIMESTAMP(3),
    "lateFeeAmount" DECIMAL(15,2),
    "lateFeePercent" DECIMAL(5,2),
    "lateInterestPercentPerDay" DECIMAL(5,2),
    "paymentLimitDate" TIMESTAMP(3),
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ObligationInstallment_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "FinancialObligation"
ADD COLUMN "totalInstallments" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Transaction"
ADD COLUMN "installmentId" TEXT;

ALTER TABLE "ObligationDocument"
ADD COLUMN "installmentId" TEXT;

INSERT INTO "ObligationInstallment" (
    "id",
    "companyId",
    "obligationId",
    "installmentNumber",
    "totalInstallments",
    "status",
    "amount",
    "dueDate",
    "expectedPaymentDate",
    "documentNumber",
    "barcode",
    "earlyDiscountAmount",
    "earlyDiscountPercent",
    "earlyDiscountValidUntil",
    "lateFeeAmount",
    "lateFeePercent",
    "lateInterestPercentPerDay",
    "paymentLimitDate",
    "confidence",
    "createdAt",
    "updatedAt"
)
SELECT
    concat("id", '-001'),
    "companyId",
    "id",
    1,
    1,
    "status",
    "amount",
    "dueDate",
    "expectedPaymentDate",
    "documentNumber",
    "barcode",
    "earlyDiscountAmount",
    "earlyDiscountPercent",
    "earlyDiscountValidUntil",
    "lateFeeAmount",
    "lateFeePercent",
    "lateInterestPercentPerDay",
    "paymentLimitDate",
    "confidence",
    "createdAt",
    CURRENT_TIMESTAMP
FROM "FinancialObligation";

UPDATE "Transaction"
SET "installmentId" = concat("obligationId", '-001')
WHERE "obligationId" IS NOT NULL;

UPDATE "ObligationDocument"
SET "installmentId" = concat("obligationId", '-001')
WHERE "obligationId" IS NOT NULL;

CREATE UNIQUE INDEX "ObligationInstallment_obligationId_installmentNumber_key" ON "ObligationInstallment"("obligationId", "installmentNumber");
CREATE INDEX "ObligationInstallment_companyId_idx" ON "ObligationInstallment"("companyId");
CREATE INDEX "ObligationInstallment_companyId_status_idx" ON "ObligationInstallment"("companyId", "status");
CREATE INDEX "ObligationInstallment_dueDate_idx" ON "ObligationInstallment"("dueDate");
CREATE INDEX "ObligationInstallment_barcode_idx" ON "ObligationInstallment"("barcode");
CREATE INDEX "Transaction_installmentId_idx" ON "Transaction"("installmentId");
CREATE INDEX "ObligationDocument_installmentId_idx" ON "ObligationDocument"("installmentId");

ALTER TABLE "ObligationInstallment" ADD CONSTRAINT "ObligationInstallment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ObligationInstallment" ADD CONSTRAINT "ObligationInstallment_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "FinancialObligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "ObligationInstallment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ObligationDocument" ADD CONSTRAINT "ObligationDocument_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "ObligationInstallment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
