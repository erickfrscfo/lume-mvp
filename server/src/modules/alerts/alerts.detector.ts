/**
 * CAMADA 1 — DETECÇÃO DE ALERTAS (sem IA)
 * 
 * Analisa transações e métricas financeiras para identificar padrões
 * que merecem atenção do CFO. Retorna alertas brutos (sem texto humanizado).
 */

import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../../shared/database.js';

// ============================================
// TIPOS
// ============================================

export interface RawAlert {
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  title: string;
  category?: string;
  potentialSavings?: number;
  data: Record<string, any>;
}

// ============================================
// HELPERS
// ============================================

function formatMonth(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function getMonthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getMonthEnd(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

// ============================================
// DETECTORES
// ============================================

/**
 * Detecta picos de despesa em categorias específicas
 */
async function detectExpenseSpikes(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];
  const currentMonth = new Date();
  const currentMonthKey = formatMonth(currentMonth);

  // Buscar todas as categorias de despesa
  const categories = await prisma.category.findMany({
    where: { type: TransactionType.EXPENSE },
    select: { id: true, name: true },
  });

  for (const category of categories) {
    // Despesas do mês atual
    const currentExpenses = await prisma.transaction.aggregate({
      _sum: { amount: true },
      where: {
        companyId,
        categoryId: category.id,
        tipo_transacao: TransactionType.EXPENSE,
        date: {
          gte: getMonthStart(currentMonth),
          lte: getMonthEnd(currentMonth),
        },
      },
    });

    const currentValue = Math.abs(currentExpenses._sum.amount?.toNumber() || 0);
    if (currentValue === 0) continue;

    // Média dos últimos 3 meses (excluindo o atual)
    const historicalExpenses = await prisma.transaction.aggregate({
      _sum: { amount: true },
      where: {
        companyId,
        categoryId: category.id,
        tipo_transacao: TransactionType.EXPENSE,
        date: {
          gte: getMonthStart(addMonths(currentMonth, -3)),
          lt: getMonthStart(currentMonth),
        },
      },
    });

    const average = Math.abs(historicalExpenses._sum.amount?.toNumber() || 0) / 3;
    if (average === 0) continue;

    const variation = ((currentValue - average) / average) * 100;

    // Alerta se variação > 20%
    if (variation > 20) {
      alerts.push({
        type: 'EXPENSE_SPIKE',
        severity: variation > 50 ? 'HIGH' : 'MEDIUM',
        title: `Aumento de ${variation.toFixed(0)}% em ${category.name}`,
        category: 'Despesas',
        data: {
          category: category.name,
          currentMonth: currentMonthKey,
          currentValue,
          average,
          variation: Math.round(variation),
        },
      });
    }

    // Alerta de economia se variação < -20%
    if (variation < -20) {
      const savings = average - currentValue;
      alerts.push({
        type: 'EXPENSE_DROP',
        severity: 'LOW',
        title: `Economia de ${Math.abs(variation).toFixed(0)}% em ${category.name}`,
        category: 'Economia',
        potentialSavings: savings,
        data: {
          category: category.name,
          currentMonth: currentMonthKey,
          currentValue,
          average,
          variation: Math.round(variation),
          savings,
        },
      });
    }
  }

  return alerts;
}

/**
 * Detecta oportunidades de negociação com fornecedores recorrentes
 */
async function detectNegotiationOpportunities(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];
  const sixMonthsAgo = addMonths(new Date(), -6);

  // Buscar fornecedores com pagamentos recorrentes
  const suppliers = await prisma.transaction.groupBy({
    by: ['description'],
    where: {
      companyId,
      tipo_transacao: TransactionType.EXPENSE,
      date: { gte: sixMonthsAgo },
    },
    _count: { id: true },
    _sum: { amount: true },
    having: {
      id: { _count: { gte: 4 } }, // Pelo menos 4 pagamentos em 6 meses
    },
  });

  for (const supplier of suppliers) {
    const totalValue = Math.abs(supplier._sum.amount?.toNumber() || 0);
    const avgMonthlyValue = totalValue / 6;

    // Oportunidade de negociação se valor médio > R$ 1.000/mês
    if (avgMonthlyValue > 1000) {
      const estimatedDiscount = {
        min: totalValue * 0.05, // 5% de desconto
        max: totalValue * 0.15, // 15% de desconto
      };

      alerts.push({
        type: 'NEGOTIATION_OPPORTUNITY',
        severity: 'MEDIUM',
        title: `Oportunidade de negociação com ${supplier.description}`,
        category: 'Negociação',
        potentialSavings: estimatedDiscount.min,
        data: {
          supplier: supplier.description,
          monthsConsecutive: supplier._count.id,
          avgMonthlyValue,
          estimatedDiscount,
          discountRange: '5-15%',
        },
      });
    }
  }

  return alerts;
}

/**
 * Detecta anomalias sazonais (comparação com mesmo período do ano anterior)
 */
async function detectSeasonalAnomalies(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];
  const currentMonth = new Date();
  const lastYearMonth = addMonths(currentMonth, -12);

  // Receita do mês atual
  const currentRevenue = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: {
      companyId,
      tipo_transacao: TransactionType.INCOME,
      date: {
        gte: getMonthStart(currentMonth),
        lte: getMonthEnd(currentMonth),
      },
    },
  });

  // Receita do mesmo mês do ano passado
  const lastYearRevenue = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: {
      companyId,
      tipo_transacao: TransactionType.INCOME,
      date: {
        gte: getMonthStart(lastYearMonth),
        lte: getMonthEnd(lastYearMonth),
      },
    },
  });

  const currentValue = currentRevenue._sum.amount?.toNumber() || 0;
  const lastYearValue = lastYearRevenue._sum.amount?.toNumber() || 0;

  if (lastYearValue > 0) {
    const variation = ((currentValue - lastYearValue) / lastYearValue) * 100;

    // Alerta de queda de receita
    if (variation < -15) {
      alerts.push({
        type: 'SEASONAL_ANOMALY',
        severity: 'HIGH',
        title: `Receita ${Math.abs(variation).toFixed(0)}% abaixo do ano passado`,
        category: 'Receita',
        data: {
          metric: 'revenue',
          currentMonth: formatMonth(currentMonth),
          currentValue,
          lastYearValue,
          variation: Math.round(variation),
          comparisonType: 'year-over-year',
        },
      });
    }

    // Alerta de crescimento de receita
    if (variation > 15) {
      alerts.push({
        type: 'SEASONAL_OPPORTUNITY',
        severity: 'LOW',
        title: `Receita ${variation.toFixed(0)}% acima do ano passado`,
        category: 'Crescimento',
        data: {
          metric: 'revenue',
          currentMonth: formatMonth(currentMonth),
          currentValue,
          lastYearValue,
          variation: Math.round(variation),
        },
      });
    }
  }

  return alerts;
}

// ============================================
// ORQUESTRADOR
// ============================================

/**
 * Executa todos os detectores e retorna alertas brutos
 */
export async function detectAllAlerts(companyId: string): Promise<RawAlert[]> {
  const allAlerts: RawAlert[] = [];

  try {
    const [spikes, negotiations, seasonal] = await Promise.allSettled([
      detectExpenseSpikes(companyId),
      detectNegotiationOpportunities(companyId),
      detectSeasonalAnomalies(companyId),
    ]);

    if (spikes.status === 'fulfilled') allAlerts.push(...spikes.value);
    if (negotiations.status === 'fulfilled') allAlerts.push(...negotiations.value);
    if (seasonal.status === 'fulfilled') allAlerts.push(...seasonal.value);
  } catch (error) {
    console.error('[Alerts Detector] Erro ao detectar alertas:', error);
  }

  return allAlerts;
}
