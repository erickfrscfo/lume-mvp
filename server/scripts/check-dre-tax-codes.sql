-- Diagnostico DRE: categorias de impostos nas transacoes atuais
--
-- Objetivo:
-- 1. Listar transacoes classificadas em categorias 8.x.
-- 2. Mostrar como cada codigo sera tratado no DRE apos a separacao:
--    - REVENUE_DEDUCTION: deduz da Receita Bruta para chegar a Receita Liquida
--    - INCOME_TAX: deduz depois do Resultado Operacional para chegar ao Resultado Liquido
--    - REVIEW: precisa revisao manual
-- 3. Resumir valores por empresa, mes e codigo.
--
-- Como executar:
-- psql "$DATABASE_URL" -f server/scripts/check-dre-tax-codes.sql

WITH tax_transactions AS (
  SELECT
    c.id AS company_id,
    c.name AS company_name,
    t.id AS transaction_id,
    t.date AS transaction_date,
    to_char(t.date, 'YYYY-MM') AS transaction_month,
    t.description,
    t.amount,
    t.status,
    t.tipo_transacao,
    cat.code AS category_code,
    cat.name AS category_name,
    CASE
      WHEN cat.code IN ('8.1', '8.2', '8.3', '8.4') THEN 'REVENUE_DEDUCTION'
      WHEN cat.code IN ('8.5', '8.7') THEN 'INCOME_TAX'
      WHEN cat.code LIKE '8.%' THEN 'REVIEW'
      ELSE 'NOT_TAX_GROUP'
    END AS dre_tax_treatment
  FROM "Transaction" t
  JOIN "Company" c ON c.id = t."companyId"
  LEFT JOIN "Category" cat ON cat.id = t."categoryId"
  WHERE
    t.tipo_transacao = 'EXPENSE'
    AND cat.code LIKE '8.%'
)

SELECT
  'DETAIL' AS section,
  company_name,
  transaction_month,
  category_code,
  category_name,
  dre_tax_treatment,
  status,
  transaction_date,
  transaction_id,
  description,
  amount
FROM tax_transactions
ORDER BY company_name, transaction_month DESC, category_code, transaction_date DESC;

WITH tax_transactions AS (
  SELECT
    c.name AS company_name,
    to_char(t.date, 'YYYY-MM') AS transaction_month,
    cat.code AS category_code,
    cat.name AS category_name,
    CASE
      WHEN cat.code IN ('8.1', '8.2', '8.3', '8.4') THEN 'REVENUE_DEDUCTION'
      WHEN cat.code IN ('8.5', '8.7') THEN 'INCOME_TAX'
      WHEN cat.code LIKE '8.%' THEN 'REVIEW'
      ELSE 'NOT_TAX_GROUP'
    END AS dre_tax_treatment,
    t.amount
  FROM "Transaction" t
  JOIN "Company" c ON c.id = t."companyId"
  LEFT JOIN "Category" cat ON cat.id = t."categoryId"
  WHERE
    t.tipo_transacao = 'EXPENSE'
    AND cat.code LIKE '8.%'
)

SELECT
  'SUMMARY' AS section,
  company_name,
  transaction_month,
  category_code,
  category_name,
  dre_tax_treatment,
  COUNT(*) AS transaction_count,
  SUM(amount) AS total_amount
FROM tax_transactions
GROUP BY
  company_name,
  transaction_month,
  category_code,
  category_name,
  dre_tax_treatment
ORDER BY company_name, transaction_month DESC, category_code;

