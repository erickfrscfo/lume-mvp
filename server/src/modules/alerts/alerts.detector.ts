/**
 * CAMADA 1 — DETECÇÃO DE ALERTAS (sem IA, 100% código)
 * 
 * Detecta anomalias e oportunidades nos dados financeiros usando
 * queries SQL e regras de negócio em TypeScript.
 * 
 * Tipos implementados:
 * - 3.1 Anomalia de Gastos (EXPENSE_SPIKE / EXPENSE_DROP)
 * - 3.3 Oportunidade de Negociação (NEGOTIATION_OPPORTUNITY)
 * - 3.5 Sazonalidade (SEASONAL_ANOMALY / SEASONAL_OPPORTUNITY)
 */

import { prisma } from "../../shared/database.js";

export interface RawAlert {
  type: "EXPENSE_SPIKE" | "EXPENSE_DROP" | "NEGOTIATION_OPPORTUNITY" | "SEASONAL_ANOMALY" | "SEASONAL_OPPORTUNITY";
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  title: string;
  category?: string;
  potentialSavings?: number;
  data: Record<string, any>;
}

// ============================================
// 3.1 — ANOMALIA DE GASTOS
// Detecta quando uma categoria de despesa sobe >20% ou desce >30%
// em relação à média dos meses anteriores
// ============================================
export async function detectExpenseAnomalies(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];

  // Buscar transações dos últimos 6 meses com categoria
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const transactions = await prisma.transaction.findMany({
    where: {
      companyId,
      type: "EXPENSE",
      date: { gte: sixMonthsAgo },
      categoryId: { not: null },
    },
    include: { category: true },
  });

  if (transactions.length === 0) return alerts;

  // Agrupar por categoria e mês
  const byCategoryMonth: Record<string, Record<string, number>> = {};
  transactions.forEach((t) => {
    const catKey = t.category ? `${t.category.code} - ${t.category.name}` : "Sem categoria";
    const monthKey = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`;
    if (!byCategoryMonth[catKey]) byCategoryMonth[catKey] = {};
    byCategoryMonth[catKey][monthKey] = (byCategoryMonth[catKey][monthKey] || 0) + Number(t.amount);
  });

  // Para cada categoria, comparar o mês mais recente com a média dos anteriores
  for (const [category, monthlyData] of Object.entries(byCategoryMonth)) {
    const months = Object.entries(monthlyData).sort(([a], [b]) => a.localeCompare(b));
    if (months.length < 3) continue; // Precisa de pelo menos 3 meses para comparar

    const current = months[months.length - 1];
    const previous = months.slice(0, -1);
    const avg = previous.reduce((sum, [, val]) => sum + val, 0) / previous.length;

    if (avg === 0) continue;

    const variation = ((current[1] - avg) / avg) * 100;

    // Aumento anormal (>20%)
    if (variation > 20) {
      const severity = variation > 50 ? "HIGH" : "MEDIUM";
      alerts.push({
        type: "EXPENSE_SPIKE",
        severity,
        title: `${category.split(" - ")[1] || category} subiu ${Math.round(variation)}%`,
        category,
        data: {
          category,
          currentMonth: current[0],
          currentValue: Math.round(current[1] * 100) / 100,
          average: Math.round(avg * 100) / 100,
          variation: Math.round(variation * 10) / 10,
          previousMonths: previous.map(([m, v]) => ({ month: m, value: Math.round(v * 100) / 100 })),
        },
      });
    }

    // Redução significativa (>30%) — alerta positivo
    if (variation < -30) {
      alerts.push({
        type: "EXPENSE_DROP",
        severity: "LOW",
        title: `${category.split(" - ")[1] || category} caiu ${Math.round(Math.abs(variation))}%`,
        category,
        data: {
          category,
          currentMonth: current[0],
          currentValue: Math.round(current[1] * 100) / 100,
          average: Math.round(avg * 100) / 100,
          variation: Math.round(variation * 10) / 10,
          savings: Math.round((avg - current[1]) * 100) / 100,
        },
      });
    }
  }

  return alerts;
}

// ============================================
// 3.3 — OPORTUNIDADE DE NEGOCIAÇÃO
// Detecta fornecedores recorrentes com volume suficiente
// para renegociação de preços
// ============================================
export async function detectNegotiationOpportunities(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];

  // Buscar transações de despesa dos últimos 12 meses
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  const transactions = await prisma.transaction.findMany({
    where: {
      companyId,
      type: "EXPENSE",
      date: { gte: twelveMonthsAgo },
    },
    orderBy: { date: "asc" },
  });

  if (transactions.length === 0) return alerts;

  // Agrupar por descrição (proxy para fornecedor) e mês
  const bySupplier: Record<string, Record<string, number>> = {};
  transactions.forEach((t) => {
    // Normalizar descrição para agrupar (remover números, datas, etc.)
    const supplier = normalizeSupplierName(t.description);
    const monthKey = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`;
    if (!bySupplier[supplier]) bySupplier[supplier] = {};
    bySupplier[supplier][monthKey] = (bySupplier[supplier][monthKey] || 0) + Number(t.amount);
  });

  for (const [supplier, monthlyData] of Object.entries(bySupplier)) {
    const months = Object.keys(monthlyData).sort();
    if (months.length < 4) continue; // Precisa de pelo menos 4 meses

    // Verificar meses consecutivos
    const consecutiveMonths = countConsecutiveMonths(months);
    const totalValue = Object.values(monthlyData).reduce((s, v) => s + v, 0);
    const avgMonthly = totalValue / months.length;

    // Se >= 4 meses consecutivos E valor mensal > R$ 3.000
    if (consecutiveMonths >= 4 && avgMonthly > 3000) {
      const discountMin = Math.round(avgMonthly * 0.05 * 12); // 5% ao ano
      const discountMax = Math.round(avgMonthly * 0.08 * 12); // 8% ao ano

      alerts.push({
        type: "NEGOTIATION_OPPORTUNITY",
        severity: avgMonthly > 10000 ? "HIGH" : "MEDIUM",
        title: `Renegociar com ${supplier}`,
        potentialSavings: discountMin,
        data: {
          supplier,
          monthsConsecutive: consecutiveMonths,
          totalMonths: months.length,
          avgMonthlyValue: Math.round(avgMonthly * 100) / 100,
          totalValue: Math.round(totalValue * 100) / 100,
          estimatedDiscount: { min: discountMin, max: discountMax },
          discountRange: "5-8%",
          monthlyHistory: months.map((m) => ({ month: m, value: Math.round(monthlyData[m] * 100) / 100 })),
        },
      });
    }
  }

  // Ordenar por potencial de economia (maior primeiro)
  alerts.sort((a, b) => (b.potentialSavings || 0) - (a.potentialSavings || 0));

  // Limitar a 5 oportunidades mais relevantes
  return alerts.slice(0, 5);
}

// ============================================
// 3.5 — SAZONALIDADE
// Compara receita e despesa do mês mais recente com o mesmo
// mês do ano anterior (quando houver dados)
// ============================================
export async function detectSeasonalAnomalies(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];

  // Buscar transações dos últimos 14 meses (para ter o mesmo mês do ano passado)
  const fourteenMonthsAgo = new Date();
  fourteenMonthsAgo.setMonth(fourteenMonthsAgo.getMonth() - 14);

  const transactions = await prisma.transaction.findMany({
    where: {
      companyId,
      date: { gte: fourteenMonthsAgo },
    },
    orderBy: { date: "asc" },
  });

  if (transactions.length === 0) return alerts;

  // Agrupar por mês
  const monthlyData: Record<string, { income: number; expense: number }> = {};
  transactions.forEach((t) => {
    const monthKey = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`;
    if (!monthlyData[monthKey]) monthlyData[monthKey] = { income: 0, expense: 0 };
    if (t.type === "INCOME") {
      monthlyData[monthKey].income += Number(t.amount);
    } else {
      monthlyData[monthKey].expense += Number(t.amount);
    }
  });

  const months = Object.keys(monthlyData).sort();
  if (months.length < 2) return alerts;

  // Pegar o mês mais recente com dados
  const currentMonthKey = months[months.length - 1];
  const currentData = monthlyData[currentMonthKey];

  // Encontrar o mesmo mês do ano anterior
  const [year, month] = currentMonthKey.split("-").map(Number);
  const sameMonthLastYear = `${year - 1}-${String(month).padStart(2, "0")}`;
  const lastYearData = monthlyData[sameMonthLastYear];

  if (lastYearData) {
    // Comparar receita
    if (lastYearData.income > 0) {
      const revenueVariation = ((currentData.income - lastYearData.income) / lastYearData.income) * 100;

      if (revenueVariation < -15) {
        alerts.push({
          type: "SEASONAL_ANOMALY",
          severity: revenueVariation < -30 ? "HIGH" : "MEDIUM",
          title: `Receita ${Math.round(Math.abs(revenueVariation))}% abaixo do mesmo período do ano passado`,
          data: {
            metric: "revenue",
            currentMonth: currentMonthKey,
            currentValue: Math.round(currentData.income * 100) / 100,
            sameMonthLastYear,
            lastYearValue: Math.round(lastYearData.income * 100) / 100,
            variation: Math.round(revenueVariation * 10) / 10,
            difference: Math.round((currentData.income - lastYearData.income) * 100) / 100,
          },
        });
      }

      if (revenueVariation > 30) {
        alerts.push({
          type: "SEASONAL_OPPORTUNITY",
          severity: "LOW",
          title: `Receita ${Math.round(revenueVariation)}% acima do mesmo período do ano passado`,
          data: {
            metric: "revenue",
            currentMonth: currentMonthKey,
            currentValue: Math.round(currentData.income * 100) / 100,
            sameMonthLastYear,
            lastYearValue: Math.round(lastYearData.income * 100) / 100,
            variation: Math.round(revenueVariation * 10) / 10,
            difference: Math.round((currentData.income - lastYearData.income) * 100) / 100,
          },
        });
      }
    }

    // Comparar despesa
    if (lastYearData.expense > 0) {
      const expenseVariation = ((currentData.expense - lastYearData.expense) / lastYearData.expense) * 100;

      if (expenseVariation > 20) {
        alerts.push({
          type: "SEASONAL_ANOMALY",
          severity: expenseVariation > 40 ? "HIGH" : "MEDIUM",
          title: `Despesas ${Math.round(expenseVariation)}% acima do mesmo período do ano passado`,
          data: {
            metric: "expense",
            currentMonth: currentMonthKey,
            currentValue: Math.round(currentData.expense * 100) / 100,
            sameMonthLastYear,
            lastYearValue: Math.round(lastYearData.expense * 100) / 100,
            variation: Math.round(expenseVariation * 10) / 10,
            difference: Math.round((currentData.expense - lastYearData.expense) * 100) / 100,
          },
        });
      }
    }
  } else {
    // Sem dados do ano anterior — comparar com a média dos meses disponíveis
    if (months.length >= 4) {
      const previousMonths = months.slice(0, -1);
      const avgIncome = previousMonths.reduce((s, m) => s + monthlyData[m].income, 0) / previousMonths.length;
      const avgExpense = previousMonths.reduce((s, m) => s + monthlyData[m].expense, 0) / previousMonths.length;

      if (avgIncome > 0) {
        const revenueVariation = ((currentData.income - avgIncome) / avgIncome) * 100;
        if (revenueVariation < -20) {
          alerts.push({
            type: "SEASONAL_ANOMALY",
            severity: revenueVariation < -35 ? "HIGH" : "MEDIUM",
            title: `Receita ${Math.round(Math.abs(revenueVariation))}% abaixo da média histórica`,
            data: {
              metric: "revenue",
              currentMonth: currentMonthKey,
              currentValue: Math.round(currentData.income * 100) / 100,
              averageValue: Math.round(avgIncome * 100) / 100,
              variation: Math.round(revenueVariation * 10) / 10,
              comparisonType: "average",
            },
          });
        }
      }

      if (avgExpense > 0) {
        const expenseVariation = ((currentData.expense - avgExpense) / avgExpense) * 100;
        if (expenseVariation > 25) {
          alerts.push({
            type: "SEASONAL_ANOMALY",
            severity: expenseVariation > 45 ? "HIGH" : "MEDIUM",
            title: `Despesas ${Math.round(expenseVariation)}% acima da média histórica`,
            data: {
              metric: "expense",
              currentMonth: currentMonthKey,
              currentValue: Math.round(currentData.expense * 100) / 100,
              averageValue: Math.round(avgExpense * 100) / 100,
              variation: Math.round(expenseVariation * 10) / 10,
              comparisonType: "average",
            },
          });
        }
      }
    }
  }

  return alerts;
}

// ============================================
// FUNÇÃO PRINCIPAL — Executa todos os detectores
// ============================================
export async function detectAllAlerts(companyId: string): Promise<RawAlert[]> {
  const [expenseAlerts, negotiationAlerts, seasonalAlerts] = await Promise.all([
    detectExpenseAnomalies(companyId),
    detectNegotiationOpportunities(companyId),
    detectSeasonalAnomalies(companyId),
  ]);

  return [...expenseAlerts, ...negotiationAlerts, ...seasonalAlerts];
}

// ============================================
// HELPERS
// ============================================

/**
 * Normaliza nome de fornecedor para agrupar transações similares.
 * Remove números, datas, e caracteres especiais para encontrar o "core" do nome.
 */
function normalizeSupplierName(description: string): string {
  return description
    .toUpperCase()
    .replace(/\d{2}\/\d{2}\/\d{4}/g, "") // Remove datas DD/MM/YYYY
    .replace(/\d{2}\/\d{2}/g, "")         // Remove datas DD/MM
    .replace(/NF\s*\d+/gi, "")            // Remove "NF 12345"
    .replace(/PARCELA\s*\d+/gi, "")       // Remove "PARCELA 3"
    .replace(/\d+\/\d+/g, "")             // Remove "3/12"
    .replace(/REF\s*\w+/gi, "")           // Remove "REF JAN"
    .replace(/[^\w\s]/g, "")              // Remove caracteres especiais
    .replace(/\s+/g, " ")                 // Normaliza espaços
    .trim();
}

/**
 * Conta o número máximo de meses consecutivos em uma lista de meses ordenados.
 */
function countConsecutiveMonths(sortedMonths: string[]): number {
  if (sortedMonths.length <= 1) return sortedMonths.length;

  let maxConsecutive = 1;
  let currentConsecutive = 1;

  for (let i = 1; i < sortedMonths.length; i++) {
    const [prevYear, prevMonth] = sortedMonths[i - 1].split("-").map(Number);
    const [currYear, currMonth] = sortedMonths[i].split("-").map(Number);

    // Calcular diferença em meses
    const diffMonths = (currYear - prevYear) * 12 + (currMonth - prevMonth);

    if (diffMonths === 1) {
      currentConsecutive++;
      maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
    } else {
      currentConsecutive = 1;
    }
  }

  return maxConsecutive;
}
