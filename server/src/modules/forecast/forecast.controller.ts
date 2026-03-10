import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../../shared/database.js";
import { authMiddleware } from "../auth/auth.middleware.js";
import { getDREProfile, isDirectCost } from "../../shared/dre-profiles.js";

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

/**
 * Calcula a tendência de receita usando regressão linear simples
 * Retorna: taxa de crescimento mensal (ex: 0.02 = +2%/mês)
 */
function calculateRevenueGrowthRate(monthlyIncomes: number[]): number {
  const n = monthlyIncomes.length;
  if (n < 3) return 0;

  // Regressão linear: y = a + bx
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += monthlyIncomes[i];
    sumXY += i * monthlyIncomes[i];
    sumX2 += i * i;
  }

  const avgY = sumY / n;
  const b = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  // Retorna taxa de crescimento relativa à média
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
    // Pesos crescentes: meses mais recentes pesam mais
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
    cmvAdjust: 0,       // pontos percentuais
    expenseMultiplier: 1.0,
  },
  optimistic: {
    revenueMultiplier: 1.15,  // +15% receita
    cmvAdjust: -0.02,         // -2pp de CMV%
    expenseMultiplier: 0.95,  // -5% despesas fixas/variáveis
  },
  pessimistic: {
    revenueMultiplier: 0.85,  // -15% receita
    cmvAdjust: 0.02,          // +2pp de CMV%
    expenseMultiplier: 1.10,  // +10% despesas fixas/variáveis
  },
};

// ============================================
// MAIN ENDPOINT: GET /api/forecast
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
    // 1. BUSCAR TRANSAÇÕES HISTÓRICAS (últimos 12 meses)
    // ============================================
    const currentMonth = getCurrentMonth();
    const twelveMonthsAgo = nextMonth(currentMonth, -12);

    const transactions = await prisma.transaction.findMany({
      where: {
        companyId,
        date: {
          gte: new Date(`${twelveMonthsAgo}-01`),
        },
      },
      include: {
        category: {
          select: { code: true, name: true },
        },
      },
      orderBy: { date: "asc" },
    });

    // ============================================
    // 2. AGREGAR POR MÊS COM CLASSIFICAÇÕES
    // ============================================
    const monthlyMap = new Map<string, MonthlyData>();

    for (const tx of transactions) {
      const txDate = new Date(tx.date);
      const monthKey = `${txDate.getFullYear()}-${String(txDate.getMonth() + 1).padStart(2, "0")}`;

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
          // Custo direto (CMV/CSP/CPV conforme setor)
          data.cmv += amount;
        } else if (categoryCode.startsWith("8.")) {
          // Grupo 8.x = Impostos e Tributos
          data.taxes += amount;
        } else if (tipoCusto === "FIXO") {
          data.fixed += amount;
        } else if (tipoCusto === "VARIAVEL") {
          data.variable += amount;
        } else {
          // Sem classificação de custo — classificar por grupo DRE
          if (categoryCode.startsWith("4.") || categoryCode.startsWith("5.")) {
            // 4.x = Pessoal, 5.x = Operacional → custos fixos
            data.fixed += amount;
          } else if (categoryCode.startsWith("6.") || categoryCode.startsWith("7.")) {
            // 6.x = Comercial, 7.x = Financeiro → custos variáveis
            data.variable += amount;
          } else {
            data.variable += amount;
          }
        }
      }

      data.net = data.income - data.expense;
    }

    // Ordenar por mês
    const historical = Array.from(monthlyMap.values()).sort((a, b) => a.month.localeCompare(b.month));

    // ============================================
    // 3. VERIFICAR MÍNIMO DE DADOS
    // ============================================
    const MIN_MONTHS = 3;
    if (historical.length < MIN_MONTHS) {
      return res.json({
        success: true,
        data: {
          historical,
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
    // 4. CALCULAR DRIVERS
    // ============================================
    // Usar últimos 6 meses (ou todos se menos de 6)
    const recentMonths = historical.slice(-6);
    const last3Months = historical.slice(-3);

    // Receita: tendência via regressão linear
    const incomes = historical.map(m => m.income);
    const revenueGrowthRate = calculateRevenueGrowthRate(incomes);

    // CMV% = média ponderada do CMV/Receita dos últimos meses
    const cmvPercents = recentMonths
      .filter(m => m.income > 0)
      .map(m => m.cmv / m.income);
    const avgCmvPercent = cmvPercents.length > 0 ? weightedAverage(cmvPercents) : 0;

    // Impostos% = média ponderada dos Impostos/Receita
    const taxPercents = recentMonths
      .filter(m => m.income > 0)
      .map(m => m.taxes / m.income);
    const avgTaxPercent = taxPercents.length > 0 ? weightedAverage(taxPercents) : 0;

    // Custos fixos = média dos últimos 3 meses
    const avgFixed = last3Months.reduce((s, m) => s + m.fixed, 0) / last3Months.length;

    // Custos variáveis = média ponderada dos últimos 6 meses
    const variableValues = recentMonths.map(m => m.variable);
    const avgVariable = weightedAverage(variableValues);

    // ============================================
    // 5. GERAR FORECAST
    // ============================================
    const lastHistoricalMonth = historical[historical.length - 1].month;
    const lastIncome = historical[historical.length - 1].income;
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

      // Total de despesas
      const totalExpense = projectedCmv + projectedTaxes + projectedFixed + projectedVariable;

      forecast.push({
        month: forecastMonth,
        income: Math.round(projectedRevenue),
        expense: Math.round(totalExpense),
        cmv: Math.round(projectedCmv),
        taxes: Math.round(projectedTaxes),
        fixed: Math.round(projectedFixed),
        variable: Math.round(projectedVariable),
        net: Math.round(projectedRevenue - totalExpense),
        isForecast: true,
        scenario,
      });
    }

    // ============================================
    // 6. RESPOSTA
    // ============================================
    return res.json({
      success: true,
      data: {
        historical,
        forecast,
        metadata: {
          forecastAvailable: true,
          historicalMonths: historical.length,
          minimumRequired: MIN_MONTHS,
          drivers: {
            avgCmvPercent: Math.round(avgCmvPercent * 1000) / 10, // ex: 55.2%
            avgTaxPercent: Math.round(avgTaxPercent * 1000) / 10,
            avgFixed: Math.round(avgFixed),
            avgVariable: Math.round(avgVariable),
            revenueGrowthRate: Math.round(revenueGrowthRate * 1000) / 10, // ex: 2.3%
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
