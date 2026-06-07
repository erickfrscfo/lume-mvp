-- Add OCR-extracted boleto terms and tax/withholding details to financial obligations.
ALTER TABLE "FinancialObligation"
ADD COLUMN "lateFeePercent" DECIMAL(5,2),
ADD COLUMN "paymentLimitDate" TIMESTAMP(3),
ADD COLUMN "taxDetails" JSONB,
ADD COLUMN "totalTaxAmount" DECIMAL(15,2),
ADD COLUMN "totalWithholdingAmount" DECIMAL(15,2);
