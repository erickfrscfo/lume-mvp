import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../../shared/database.js";
import { authMiddleware } from "../auth/auth.middleware.js";
import { getDREProfile, isDirectCost, isTax } from "../../shared/dre-profiles.js";

const router = Router();
router.use(authMiddleware);

// ============================================
// TYPES
// ============================================
interface MonthlyData {
  month: string; // "YYYY-MM"
  income: number;
  expense: number;
  cmv: number;
  taxes: number;
  fixed: number;
  variable: number;
  net: number;
}

interface ForecastPoint {
  month: string;
  income: number;
  expense: number;
  cmv: number;
  taxes: number;
  fixed: number;
  variable: number;
  net: number;
  isForecast: true;
  scenario: string;
  // NOVO: compromissos pendentes já registrados para este mês
  pendingIncome?: number;
  pendingExpense?: number;
}

interface ForecastResponse {
  success: boolean;
  data: {
    historical: MonthlyData[];
    forecast: ForecastPoint[];
    metadata: {
      forecastAvailable: boolean;
      historicalMonths: number;
      minimumRequired: number;
      drivers: {
        avgCmvPercent: number;
        avgTaxPercent: number;
        avgFixed: number;
        avgVariable: number;
        revenueGrowthRate: number;
      };
      scenario: string;
    };
  };
}

// ============================================
// HELPERS
// ============================================

function formatMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Obter data efetiva de caixa
 * Para EXPENSE: paymentDate (fallback: transaction.date)
 * Para INCOME: receiptDate (fallback: transaction.date)
 */
function getEffectiveDate(tx: any): Date {
  if (tx.tipo_transacao === "EXPENSE") {
    return tx.detail?.paymentDate || tx.date;
  } else {
    return tx.detail?.receiptDate || tx.date;
  }
}

/**
 * Calcula a tendência de receita usando regressão linear simples
 * Retorna: taxa de crescimento mensal (ex: 0.02 = +2%/mês)
 */
function calculateRevenueGrowthRate(monthlyIncomes: number[]): number {
  const n = monthlyIncomes.length;
  if (n < 3) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += monthlyIncomes[i];
    sumXY += i * monthlyIncomes[i];
    sumX2 += i * i;
  }

  const avgY = sumY / n;
  const b = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  if (avgY === 0) return 0;
  const growthRate = b / avgY;

  // Limitar entre -15% e +15% por mês para evitar projeções absurdas
  return Math.max(-0.15, Math.min(0.15, growthRate));
}

/**
 * Calcula média ponderada dos últimos N meses (mais recentes têm mais peso)
 */
function weightedAverage(values: number[], weights?: number[]): number {
  if (values.length === 0) return 0;
  if (!weights) {
    weights = values.map((_, i) => i + 1);
  }
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight === 0) return 0;
  return values.reduce((s, v, i) => s + v * weights![i], 0) / totalWeight;
}

/**
 * Gera o próximo mês no formato "YYYY-MM"
 */
function nextMonth(month: string, offset: number): string {
  const [y, m] = month.split("-").map(Number);
  const date = new Date(y, m - 1 + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Retorna o mês atual no formato "YYYY-MM"
 */
function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// ============================================
// SCENARIO MULTIPLIERS
// ============================================
const SCENARIO_CONFIG = {
  realistic: {
    revenueMultiplier: 1.0,
    cmvAdjust: 0,
    expenseMultiplier: 1.0,
  },
  optimistic: {
    revenueMultiplier: 1.15,
    cmvAdjust: -0.02,
    expenseMultiplier: 0.95,
  },
  pessimistic: {
    revenueMultiplier: 0.85,
    cmvAdjust: 0.02,
    expenseMultiplier: 1.10,
  },
};

// ============================================
// MAIN ENDPOINT: GET /api/forecast
// REGIME DE CAIXA: histórico usa apenas COMPLETED com data efetiva
// Projeções consideram transações PENDING com dueDate futuro
// ============================================
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user?.companyId) {
      return res.status(400).json({ success: false, error: "Empresa não encontrada" });
    }

    const companyId = user.companyId;
    const months = parseInt(req.query.months as string) || 6;
    const scenario = (req.query.scenario as string) || "realistic";

    // Buscar setor da empresa para perfil de DRE dinâmico
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { sector: true },
    });
    const dreProfile = getDREProfile(company?.sector || "MISTO");

    if (!["realistic", "optimistic", "pessimistic"].includes(scenario)) {
      return res.status(400).json({ success: false, error: "Cenário inválido. Use: realistic, optimistic, pessimistic" });
    }

    const scenarioConfig = SCENARIO_CONFIG[scenario as keyof typeof SCENARIO_CONFIG];

    // ============================================
    // 1. BUSCAR TRANSAÇÕES HISTÓRICAS (COMPLETED, últimos 12 meses)
    //    Usando data efetiva de caixa
    // ============================================
    const currentMonth = getCurrentMonth();
    const twelveMonthsAgo = nextMonth(currentMonth, -12);
    const twelveMonthsAgoDate = new Date(`${twelveMonthsAgo}-01`);

    const completedTransactions = await prisma.transaction.findMany({
      where: {
        companyId,
        status: "COMPLETED",
      },
      include: {
        category: { select: { code: true, name: true } },
        detail: true,
      },
      orderBy: { date: "asc" },
    });

    // ============================================
    // 2. AGREGAR POR MÊS USANDO DATA EFETIVA
    // ============================================
    const monthlyMap = new Map<string, MonthlyData>();

    for (const tx of completedTransactions) {
      const effectiveDate = getEffectiveDate(tx);
      if (effectiveDate < twelveMonthsAgoDate) continue; // Fora do período

      const monthKey = formatMonthKey(effectiveDate);

      if (!monthlyMap.has(monthKey)) {
        monthlyMap.set(monthKey, {
          month: monthKey,
          income: 0,
          expense: 0,
          cmv: 0,
          taxes: 0,
          fixed: 0,
          variable: 0,
          net: 0,
        });
      }

      const data = monthlyMap.get(monthKey)!;
      const amount = Math.abs(Number(tx.amount));
      const tipoTransacao = tx.tipo_transacao;
      const tipoCusto = tx.tipo_custo;
      const categoryCode = tx.category?.code || "";

      if (tipoTransacao === "INCOME") {
        data.income += amount;
      } else {
        data.expense += amount;

        // Classificar por grupo DRE usando perfil dinâmico
        if (isDirectCost(categoryCode, dreProfile)) {
          data.cmv += amount;
        } else if (isTax(categoryCode, dreProfile)) {
          data.taxes += amount;
        } else if (tipoCusto === "FIXO") {
          data.fixed += amount;
        } else if (tipoCusto === "VARIAVEL") {
          data.variable += amount;
        } else {
          if (categoryCode.startsWith("4.") || categoryCode.startsWith("5.")) {
            data.fixed += amount;
          } else if (categoryCode.startsWith("6.") || categoryCode.startsWith("7.")) {
            data.variable += amount;
          } else {
            data.variable += amount;
          }
        }
      }

      data.net = data.income - data.expense;
    }

    // ============================================
    // CORREÇÃO 1: Excluir mês corrente (incompleto) do historical
    // Apenas meses completos (month < currentMonth) entram no cálculo dos drivers.
    // O mês corrente ainda pode ter transações parciais que distorcem
    // todos os indicadores (CMV%, crescimento, receita base).
    // ============================================
    const historical = Array.from(monthlyMap.values())
      .filter(m => m.month < currentMonth) // EXCLUIR mês corrente (incompleto)
      .sort((a, b) => a.month.localeCompare(b.month));

    // Manter o mês corrente separado para incluir no response (visualização no gráfico)
    const currentMonthData = monthlyMap.get(currentMonth);

    // ============================================
    // 3. VERIFICAR MÍNIMO DE DADOS
    // ============================================
    const MIN_MONTHS = 3;
    if (historical.length < MIN_MONTHS) {
      return res.json({
        success: true,
        data: {
          historical: currentMonthData
            ? [...historical, currentMonthData] // Incluir mês corrente na visualização
            : historical,
          forecast: [],
          metadata: {
            forecastAvailable: false,
            historicalMonths: historical.length,
            minimumRequired: MIN_MONTHS,
            drivers: {
              avgCmvPercent: 0,
              avgTaxPercent: 0,
              avgFixed: 0,
              avgVariable: 0,
              revenueGrowthRate: 0,
            },
            scenario,
          },
        },
      } as ForecastResponse);
    }

    // ============================================
    // 4. CALCULAR DRIVERS (baseados apenas em meses COMPLETOS)
    // ============================================
    const recentMonths = historical.slice(-6);
    const last3Months = historical.slice(-3);

    const incomes = historical.map(m => m.income);
    const revenueGrowthRate = calculateRevenueGrowthRate(incomes);

    const cmvPercents = recentMonths
      .filter(m => m.income > 0)
      .map(m => m.cmv / m.income);
    const avgCmvPercent = cmvPercents.length > 0 ? weightedAverage(cmvPercents) : 0;

    const taxPercents = recentMonths
      .filter(m => m.income > 0)
      .map(m => m.taxes / m.income);
    const avgTaxPercent = taxPercents.length > 0 ? weightedAverage(taxPercents) : 0;

    const avgFixed = last3Months.reduce((s, m) => s + m.fixed, 0) / last3Months.length;

    const variableValues = recentMonths.map(m => m.variable);
    const avgVariable = weightedAverage(variableValues);

    // ============================================
    // 5. BUSCAR COMPROMISSOS CONHECIDOS PARA FORECAST
    //    Inclui:
    //    a) Transações PENDING/OVERDUE (agrupadas por dueDate)
    //    b) Transações COMPLETED com data efetiva FUTURA (dados legados/edge case)
    //       Regra: paid_at <= today mas data efetiva > today
    // ============================================
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    // 5a. Transações PENDING/OVERDUE
    const pendingTransactions = await prisma.transaction.findMany({
      where: {
        companyId,
        status: { in: ["PENDING", "OVERDUE"] },
      },
      include: {
        detail: true,
      },
    });

    // 5b. Transações COMPLETED com data efetiva futura (resiliência)
    //     Isso não deveria existir após a validação, mas protege contra dados legados
    const completedFuture = completedTransactions.filter((tx) => {
      const effectiveDate = getEffectiveDate(tx);
      return effectiveDate > today;
    });

    if (completedFuture.length > 0) {
      console.warn(
        `[Forecast] ${completedFuture.length} transações COMPLETED com data efetiva futura encontradas. ` +
        `Tratando como compromissos conhecidos no forecast.`
      );
    }

    // Agrupar pendentes por mês de vencimento (dueDate)
    const pendingByMonth: Record<string, { income: number; expense: number }> = {};

    // Pendentes: usar dueDate
    for (const tx of pendingTransactions) {
      const dueDate = tx.detail?.dueDate;
      if (!dueDate) continue; // Sem vencimento, não incluir na projeção

      const monthKey = formatMonthKey(dueDate);
      if (!pendingByMonth[monthKey]) pendingByMonth[monthKey] = { income: 0, expense: 0 };

      const amount = Math.abs(Number(tx.amount));
      if (tx.tipo_transacao === "INCOME") {
        pendingByMonth[monthKey].income += amount;
      } else {
        pendingByMonth[monthKey].expense += amount;
      }
    }

    // COMPLETED com data futura: usar data efetiva (paymentDate/receiptDate)
    for (const tx of completedFuture) {
      const effectiveDate = getEffectiveDate(tx);
      const monthKey = formatMonthKey(effectiveDate);
      if (!pendingByMonth[monthKey]) pendingByMonth[monthKey] = { income: 0, expense: 0 };

      const amount = Math.abs(Number(tx.amount));
      if (tx.tipo_transacao === "INCOME") {
        pendingByMonth[monthKey].income += amount;
      } else {
        pendingByMonth[monthKey].expense += amount;
      }

      // REMOVER do historical para não contar duas vezes
      // (já está no pendingByMonth como compromisso futuro)
      const histMonth = monthlyMap.get(monthKey);
      if (histMonth) {
        if (tx.tipo_transacao === "INCOME") {
          histMonth.income -= amount;
        } else {
          histMonth.expense -= amount;
        }
        histMonth.net = histMonth.income - histMonth.expense;
      }
    }

    // ============================================
    // 6. GERAR FORECAST (projeção + compromissos pendentes)
    // ============================================

    // CORREÇÃO 2: O forecast começa a partir do mês corrente
    // (que foi excluído do historical por ser incompleto)
    const lastHistoricalMonth = historical.length > 0
      ? historical[historical.length - 1].month
      : nextMonth(currentMonth, -1);

    // CORREÇÃO 3: Base de receita = média dos últimos 6 meses completos
    // Usar o último mês como base é frágil — um mês atípico distorce toda a projeção.
    // A média suaviza variações pontuais e reflete melhor a operação real.
    const baseMonths = historical.slice(-6);
    const lastIncome = baseMonths.reduce((s, m) => s + m.income, 0) / baseMonths.length;

    const forecast: ForecastPoint[] = [];

    for (let i = 1; i <= months; i++) {
      const forecastMonth = nextMonth(lastHistoricalMonth, i);

      // Receita projetada com tendência + cenário
      const baseRevenue = lastIncome * Math.pow(1 + revenueGrowthRate, i);
      const projectedRevenue = baseRevenue * scenarioConfig.revenueMultiplier;

      // CMV = receita × CMV% (ajustado pelo cenário)
      const cmvPercent = Math.max(0, Math.min(1, avgCmvPercent + scenarioConfig.cmvAdjust));
      const projectedCmv = projectedRevenue * cmvPercent;

      // Impostos = receita × Imposto%
      const projectedTaxes = projectedRevenue * avgTaxPercent;

      // Fixos = média histórica × multiplicador do cenário
      const projectedFixed = avgFixed * scenarioConfig.expenseMultiplier;

      // Variáveis = média histórica × multiplicador do cenário
      const projectedVariable = avgVariable * scenarioConfig.expenseMultiplier;

      // Total de despesas (projeção estatística)
      const totalExpense = projectedCmv + projectedTaxes + projectedFixed + projectedVariable;

      // Compromissos pendentes para este mês
      const pending = pendingByMonth[forecastMonth];
      const pendingIncome = pending?.income || 0;
      const pendingExpense = pending?.expense || 0;

      // Receita final = máximo entre projeção e compromissos pendentes
      // (se já tem receita prevista maior que a projeção, usar a prevista)
      const finalIncome = Math.max(projectedRevenue, pendingIncome);

      // Despesa final = máximo entre projeção e compromissos pendentes
      // (compromissos são "piso garantido" de despesas)
      const finalExpense = Math.max(totalExpense, pendingExpense);

      forecast.push({
        month: forecastMonth,
        income: Math.round(finalIncome),
        expense: Math.round(finalExpense),
        cmv: Math.round(projectedCmv),
        taxes: Math.round(projectedTaxes),
        fixed: Math.round(projectedFixed),
        variable: Math.round(projectedVariable),
        net: Math.round(finalIncome - finalExpense),
        isForecast: true,
        scenario,
        pendingIncome: pendingIncome > 0 ? Math.round(pendingIncome) : undefined,
        pendingExpense: pendingExpense > 0 ? Math.round(pendingExpense) : undefined,
      });
    }

    // ============================================
    // 7. RESPOSTA
    // O historical no response inclui o mês corrente para visualização no gráfico,
    // mas o mês corrente NÃO foi usado no cálculo dos drivers.
    // ============================================
    const historicalForResponse = currentMonthData
      ? [...historical, currentMonthData]
      : historical;

    return res.json({
      success: true,
      data: {
        historical: historicalForResponse,
        forecast,
        metadata: {
          forecastAvailable: true,
          historicalMonths: historical.length,
          minimumRequired: MIN_MONTHS,
          drivers: {
            avgCmvPercent: Math.round(avgCmvPercent * 1000) / 10,
            avgTaxPercent: Math.round(avgTaxPercent * 1000) / 10,
            avgFixed: Math.round(avgFixed),
            avgVariable: Math.round(avgVariable),
            revenueGrowthRate: Math.round(revenueGrowthRate * 1000) / 10,
          },
          scenario,
        },
      },
    } as ForecastResponse);
  } catch (error) {
    next(error);
  }
});

export default router;
