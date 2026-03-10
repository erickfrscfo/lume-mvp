/**
 * CAMADA 1 — DETECÇÃO DE ALERTAS INTELIGENTES (sem IA)
 * 
 * Analisa transações e métricas financeiras para identificar padrões
 * que merecem atenção do CFO. Foco em anomalias, tendências e insights de alto valor.
 * 
 * Detectores:
 * 1. EXPENSE_SPIKE — Pico de despesa em categoria (variação > 25% da média)
 * 2. EXPENSE_DROP — Economia significativa em categoria (variação < -25%)
 * 3. NEGOTIATION_OPPORTUNITY — Fornecedores negociáveis com recorrência
 * 4. COST_OPTIMIZATION — Sugestões para contas não-negociáveis (energia, folha, etc.)
 * 5. MARGIN_DECLINE — Margem caindo por 2+ meses consecutivos
 * 6. REVENUE_DECLINE_TREND — Receita caindo por 2+ meses consecutivos
 * 7. EXPENSE_OUTPACING_REVENUE — Despesas crescendo mais que receita
 * 8. SUPPLIER_PRICE_INCREASE — Fornecedor específico aumentou > 20%
 * 9. COST_CONCENTRATION — Uma categoria concentra > 40% das despesas
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
// CLASSIFICAÇÃO DE NATUREZA DAS CONTAS
// ============================================

// Contas que podem ser renegociadas com terceiros
const NEGOTIABLE_KEYWORDS = [
  'aluguel', 'condomínio', 'condominio',
  'fornecedor', 'mercadoria', 'matéria-prima', 'materia-prima', 'insumo',
  'software', 'sistema', 'erp', 'crm', 'saas', 'assinatura', 'licença', 'licenca',
  'seguro', 'plano de saúde', 'plano de saude',
  'internet', 'telefone', 'telefonia',
  'frete', 'logística', 'logistica', 'transporte',
  'manutenção', 'manutencao',
  'consultoria', 'assessoria', 'contabilidade', 'contador',
  'embalagem', 'caixa',
];

// Contas de consumo — não se renegocia, se economiza
const CONSUMPTION_KEYWORDS = [
  'energia', 'elétrica', 'eletrica', 'luz',
  'água', 'agua',
  'gás', 'gas',
  'combustível', 'combustivel', 'gasolina', 'diesel',
];

// Contas de folha de pagamento — não se renegocia, se otimiza
const PAYROLL_KEYWORDS = [
  'salário', 'salario', 'salários', 'salarios',
  'folha de pagamento', 'folha',
  'prolabore', 'pró-labore', 'pro-labore', 'pro labore',
  'benefício', 'beneficio', 'vale transporte', 'vale refeição',
  'férias', 'ferias', '13º', 'decimo terceiro',
  'fgts', 'inss', 'encargos',
];

// Impostos — não se renegocia
const TAX_KEYWORDS = [
  'imposto', 'simples nacional', 'icms', 'iss', 'pis', 'cofins',
  'irpj', 'csll', 'taxa', 'tributo',
];

// Perdas — não se renegocia, se previne
const LOSS_KEYWORDS = [
  'perda', 'avaria', 'quebra', 'devolução', 'devoluçao',
  'sinistro', 'roubo', 'furto',
];

function classifyAccountNature(description: string): 'NEGOTIABLE' | 'CONSUMPTION' | 'PAYROLL' | 'TAX' | 'LOSS' | 'OTHER' {
  const desc = description.toLowerCase();
  
  if (PAYROLL_KEYWORDS.some(k => desc.includes(k))) return 'PAYROLL';
  if (TAX_KEYWORDS.some(k => desc.includes(k))) return 'TAX';
  if (CONSUMPTION_KEYWORDS.some(k => desc.includes(k))) return 'CONSUMPTION';
  if (LOSS_KEYWORDS.some(k => desc.includes(k))) return 'LOSS';
  if (NEGOTIABLE_KEYWORDS.some(k => desc.includes(k))) return 'NEGOTIABLE';
  return 'OTHER';
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
// DETECTOR 1: PICOS DE DESPESA POR CATEGORIA
// Alerta quando uma categoria sobe >25% vs média dos últimos 3 meses
// ============================================

async function detectExpenseSpikes(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];
  const currentMonth = new Date();
  const currentMonthKey = formatMonth(currentMonth);

  const categories = await prisma.category.findMany({
    where: { type: TransactionType.EXPENSE },
    select: { id: true, name: true },
  });

  for (const category of categories) {
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
      _count: { id: true },
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

    const historicalTotal = Math.abs(historicalExpenses._sum.amount?.toNumber() || 0);
    // Precisa de pelo menos 2 meses de histórico para ser relevante
    if (historicalTotal === 0) continue;

    const average = historicalTotal / 3;
    const variation = ((currentValue - average) / average) * 100;

    // Threshold: variação > 25% para pico (mais rigoroso que antes)
    if (variation > 25) {
      const severity = variation > 80 ? 'CRITICAL' : variation > 50 ? 'HIGH' : 'MEDIUM';
      alerts.push({
        type: 'EXPENSE_SPIKE',
        severity,
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

    // Economia significativa: variação < -25%
    if (variation < -25) {
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

// ============================================
// DETECTOR 2: OPORTUNIDADES POR NATUREZA DA CONTA
// Diferencia contas negociáveis de consumo/folha/impostos
// ============================================

async function detectSmartOpportunities(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];
  const sixMonthsAgo = addMonths(new Date(), -6);

  // Buscar despesas recorrentes (4+ vezes em 6 meses, > R$500/mês)
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
      id: { _count: { gte: 4 } },
    },
  });

  for (const supplier of suppliers) {
    const totalValue = Math.abs(supplier._sum.amount?.toNumber() || 0);
    const avgMonthlyValue = totalValue / 6;
    const description = supplier.description;
    const nature = classifyAccountNature(description);

    // Valor mínimo de R$ 1.000/mês para gerar alerta
    if (avgMonthlyValue < 1000) continue;

    switch (nature) {
      case 'NEGOTIABLE':
        // Fornecedores, aluguel, software — PODE renegociar
        alerts.push({
          type: 'NEGOTIATION_OPPORTUNITY',
          severity: avgMonthlyValue > 10000 ? 'HIGH' : 'MEDIUM',
          title: `Renegociar ${description}`,
          category: 'Negociação',
          potentialSavings: totalValue * 0.05,
          data: {
            supplier: description,
            nature: 'NEGOTIABLE',
            monthsConsecutive: supplier._count.id,
            avgMonthlyValue,
            estimatedDiscount: {
              min: totalValue * 0.05,
              max: totalValue * 0.15,
            },
            discountRange: '5-15%',
            recommendation: `Com ${supplier._count.id} pagamentos consecutivos e volume de ${Math.round(avgMonthlyValue)}/mês, você tem poder de barganha. Solicite cotações de concorrentes e use como argumento na negociação.`,
          },
        });
        break;

      case 'CONSUMPTION':
        // Energia, água, gás — sugerir economia de consumo
        alerts.push({
          type: 'COST_OPTIMIZATION',
          severity: 'MEDIUM',
          title: `Otimizar consumo de ${description}`,
          category: 'Otimização',
          potentialSavings: avgMonthlyValue * 0.10 * 12, // 10% de economia anual
          data: {
            supplier: description,
            nature: 'CONSUMPTION',
            monthsConsecutive: supplier._count.id,
            avgMonthlyValue,
            potentialSavingsAnnual: avgMonthlyValue * 0.10 * 12,
            recommendation: `Sua média mensal é R$ ${Math.round(avgMonthlyValue)}. Contas de consumo não se renegociam — a economia vem de reduzir o uso. Considere: trocar lâmpadas por LED, desligar equipamentos fora do horário, verificar vazamentos, revisar a bandeira tarifária e avaliar geração solar.`,
          },
        });
        break;

      case 'PAYROLL':
        // Salários, pró-labore — sugerir otimização de estrutura
        if (avgMonthlyValue > 5000) {
          alerts.push({
            type: 'COST_OPTIMIZATION',
            severity: 'LOW',
            title: `Revisar estrutura: ${description}`,
            category: 'Folha de Pagamento',
            data: {
              supplier: description,
              nature: 'PAYROLL',
              monthsConsecutive: supplier._count.id,
              avgMonthlyValue,
              recommendation: description.toLowerCase().includes('prolabore') || description.toLowerCase().includes('pró-labore')
                ? `O pró-labore está em R$ ${Math.round(avgMonthlyValue)}/mês. Avalie se o valor está adequado ao mercado e ao momento da empresa. Converse com seu contador sobre a melhor estratégia tributária (pró-labore vs distribuição de lucros).`
                : `A folha com ${description} está em R$ ${Math.round(avgMonthlyValue)}/mês. Avalie se a estrutura de cargos está otimizada: existem funções que podem ser combinadas? Processos que podem ser automatizados? Considere uma revisão de produtividade antes de cortar pessoas.`,
            },
          });
        }
        break;

      case 'LOSS':
        // Perdas e avarias — sugerir prevenção
        alerts.push({
          type: 'COST_OPTIMIZATION',
          severity: avgMonthlyValue > 5000 ? 'HIGH' : 'MEDIUM',
          title: `Reduzir ${description}`,
          category: 'Prevenção de Perdas',
          potentialSavings: avgMonthlyValue * 0.30 * 12, // 30% de redução possível
          data: {
            supplier: description,
            nature: 'LOSS',
            monthsConsecutive: supplier._count.id,
            avgMonthlyValue,
            potentialSavingsAnnual: avgMonthlyValue * 0.30 * 12,
            recommendation: `Você está perdendo em média R$ ${Math.round(avgMonthlyValue)}/mês com ${description.toLowerCase()}. Isso representa R$ ${Math.round(avgMonthlyValue * 12)}/ano. Investigue as causas: problemas no armazenamento? Transporte inadequado? Falta de controle de estoque? Implemente inventários rotativos e melhore os processos de manuseio.`,
          },
        });
        break;

      case 'TAX':
        // Impostos — não gerar alerta de renegociação
        // Apenas alertar se houver variação significativa (tratado pelo detectExpenseSpikes)
        break;

      default:
        // Outros — gerar alerta genérico apenas se valor alto
        if (avgMonthlyValue > 3000) {
          alerts.push({
            type: 'NEGOTIATION_OPPORTUNITY',
            severity: 'MEDIUM',
            title: `Avaliar gasto recorrente: ${description}`,
            category: 'Análise',
            data: {
              supplier: description,
              nature: 'OTHER',
              monthsConsecutive: supplier._count.id,
              avgMonthlyValue,
              recommendation: `Você gasta em média R$ ${Math.round(avgMonthlyValue)}/mês com "${description}". Avalie se esse gasto é essencial e se há alternativas mais econômicas.`,
            },
          });
        }
        break;
    }
  }

  return alerts;
}

// ============================================
// DETECTOR 3: MARGEM CAINDO CONSECUTIVAMENTE
// Alerta CRÍTICO quando margem cai por 2+ meses seguidos
// ============================================

async function detectMarginDecline(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];
  const currentMonth = new Date();

  // Calcular margem dos últimos 4 meses
  const margins: { month: string; revenue: number; expenses: number; margin: number }[] = [];

  for (let i = 0; i < 4; i++) {
    const monthDate = addMonths(currentMonth, -i);
    const monthKey = formatMonth(monthDate);

    const revenue = await prisma.transaction.aggregate({
      _sum: { amount: true },
      where: {
        companyId,
        tipo_transacao: TransactionType.INCOME,
        date: {
          gte: getMonthStart(monthDate),
          lte: getMonthEnd(monthDate),
        },
      },
    });

    const expenses = await prisma.transaction.aggregate({
      _sum: { amount: true },
      where: {
        companyId,
        tipo_transacao: TransactionType.EXPENSE,
        date: {
          gte: getMonthStart(monthDate),
          lte: getMonthEnd(monthDate),
        },
      },
    });

    const rev = revenue._sum.amount?.toNumber() || 0;
    const exp = Math.abs(expenses._sum.amount?.toNumber() || 0);
    const margin = rev > 0 ? ((rev - exp) / rev) * 100 : 0;

    margins.push({ month: monthKey, revenue: rev, expenses: exp, margin });
  }

  // Verificar se margem está caindo consecutivamente (últimos 3 meses)
  if (margins.length >= 3 && margins[0].revenue > 0 && margins[1].revenue > 0 && margins[2].revenue > 0) {
    const isDeclineTrend = margins[0].margin < margins[1].margin && margins[1].margin < margins[2].margin;
    
    if (isDeclineTrend) {
      const totalDecline = margins[2].margin - margins[0].margin;
      alerts.push({
        type: 'MARGIN_DECLINE',
        severity: totalDecline > 10 ? 'CRITICAL' : 'HIGH',
        title: `Margem caindo há 3 meses consecutivos`,
        category: 'Margem',
        data: {
          months: margins.slice(0, 3).reverse(),
          currentMargin: margins[0].margin.toFixed(1),
          previousMargin: margins[2].margin.toFixed(1),
          totalDecline: totalDecline.toFixed(1),
          trend: 'declining',
        },
      });
    }
  }

  return alerts;
}

// ============================================
// DETECTOR 4: RECEITA CAINDO CONSECUTIVAMENTE
// Alerta quando receita cai por 2+ meses seguidos
// ============================================

async function detectRevenueTrend(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];
  const currentMonth = new Date();

  const revenues: { month: string; value: number }[] = [];

  for (let i = 0; i < 4; i++) {
    const monthDate = addMonths(currentMonth, -i);
    const monthKey = formatMonth(monthDate);

    const revenue = await prisma.transaction.aggregate({
      _sum: { amount: true },
      where: {
        companyId,
        tipo_transacao: TransactionType.INCOME,
        date: {
          gte: getMonthStart(monthDate),
          lte: getMonthEnd(monthDate),
        },
      },
    });

    revenues.push({ month: monthKey, value: revenue._sum.amount?.toNumber() || 0 });
  }

  // Receita caindo por 3 meses consecutivos
  if (revenues.length >= 3 && revenues[2].value > 0) {
    const isDeclineTrend = revenues[0].value < revenues[1].value && revenues[1].value < revenues[2].value;

    if (isDeclineTrend) {
      const totalDecline = ((revenues[0].value - revenues[2].value) / revenues[2].value) * 100;
      alerts.push({
        type: 'REVENUE_DECLINE_TREND',
        severity: Math.abs(totalDecline) > 20 ? 'CRITICAL' : 'HIGH',
        title: `Receita caindo há 3 meses consecutivos (${Math.abs(totalDecline).toFixed(0)}%)`,
        category: 'Receita',
        data: {
          months: revenues.slice(0, 3).reverse(),
          currentRevenue: revenues[0].value,
          threeMonthsAgoRevenue: revenues[2].value,
          totalDecline: Math.round(totalDecline),
          trend: 'declining',
        },
      });
    }
  }

  return alerts;
}

// ============================================
// DETECTOR 5: DESPESAS CRESCENDO MAIS QUE RECEITA
// Alerta quando despesas sobem e receita não acompanha
// ============================================

async function detectExpenseOutpacingRevenue(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];
  const currentMonth = new Date();

  // Comparar mês atual vs média dos últimos 3 meses
  const currentRevenue = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: {
      companyId,
      tipo_transacao: TransactionType.INCOME,
      date: { gte: getMonthStart(currentMonth), lte: getMonthEnd(currentMonth) },
    },
  });

  const currentExpenses = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: {
      companyId,
      tipo_transacao: TransactionType.EXPENSE,
      date: { gte: getMonthStart(currentMonth), lte: getMonthEnd(currentMonth) },
    },
  });

  const historicalRevenue = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: {
      companyId,
      tipo_transacao: TransactionType.INCOME,
      date: { gte: getMonthStart(addMonths(currentMonth, -3)), lt: getMonthStart(currentMonth) },
    },
  });

  const historicalExpenses = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: {
      companyId,
      tipo_transacao: TransactionType.EXPENSE,
      date: { gte: getMonthStart(addMonths(currentMonth, -3)), lt: getMonthStart(currentMonth) },
    },
  });

  const curRev = currentRevenue._sum.amount?.toNumber() || 0;
  const curExp = Math.abs(currentExpenses._sum.amount?.toNumber() || 0);
  const avgRev = (historicalRevenue._sum.amount?.toNumber() || 0) / 3;
  const avgExp = Math.abs(historicalExpenses._sum.amount?.toNumber() || 0) / 3;

  if (avgRev > 0 && avgExp > 0) {
    const revenueChange = ((curRev - avgRev) / avgRev) * 100;
    const expenseChange = ((curExp - avgExp) / avgExp) * 100;

    // Despesas cresceram >15% E receita caiu ou ficou estável (<5%)
    if (expenseChange > 15 && revenueChange < 5) {
      alerts.push({
        type: 'EXPENSE_OUTPACING_REVENUE',
        severity: expenseChange > 30 ? 'CRITICAL' : 'HIGH',
        title: `Despesas +${expenseChange.toFixed(0)}% com receita ${revenueChange > 0 ? '+' : ''}${revenueChange.toFixed(0)}%`,
        category: 'Equilíbrio Financeiro',
        data: {
          currentRevenue: curRev,
          currentExpenses: curExp,
          avgRevenue: avgRev,
          avgExpenses: avgExp,
          revenueChange: Math.round(revenueChange),
          expenseChange: Math.round(expenseChange),
          gap: Math.round(expenseChange - revenueChange),
        },
      });
    }
  }

  return alerts;
}

// ============================================
// DETECTOR 6: FORNECEDOR AUMENTOU PREÇO SIGNIFICATIVAMENTE
// Alerta quando um fornecedor específico aumenta >20%
// ============================================

async function detectSupplierPriceIncrease(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];
  const currentMonth = new Date();

  // Buscar despesas por descrição no mês atual
  const currentBySupplier = await prisma.transaction.groupBy({
    by: ['description'],
    where: {
      companyId,
      tipo_transacao: TransactionType.EXPENSE,
      date: { gte: getMonthStart(currentMonth), lte: getMonthEnd(currentMonth) },
    },
    _sum: { amount: true },
    _count: { id: true },
  });

  for (const current of currentBySupplier) {
    const currentValue = Math.abs(current._sum.amount?.toNumber() || 0);
    if (currentValue < 500) continue; // Ignorar valores muito baixos

    // Média dos últimos 3 meses para esse mesmo fornecedor/descrição
    const historical = await prisma.transaction.aggregate({
      _sum: { amount: true },
      _count: { id: true },
      where: {
        companyId,
        description: current.description,
        tipo_transacao: TransactionType.EXPENSE,
        date: { gte: getMonthStart(addMonths(currentMonth, -3)), lt: getMonthStart(currentMonth) },
      },
    });

    const historicalTotal = Math.abs(historical._sum.amount?.toNumber() || 0);
    const historicalCount = historical._count.id || 0;
    if (historicalCount < 2) continue; // Precisa de histórico

    const avgValue = historicalTotal / 3;
    if (avgValue === 0) continue;

    const variation = ((currentValue - avgValue) / avgValue) * 100;

    // Aumento > 20% é significativo
    if (variation > 20) {
      const nature = classifyAccountNature(current.description);
      // Não alertar para impostos (variam naturalmente com faturamento)
      if (nature === 'TAX') continue;

      alerts.push({
        type: 'SUPPLIER_PRICE_INCREASE',
        severity: variation > 50 ? 'HIGH' : 'MEDIUM',
        title: `${current.description} aumentou ${variation.toFixed(0)}%`,
        category: 'Aumento de Custo',
        data: {
          supplier: current.description,
          nature,
          currentValue,
          avgValue,
          variation: Math.round(variation),
          increase: currentValue - avgValue,
        },
      });
    }
  }

  return alerts;
}

// ============================================
// DETECTOR 7: CONCENTRAÇÃO DE CUSTOS
// Alerta quando uma categoria concentra >40% das despesas
// ============================================

async function detectCostConcentration(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];
  const currentMonth = new Date();

  // Total de despesas do mês
  const totalExpenses = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: {
      companyId,
      tipo_transacao: TransactionType.EXPENSE,
      date: { gte: getMonthStart(currentMonth), lte: getMonthEnd(currentMonth) },
    },
  });

  const total = Math.abs(totalExpenses._sum.amount?.toNumber() || 0);
  if (total === 0) return alerts;

  // Despesas por categoria
  const categories = await prisma.category.findMany({
    where: { type: TransactionType.EXPENSE },
    select: { id: true, name: true },
  });

  for (const category of categories) {
    const catExpenses = await prisma.transaction.aggregate({
      _sum: { amount: true },
      where: {
        companyId,
        categoryId: category.id,
        tipo_transacao: TransactionType.EXPENSE,
        date: { gte: getMonthStart(currentMonth), lte: getMonthEnd(currentMonth) },
      },
    });

    const catValue = Math.abs(catExpenses._sum.amount?.toNumber() || 0);
    const percentage = (catValue / total) * 100;

    if (percentage > 40) {
      alerts.push({
        type: 'COST_CONCENTRATION',
        severity: percentage > 60 ? 'HIGH' : 'MEDIUM',
        title: `${category.name} concentra ${percentage.toFixed(0)}% das despesas`,
        category: 'Concentração de Custos',
        data: {
          categoryName: category.name,
          categoryValue: catValue,
          totalExpenses: total,
          percentage: Math.round(percentage),
        },
      });
    }
  }

  return alerts;
}

// ============================================
// DETECTOR 8: CONTAS VENCIDAS (OVERDUE PAYMENTS)
// Alerta quando há contas com dueDate < hoje e sem paymentDate/receiptDate
// ============================================

async function detectOverduePayments(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];
  const now = new Date();

  // Buscar transações com vencimento passado e sem pagamento/recebimento
  const overdueTransactions = await prisma.transaction.findMany({
    where: {
      companyId,
      status: { not: 'COMPLETED' },
      detail: {
        dueDate: { lt: now },
        paymentDate: null,
        receiptDate: null,
      },
    },
    include: {
      detail: true,
      counterparty: { select: { name: true } },
      category: { select: { name: true } },
    },
    orderBy: { detail: { dueDate: 'asc' } },
  });

  if (overdueTransactions.length === 0) return alerts;

  // Agrupar por tipo (despesas a pagar vs receitas a receber)
  const overduePay = overdueTransactions.filter(t => t.tipo_transacao === 'EXPENSE');
  const overdueReceive = overdueTransactions.filter(t => t.tipo_transacao === 'INCOME');

  if (overduePay.length > 0) {
    const totalOverdue = overduePay.reduce((sum, t) => sum + Math.abs(t.amount.toNumber()), 0);
    const oldestDue = overduePay[0].detail?.dueDate;
    const daysOverdue = oldestDue ? Math.floor((now.getTime() - oldestDue.getTime()) / (1000 * 60 * 60 * 24)) : 0;

    alerts.push({
      type: 'OVERDUE_PAYMENTS',
      severity: totalOverdue > 50000 || daysOverdue > 30 ? 'CRITICAL' : totalOverdue > 10000 || daysOverdue > 15 ? 'HIGH' : 'MEDIUM',
      title: `${overduePay.length} conta(s) a pagar vencida(s) — total R$ ${Math.round(totalOverdue).toLocaleString('pt-BR')}`,
      category: 'Contas a Pagar',
      data: {
        count: overduePay.length,
        totalOverdue,
        oldestDaysOverdue: daysOverdue,
        items: overduePay.slice(0, 5).map(t => ({
          description: t.description,
          counterparty: t.counterparty?.name || 'N/A',
          amount: Math.abs(t.amount.toNumber()),
          dueDate: t.detail?.dueDate?.toISOString().split('T')[0],
          daysOverdue: t.detail?.dueDate ? Math.floor((now.getTime() - t.detail.dueDate.getTime()) / (1000 * 60 * 60 * 24)) : 0,
        })),
      },
    });
  }

  if (overdueReceive.length > 0) {
    const totalOverdue = overdueReceive.reduce((sum, t) => sum + Math.abs(t.amount.toNumber()), 0);
    const oldestDue = overdueReceive[0].detail?.dueDate;
    const daysOverdue = oldestDue ? Math.floor((now.getTime() - oldestDue.getTime()) / (1000 * 60 * 60 * 24)) : 0;

    alerts.push({
      type: 'OVERDUE_RECEIVABLES',
      severity: totalOverdue > 50000 || daysOverdue > 30 ? 'CRITICAL' : totalOverdue > 10000 || daysOverdue > 15 ? 'HIGH' : 'MEDIUM',
      title: `${overdueReceive.length} recebível(is) vencido(s) — total R$ ${Math.round(totalOverdue).toLocaleString('pt-BR')}`,
      category: 'Contas a Receber',
      data: {
        count: overdueReceive.length,
        totalOverdue,
        oldestDaysOverdue: daysOverdue,
        items: overdueReceive.slice(0, 5).map(t => ({
          description: t.description,
          counterparty: t.counterparty?.name || 'N/A',
          amount: Math.abs(t.amount.toNumber()),
          dueDate: t.detail?.dueDate?.toISOString().split('T')[0],
          daysOverdue: t.detail?.dueDate ? Math.floor((now.getTime() - t.detail.dueDate.getTime()) / (1000 * 60 * 60 * 24)) : 0,
        })),
      },
    });
  }

  return alerts;
}

// ============================================
// DETECTOR 9: VENCIMENTOS PRÓXIMOS (UPCOMING DUE DATES)
// Alerta quando há volume significativo de vencimentos nos próximos 7 dias
// ============================================

async function detectUpcomingDueDates(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const upcomingTransactions = await prisma.transaction.findMany({
    where: {
      companyId,
      tipo_transacao: 'EXPENSE',
      status: { not: 'COMPLETED' },
      detail: {
        dueDate: { gte: now, lte: in7Days },
        paymentDate: null,
      },
    },
    include: {
      detail: true,
      counterparty: { select: { name: true } },
    },
    orderBy: { detail: { dueDate: 'asc' } },
  });

  if (upcomingTransactions.length === 0) return alerts;

  const totalAmount = upcomingTransactions.reduce((sum, t) => sum + Math.abs(t.amount.toNumber()), 0);

  // Só alertar se o valor total for relevante (> R$ 5.000)
  if (totalAmount < 5000) return alerts;

  alerts.push({
    type: 'UPCOMING_DUE_DATES',
    severity: totalAmount > 50000 ? 'HIGH' : 'MEDIUM',
    title: `${upcomingTransactions.length} pagamento(s) vencendo nos próximos 7 dias — R$ ${Math.round(totalAmount).toLocaleString('pt-BR')}`,
    category: 'Vencimentos',
    data: {
      count: upcomingTransactions.length,
      totalAmount,
      items: upcomingTransactions.slice(0, 5).map(t => ({
        description: t.description,
        counterparty: t.counterparty?.name || 'N/A',
        amount: Math.abs(t.amount.toNumber()),
        dueDate: t.detail?.dueDate?.toISOString().split('T')[0],
      })),
    },
  });

  return alerts;
}

// ============================================
// DETECTOR 10: PADRÃO DE ATRASOS RECORRENTES
// Alerta quando fornecedor/cliente tem histórico de pagamentos atrasados
// ============================================

async function detectLatePaymentPattern(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];

  // Buscar contrapartes com latePaymentCount alto
  const riskyCounterparties = await prisma.counterparty.findMany({
    where: {
      companyId,
      latePaymentCount: { gte: 3 },
    },
    select: {
      id: true,
      name: true,
      type: true,
      latePaymentCount: true,
      avgDaysToPay: true,
      avgDaysToReceive: true,
      reliabilityScore: true,
    },
  });

  for (const cp of riskyCounterparties) {
    // Verificar volume financeiro com essa contraparte (últimos 6 meses)
    const sixMonthsAgo = addMonths(new Date(), -6);
    const volume = await prisma.transaction.aggregate({
      _sum: { amount: true },
      _count: { id: true },
      where: {
        companyId,
        counterpartyId: cp.id,
        date: { gte: sixMonthsAgo },
      },
    });

    const totalVolume = Math.abs(volume._sum.amount?.toNumber() || 0);
    if (totalVolume < 3000) continue; // Ignorar contrapartes de baixo volume

    const avgDays = cp.type === 'SUPPLIER'
      ? cp.avgDaysToPay?.toNumber() || 0
      : cp.avgDaysToReceive?.toNumber() || 0;

    const reliability = cp.reliabilityScore?.toNumber() || 100;

    alerts.push({
      type: 'LATE_PAYMENT_PATTERN',
      severity: cp.latePaymentCount >= 5 || reliability < 50 ? 'HIGH' : 'MEDIUM',
      title: `${cp.name} — ${cp.latePaymentCount} atrasos registrados`,
      category: cp.type === 'SUPPLIER' ? 'Fornecedores' : 'Clientes',
      data: {
        counterpartyName: cp.name,
        counterpartyType: cp.type,
        latePaymentCount: cp.latePaymentCount,
        avgDaysLate: Math.round(avgDays),
        reliabilityScore: Math.round(reliability),
        totalVolume6Months: totalVolume,
        transactionCount: volume._count.id,
      },
    });
  }

  return alerts;
}

// ============================================
// DETECTOR 11: JUROS E MULTAS ACUMULADOS
// Alerta quando juros/multas por atraso estão acumulando
// ============================================

async function detectInterestCharges(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];
  const threeMonthsAgo = addMonths(new Date(), -3);

  // Buscar transações com juros registrados nos últimos 3 meses
  const transactionsWithInterest = await prisma.transactionDetail.findMany({
    where: {
      interest: { gt: 0 },
      transaction: {
        companyId,
        date: { gte: threeMonthsAgo },
      },
    },
    include: {
      transaction: {
        select: { description: true, amount: true, date: true },
      },
    },
  });

  if (transactionsWithInterest.length === 0) return alerts;

  const totalInterest = transactionsWithInterest.reduce(
    (sum, td) => sum + (td.interest?.toNumber() || 0), 0
  );

  if (totalInterest < 100) return alerts; // Ignorar valores insignificantes

  alerts.push({
    type: 'INTEREST_CHARGES',
    severity: totalInterest > 5000 ? 'HIGH' : totalInterest > 1000 ? 'MEDIUM' : 'LOW',
    title: `R$ ${Math.round(totalInterest).toLocaleString('pt-BR')} em juros/multas nos últimos 3 meses`,
    category: 'Juros e Multas',
    potentialSavings: totalInterest,
    data: {
      totalInterest,
      transactionCount: transactionsWithInterest.length,
      items: transactionsWithInterest.slice(0, 5).map(td => ({
        description: td.transaction.description,
        amount: Math.abs(td.transaction.amount.toNumber()),
        interest: td.interest?.toNumber() || 0,
        date: td.transaction.date.toISOString().split('T')[0],
      })),
    },
  });

  return alerts;
}

// ============================================
// DETECTOR 12: GAP DE FLUXO DE CAIXA
// Alerta quando recebimentos futuros não cobrem pagamentos futuros
// ============================================

async function detectCashFlowGap(companyId: string): Promise<RawAlert[]> {
  const alerts: RawAlert[] = [];
  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Pagamentos futuros (despesas com dueDate nos próximos 30 dias, não pagas)
  const upcomingPayments = await prisma.transaction.aggregate({
    _sum: { amount: true },
    _count: { id: true },
    where: {
      companyId,
      tipo_transacao: 'EXPENSE',
      status: { not: 'COMPLETED' },
      detail: {
        dueDate: { gte: now, lte: in30Days },
        paymentDate: null,
      },
    },
  });

  // Recebimentos futuros (receitas com dueDate nos próximos 30 dias, não recebidas)
  const upcomingReceivables = await prisma.transaction.aggregate({
    _sum: { amount: true },
    _count: { id: true },
    where: {
      companyId,
      tipo_transacao: 'INCOME',
      status: { not: 'COMPLETED' },
      detail: {
        dueDate: { gte: now, lte: in30Days },
        receiptDate: null,
      },
    },
  });

  const totalPayments = Math.abs(upcomingPayments._sum.amount?.toNumber() || 0);
  const totalReceivables = upcomingReceivables._sum.amount?.toNumber() || 0;

  // Só alertar se houver pagamentos significativos
  if (totalPayments < 5000) return alerts;

  const gap = totalReceivables - totalPayments;

  // Gap negativo = mais pagamentos que recebimentos
  if (gap < 0 && Math.abs(gap) > 5000) {
    const coverageRatio = totalReceivables > 0 ? (totalReceivables / totalPayments) * 100 : 0;

    alerts.push({
      type: 'CASH_FLOW_GAP',
      severity: coverageRatio < 50 ? 'CRITICAL' : coverageRatio < 80 ? 'HIGH' : 'MEDIUM',
      title: `Gap de caixa de R$ ${Math.round(Math.abs(gap)).toLocaleString('pt-BR')} nos próximos 30 dias`,
      category: 'Fluxo de Caixa',
      data: {
        totalPayments,
        totalReceivables,
        gap: Math.round(gap),
        coverageRatio: Math.round(coverageRatio),
        paymentCount: upcomingPayments._count.id,
        receivableCount: upcomingReceivables._count.id,
      },
    });
  }

  return alerts;
}

// ============================================
// ORQUESTRADOR
// ============================================

export async function detectAllAlerts(companyId: string): Promise<RawAlert[]> {
  const allAlerts: RawAlert[] = [];

  try {
    const [
      spikes,
      smartOpportunities,
      marginDecline,
      revenueTrend,
      expenseOutpacing,
      supplierIncrease,
      costConcentration,
      overduePayments,
      upcomingDueDates,
      latePaymentPattern,
      interestCharges,
      cashFlowGap,
    ] = await Promise.allSettled([
      detectExpenseSpikes(companyId),
      detectSmartOpportunities(companyId),
      detectMarginDecline(companyId),
      detectRevenueTrend(companyId),
      detectExpenseOutpacingRevenue(companyId),
      detectSupplierPriceIncrease(companyId),
      detectCostConcentration(companyId),
      detectOverduePayments(companyId),
      detectUpcomingDueDates(companyId),
      detectLatePaymentPattern(companyId),
      detectInterestCharges(companyId),
      detectCashFlowGap(companyId),
    ]);

    if (spikes.status === 'fulfilled') allAlerts.push(...spikes.value);
    if (smartOpportunities.status === 'fulfilled') allAlerts.push(...smartOpportunities.value);
    if (marginDecline.status === 'fulfilled') allAlerts.push(...marginDecline.value);
    if (revenueTrend.status === 'fulfilled') allAlerts.push(...revenueTrend.value);
    if (expenseOutpacing.status === 'fulfilled') allAlerts.push(...expenseOutpacing.value);
    if (supplierIncrease.status === 'fulfilled') allAlerts.push(...supplierIncrease.value);
    if (costConcentration.status === 'fulfilled') allAlerts.push(...costConcentration.value);
    if (overduePayments.status === 'fulfilled') allAlerts.push(...overduePayments.value);
    if (upcomingDueDates.status === 'fulfilled') allAlerts.push(...upcomingDueDates.value);
    if (latePaymentPattern.status === 'fulfilled') allAlerts.push(...latePaymentPattern.value);
    if (interestCharges.status === 'fulfilled') allAlerts.push(...interestCharges.value);
    if (cashFlowGap.status === 'fulfilled') allAlerts.push(...cashFlowGap.value);
  } catch (error) {
    console.error('[Alerts Detector] Erro ao detectar alertas:', error);
  }

  // Ordenar por severidade (CRITICAL > HIGH > MEDIUM > LOW)
  const severityOrder = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  allAlerts.sort((a, b) => (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0));

  // Limitar a 15 alertas mais relevantes (aumentado de 10 para comportar novos detectores)
  return allAlerts.slice(0, 15);

}
