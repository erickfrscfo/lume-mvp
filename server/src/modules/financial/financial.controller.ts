import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../auth/auth.middleware.js";
import { prisma } from "../../shared/database.js";
import { getDREProfile, isDirectCost, isTax, AVAILABLE_SECTORS } from "../../shared/dre-profiles.js";
import { generateAlerts } from "../alerts/alerts.controller.js";
import { resolveCompanyCategories } from "../../shared/resolve-categories.js";
import * as aiService from "../ai/ai.service.js";
import { z } from "zod";

const router = Router();
const prismaDynamic = prisma as any;

// ============================================
// HELPER: Parsear data sem problema de timezone
// Quando recebe "2025-11-03" (sem hora), adiciona T12:00:00 para
// evitar que new Date() interprete como UTC meia-noite e cause D-1
// ============================================
function parseLocalDate(dateStr: string | Date): Date {
  if (dateStr instanceof Date) return dateStr;
  if (!dateStr) return new Date();
  // Se já tem hora (T ou espaço), não mexe
  if (dateStr.includes('T') || dateStr.includes(' ')) return new Date(dateStr);
  // Se é formato DD/MM/AAAA, converte para Date local
  if (dateStr.includes('/')) {
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]), 12, 0, 0);
    }
  }
  // Formato YYYY-MM-DD: adiciona meio-dia para evitar D-1
  return new Date(dateStr + 'T12:00:00');
}

// ============================================
// HELPER: Obter data efetiva de caixa
// Para EXPENSE: paymentDate (fallback: transaction.date)
// Para INCOME: receiptDate (fallback: transaction.date)
// ============================================
function getEffectiveDate(tx: any): Date {
  if (tx.tipo_transacao === "EXPENSE") {
    return tx.detail?.paymentDate || tx.date;
  } else {
    return tx.detail?.receiptDate || tx.date;
  }
}

async function resolveCategoryId(input: {
  companyId: string;
  categoryId?: string | null;
  categoryCode?: string | null;
  tipoTransacao?: "INCOME" | "EXPENSE";
}): Promise<string | null> {
  const { categoryId, categoryCode, tipoTransacao } = input;

  if (categoryCode) {
    const category = await prisma.category.findFirst({
      where: {
        code: categoryCode,
        ...(tipoTransacao ? { type: tipoTransacao } : {}),
      },
      select: { id: true },
    });
    return category?.id || null;
  }

  if (!categoryId) return null;

  if (categoryId.startsWith("custom:")) {
    const code = categoryId.replace("custom:", "");
    const category = await prisma.category.findFirst({
      where: {
        code,
        ...(tipoTransacao ? { type: tipoTransacao } : {}),
      },
      select: { id: true },
    });
    return category?.id || null;
  }

  const category = await prisma.category.findUnique({
    where: { id: categoryId },
    select: { id: true, type: true },
  });

  if (!category) return null;
  if (tipoTransacao && category.type !== tipoTransacao) return null;
  return category.id;
}

function formatMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function daysBetween(start: Date, end: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.max(0, Math.round((endUtc - startUtc) / msPerDay));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function mapObligationInstallment(item: any) {
  const dueDate = item.dueDate ? new Date(item.dueDate) : null;
  const today = new Date();
  const daysUntilDue = dueDate ? daysBetween(today, dueDate) : null;
  const isOverdue = Boolean(dueDate && dueDate < today && item.status !== "PAID");

  return {
    id: item.id,
    obligationId: item.obligationId,
    installmentId: item.id,
    isInstallment: true,
    installmentNumber: item.installmentNumber,
    totalInstallments: item.totalInstallments,
    status: isOverdue ? "OVERDUE" : item.status,
    amount: Number(item.amount),
    dueDate: item.dueDate,
    expectedPaymentDate: item.expectedPaymentDate,
    documentNumber: item.documentNumber,
    barcode: item.barcode,
    lateFeeAmount: item.lateFeeAmount ? Number(item.lateFeeAmount) : null,
    lateFeePercent: item.lateFeePercent ? Number(item.lateFeePercent) : null,
    lateInterestPercentPerDay: item.lateInterestPercentPerDay ? Number(item.lateInterestPercentPerDay) : null,
    paymentLimitDate: item.paymentLimitDate,
    daysUntilDue,
    isOverdue,
    obligation: item.obligation ? {
      id: item.obligation.id,
      type: item.obligation.type,
      status: item.obligation.status,
      source: item.obligation.source,
      description: item.obligation.description,
      amount: Number(item.obligation.amount),
      issueDate: item.obligation.issueDate,
      dueDate: item.obligation.dueDate,
      documentNumber: item.obligation.documentNumber,
      totalInstallments: item.obligation.totalInstallments,
      taxDetails: item.obligation.taxDetails || [],
      totalTaxAmount: item.obligation.totalTaxAmount ? Number(item.obligation.totalTaxAmount) : null,
      totalWithholdingAmount: item.obligation.totalWithholdingAmount ? Number(item.obligation.totalWithholdingAmount) : null,
      counterparty: item.obligation.counterparty ? {
        id: item.obligation.counterparty.id,
        name: item.obligation.counterparty.name,
        document: item.obligation.counterparty.document,
        type: item.obligation.counterparty.type,
      } : null,
      category: item.obligation.category ? {
        id: item.obligation.category.id,
        code: item.obligation.category.code,
        name: item.obligation.category.name,
      } : null,
    } : null,
    transaction: item.transactions?.[0] ? {
      id: item.transactions[0].id,
      status: item.transactions[0].status,
      amount: Number(item.transactions[0].amount),
      description: item.transactions[0].description,
    } : null,
  };
}

function mapStandaloneObligation(item: any) {
  const dueDate = item.dueDate ? new Date(item.dueDate) : null;
  const today = new Date();
  const daysUntilDue = dueDate ? daysBetween(today, dueDate) : null;
  const isOverdue = Boolean(dueDate && dueDate < today && item.status !== "PAID");

  return {
    id: `obligation:${item.id}`,
    obligationId: item.id,
    installmentId: null,
    isInstallment: false,
    installmentNumber: 1,
    totalInstallments: item.totalInstallments || 1,
    status: isOverdue ? "OVERDUE" : item.status,
    amount: Number(item.amount),
    dueDate: item.dueDate,
    expectedPaymentDate: item.expectedPaymentDate,
    documentNumber: item.documentNumber,
    barcode: item.barcode,
    lateFeeAmount: item.lateFeeAmount ? Number(item.lateFeeAmount) : null,
    lateFeePercent: item.lateFeePercent ? Number(item.lateFeePercent) : null,
    lateInterestPercentPerDay: item.lateInterestPercentPerDay ? Number(item.lateInterestPercentPerDay) : null,
    paymentLimitDate: item.paymentLimitDate,
    daysUntilDue,
    isOverdue,
    obligation: {
      id: item.id,
      type: item.type,
      status: item.status,
      source: item.source,
      description: item.description,
      amount: Number(item.amount),
      issueDate: item.issueDate,
      dueDate: item.dueDate,
      documentNumber: item.documentNumber,
      totalInstallments: item.totalInstallments || 1,
      taxDetails: item.taxDetails || [],
      totalTaxAmount: item.totalTaxAmount ? Number(item.totalTaxAmount) : null,
      totalWithholdingAmount: item.totalWithholdingAmount ? Number(item.totalWithholdingAmount) : null,
      counterparty: item.counterparty ? {
        id: item.counterparty.id,
        name: item.counterparty.name,
        document: item.counterparty.document,
        type: item.counterparty.type,
      } : null,
      category: item.category ? {
        id: item.category.id,
        code: item.category.code,
        name: item.category.name,
      } : null,
    },
    transaction: item.transactions?.[0] ? {
      id: item.transactions[0].id,
      status: item.transactions[0].status,
      amount: Number(item.transactions[0].amount),
      description: item.transactions[0].description,
    } : null,
  };
}

// ============================================
// GET /api/financial/dashboard
// REGIME DE CAIXA: apenas transações COMPLETED, agrupadas por data efetiva
// Inclui dados de transações pendentes para indicador de UX
// ============================================
router.get("/dashboard", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const now = new Date();
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1);

    // ============================================
    // SALDO DE CAIXA: apenas transações COMPLETED (pagas/recebidas)
    // ============================================
    const completedTransactions = await prisma.transaction.findMany({
      where: { companyId, status: "COMPLETED" },
      include: { detail: true },
    });

    const totalIncome = completedTransactions
      .filter((t) => t.tipo_transacao === "INCOME")
      .reduce((s, t) => s + Number(t.amount), 0);
    const totalExpense = completedTransactions
      .filter((t) => t.tipo_transacao === "EXPENSE")
      .reduce((s, t) => s + Number(t.amount), 0);
    const cashBalance = totalIncome - totalExpense;

    // Filtrar últimos 6 meses usando data efetiva
    const recentTransactions = completedTransactions.filter((t) => {
      const effectiveDate = getEffectiveDate(t);
      return effectiveDate >= sixMonthsAgo;
    });

    // ============================================
    // BURN RATE: média mensal usando data efetiva de caixa
    // ============================================
    const monthlyData: Record<string, { income: number; expense: number }> = {};
    recentTransactions.forEach((t) => {
      const effectiveDate = getEffectiveDate(t);
      const monthKey = formatMonthKey(effectiveDate);
      if (!monthlyData[monthKey]) monthlyData[monthKey] = { income: 0, expense: 0 };
      if (t.tipo_transacao === "INCOME") {
        monthlyData[monthKey].income += Number(t.amount);
      } else {
        monthlyData[monthKey].expense += Number(t.amount);
      }
    });

    const monthKeys = Object.keys(monthlyData).sort();
    const numMonths = monthKeys.length;

    let avgNetBurn = 0;
    if (numMonths > 0) {
      const totalNetBurn = monthKeys.reduce((sum, mk) => {
        return sum + (monthlyData[mk].expense - monthlyData[mk].income);
      }, 0);
      avgNetBurn = totalNetBurn / numMonths;
    }

    const burnRate = avgNetBurn > 0 ? avgNetBurn : 0;

    // ============================================
    // RUNWAY
    // ============================================
    let runway: number;
    if (cashBalance <= 0) {
      runway = 0;
    } else if (burnRate <= 0) {
      runway = 99;
    } else {
      runway = cashBalance / burnRate;
      if (runway > 99) runway = 99;
    }

    // Variação do saldo
    const lastMonthKey = monthKeys.length > 0 ? monthKeys[monthKeys.length - 1] : null;
    let cashBalanceChange = 0;
    if (lastMonthKey && monthlyData[lastMonthKey]) {
      const lastMonthNet = monthlyData[lastMonthKey].income - monthlyData[lastMonthKey].expense;
      const previousBalance = cashBalance - lastMonthNet;
      if (previousBalance !== 0) {
        cashBalanceChange = ((cashBalance - previousBalance) / Math.abs(previousBalance)) * 100;
      }
    }

    // Crescimento de receita
    let growth = 0;
    if (monthKeys.length >= 2) {
      const lastMk = monthKeys[monthKeys.length - 1];
      const prevMk = monthKeys[monthKeys.length - 2];
      const lastInc = monthlyData[lastMk].income;
      const prevInc = monthlyData[prevMk].income;
      if (prevInc > 0) {
        growth = ((lastInc - prevInc) / prevInc) * 100;
      }
    }

    // ============================================
    // TRANSAÇÕES PENDENTES: indicador de UX
    // Mostra ao usuário quanto ainda não foi contabilizado no caixa
    // ============================================
    const pendingTransactions = await prisma.transaction.findMany({
      where: {
        companyId,
        status: { in: ["PENDING", "OVERDUE"] },
      },
      select: {
        amount: true,
        tipo_transacao: true,
        status: true,
        detail: {
          select: {
            dueDate: true,
            paymentDate: true,
            receiptDate: true,
          },
        },
      },
    });

    const pendingExpenses = pendingTransactions
      .filter((t) => t.tipo_transacao === "EXPENSE")
      .reduce((s, t) => s + Number(t.amount), 0);
    const pendingIncomes = pendingTransactions
      .filter((t) => t.tipo_transacao === "INCOME")
      .reduce((s, t) => s + Number(t.amount), 0);
    const overdueTransactions = pendingTransactions.filter((t) => {
      if (!t.detail?.dueDate) return t.status === "OVERDUE";
      const isExpenseOpen = t.tipo_transacao === "EXPENSE" && !t.detail.paymentDate;
      const isIncomeOpen = t.tipo_transacao === "INCOME" && !t.detail.receiptDate;
      return t.detail.dueDate < now && (isExpenseOpen || isIncomeOpen);
    });
    const overdueExpenses = overdueTransactions
      .filter((t) => t.tipo_transacao === "EXPENSE")
      .reduce((s, t) => s + Number(t.amount), 0);
    const overdueIncomes = overdueTransactions
      .filter((t) => t.tipo_transacao === "INCOME")
      .reduce((s, t) => s + Number(t.amount), 0);
    const overdueCount = overdueTransactions.length;

    // ============================================
    // PRAZOS E CICLO FINANCEIRO
    // Calculado sobre transações concluídas dos últimos 6 meses.
    // ============================================
    const completedIncomes = recentTransactions.filter((t) => t.tipo_transacao === "INCOME" && t.detail?.receiptDate);
    const completedExpenses = recentTransactions.filter((t) => t.tipo_transacao === "EXPENSE" && t.detail?.paymentDate);

    const receivableDays = completedIncomes.map((t) => daysBetween(t.date, t.detail!.receiptDate!));
    const payableDays = completedExpenses.map((t) => daysBetween(t.date, t.detail!.paymentDate!));
    const avgDaysToReceive = average(receivableDays);
    const avgDaysToPay = average(payableDays);
    const cashCycleDays = avgDaysToReceive - avgDaysToPay;

    const incomesWithDueDate = completedIncomes.filter((t) => t.detail?.dueDate);
    const expensesWithDueDate = completedExpenses.filter((t) => t.detail?.dueDate);
    const incomesOnTime = incomesWithDueDate.filter((t) => t.detail!.receiptDate! <= t.detail!.dueDate!).length;
    const expensesOnTime = expensesWithDueDate.filter((t) => t.detail!.paymentDate! <= t.detail!.dueDate!).length;
    const receivablesOnTimeRate = incomesWithDueDate.length > 0 ? (incomesOnTime / incomesWithDueDate.length) * 100 : 0;
    const payablesOnTimeRate = expensesWithDueDate.length > 0 ? (expensesOnTime / expensesWithDueDate.length) * 100 : 0;

    res.json({
      success: true,
      data: {
        cashBalance: { value: cashBalance, change: cashBalanceChange },
        burnRate: { value: burnRate, change: 0 },
        runway: { value: runway, change: 0 },
        growth: { value: growth, change: 0 },
        transactionCount: completedTransactions.length,
        // NOVO: dados de transações pendentes
        pending: {
          count: pendingTransactions.length,
          totalExpenses: pendingExpenses,
          totalIncomes: pendingIncomes,
          overdueExpenses,
          overdueIncomes,
          overdueAmount: overdueExpenses + overdueIncomes,
          overdueCount,
        },
        terms: {
          avgDaysToReceive,
          avgDaysToPay,
          cashCycleDays,
          receivablesOnTimeRate,
          payablesOnTimeRate,
          receivablesCount: completedIncomes.length,
          payablesCount: completedExpenses.length,
          receivablesWithDueDateCount: incomesWithDueDate.length,
          payablesWithDueDateCount: expensesWithDueDate.length,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET /api/financial/cashflow
// REGIME DE CAIXA: apenas COMPLETED, agrupado por data efetiva
// CORREÇÃO: Retorna initialBalance (saldo das transações anteriores ao período)
// para que o gráfico de saldo acumulado seja consistente com o card de Saldo de Caixa
// ============================================
router.get("/cashflow", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const months = parseInt(req.query.months as string) || 12;
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    const transactions = await prisma.transaction.findMany({
      where: { companyId, status: "COMPLETED" },
      include: { detail: true },
    });

    // CORREÇÃO: Calcular saldo das transações ANTERIORES ao período exibido
    // Antes, essas transações eram simplesmente descartadas com "return",
    // causando divergência entre o saldo do card (que soma tudo) e o gráfico (que partia de 0)
    let initialBalance = 0;
    const monthlyMap: Record<string, { income: number; expense: number }> = {};

    transactions.forEach((t) => {
      const effectiveDate = getEffectiveDate(t);
      const amount = Number(t.amount);

      if (effectiveDate < startDate) {
        // Transação anterior ao período → acumula no saldo inicial
        if (t.tipo_transacao === "INCOME") {
          initialBalance += amount;
        } else {
          initialBalance -= amount;
        }
        return;
      }

      // Transação dentro do período → agrupa por mês normalmente
      const monthKey = formatMonthKey(effectiveDate);
      if (!monthlyMap[monthKey]) monthlyMap[monthKey] = { income: 0, expense: 0 };
      if (t.tipo_transacao === "INCOME") {
        monthlyMap[monthKey].income += amount;
      } else {
        monthlyMap[monthKey].expense += amount;
      }
    });

    const result = Object.entries(monthlyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({
        month,
        income: data.income,
        expense: data.expense,
        net: data.income - data.expense,
      }));

    // CORREÇÃO: Retornar initialBalance junto com os dados mensais
    res.json({ success: true, data: result, initialBalance });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET /api/financial/dre
// REGIME DE CAIXA: apenas COMPLETED, agrupado por data efetiva
// ============================================
router.get("/dre", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const months = parseInt(req.query.months as string) || 7;
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    // Buscar o setor da empresa para determinar o perfil de DRE
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { sector: true },
    });

    const profile = getDREProfile(company?.sector || "MISTO");

    const transactions = await prisma.transaction.findMany({
      where: { companyId, status: "COMPLETED" },
      include: { category: true, detail: true },
    });

    // Agrupar por mês (data efetiva) e categoria
    // CORREÇÃO: Fallback inteligente para transações sem categoria ou com categoria inconsistente
    const dreData: Record<string, Record<string, number>> = {};
    transactions.forEach((t) => {
      const effectiveDate = getEffectiveDate(t);
      if (effectiveDate < startDate) return; // Fora do período

      const monthKey = formatMonthKey(effectiveDate);
      let catCode = t.category?.code || "0.0";
      const catPrefix = catCode.split(".")[0];

      // FALLBACK 1: Transação sem categoria → usar tipo_transacao como fallback
      if (catCode === "0.0") {
        if (t.tipo_transacao === "INCOME") {
          catCode = "2.5"; // Outras Receitas
        } else {
          catCode = "5.0"; // Despesas Operacionais (genérico)
        }
      }

      // FALLBACK 2: Despesa com categoria de receita (1.x ou 2.x) → reclassificar
      if (t.tipo_transacao === "EXPENSE" && (catPrefix === "1" || catPrefix === "2")) {
        catCode = "5.0"; // Despesas Operacionais (genérico)
        console.warn(`[DRE] Inconsistência: despesa "${t.description}" (${t.id}) tem categoria de receita ${t.category?.code}. Usando fallback 5.0.`);
      }

      // FALLBACK 3: Receita com categoria de despesa (3.x a 8.x) → reclassificar
      if (t.tipo_transacao === "INCOME" && parseInt(catPrefix) >= 3) {
        catCode = "2.5"; // Outras Receitas
        console.warn(`[DRE] Inconsistência: receita "${t.description}" (${t.id}) tem categoria de despesa ${t.category?.code}. Usando fallback 2.5.`);
      }

      if (!dreData[monthKey]) dreData[monthKey] = {};
      dreData[monthKey][catCode] = (dreData[monthKey][catCode] || 0) + Number(t.amount);
    });

    res.json({
      success: true,
      data: dreData,
      profile: {
        sectorKey: profile.sectorKey,
        sectorLabel: profile.sectorLabel,
        directCostLabel: profile.directCostLabel,
        grossProfitLabel: profile.grossProfitLabel,
        directCostCodes: profile.directCostCodes,
        excludeFromDirectCost: profile.excludeFromDirectCost,
        taxCodes: profile.taxCodes,
        incomeTaxCodes: profile.incomeTaxCodes,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/financial/sectors — Lista de setores disponíveis
router.get("/sectors", authMiddleware, async (_req: Request, res: Response) => {
  res.json({ success: true, data: AVAILABLE_SECTORS });
});

// ============================================
// GET /api/financial/obligations — Parcelas de obrigações financeiras
// ============================================
router.get("/obligations", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const horizonDays = Math.max(30, Math.min(365, parseInt(req.query.horizonDays as string, 10) || 120));
    const type = req.query.type as string;
    const status = req.query.status as string;
    const now = new Date();
    const horizonDate = addDays(now, horizonDays);

    const where: any = {
      companyId,
      dueDate: { lte: horizonDate },
    };

    if (status && status !== "all") {
      where.status = status;
    } else {
      where.status = { in: ["PENDING", "OVERDUE", "PARTIAL"] };
    }

    if (type === "PAYABLE" || type === "RECEIVABLE") {
      where.obligation = { type };
    }

    const obligationWhere: any = {
      companyId,
      dueDate: { lte: horizonDate },
      installments: { none: {} },
    };
    if (status && status !== "all") {
      obligationWhere.status = status;
    } else {
      obligationWhere.status = { in: ["PENDING", "OVERDUE", "PARTIAL"] };
    }
    if (type === "PAYABLE" || type === "RECEIVABLE") {
      obligationWhere.type = type;
    }

    const [installments, standaloneObligations] = await Promise.all([
      prismaDynamic.obligationInstallment.findMany({
        where,
        include: {
          obligation: {
            include: {
              counterparty: { select: { id: true, name: true, document: true, type: true } },
              category: { select: { id: true, code: true, name: true } },
            },
          },
          transactions: { select: { id: true, status: true, amount: true, description: true }, take: 1, orderBy: { createdAt: "asc" } },
        },
        orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      }),
      prismaDynamic.financialObligation.findMany({
        where: obligationWhere,
        include: {
          counterparty: { select: { id: true, name: true, document: true, type: true } },
          category: { select: { id: true, code: true, name: true } },
          transactions: { select: { id: true, status: true, amount: true, description: true }, take: 1, orderBy: { createdAt: "asc" } },
        },
        orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      }),
    ]);

    const mapped = [
      ...installments.map(mapObligationInstallment),
      ...standaloneObligations.map(mapStandaloneObligation),
    ].sort((a, b) => {
      const aTime = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });
    const buckets = [
      { key: "overdue", label: "Vencidas", from: -Infinity, to: -1 },
      { key: "30", label: "Próximos 30 dias", from: 0, to: 30 },
      { key: "60", label: "31 a 60 dias", from: 31, to: 60 },
      { key: "90", label: "61 a 90 dias", from: 61, to: 90 },
      { key: "120", label: "91 a 120 dias", from: 91, to: 120 },
    ].map((bucket) => {
      const items = mapped.filter((item: any) => {
        if (bucket.key === "overdue") return item.isOverdue;
        if (item.daysUntilDue === null || item.isOverdue) return false;
        return item.daysUntilDue >= bucket.from && item.daysUntilDue <= bucket.to;
      });
      return {
        ...bucket,
        count: items.length,
        totalAmount: items.reduce((sum: number, item: any) => sum + item.amount, 0),
        items,
      };
    });

    res.json({
      success: true,
      data: {
        summary: {
          count: mapped.length,
          totalAmount: mapped.reduce((sum: number, item: any) => sum + item.amount, 0),
          overdueAmount: buckets.find((bucket) => bucket.key === "overdue")?.totalAmount || 0,
          horizonDays,
        },
        buckets,
        installments: mapped,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET /api/financial/transactions
// Adicionados filtros: status, dueDateStart, dueDateEnd
// ============================================
router.get("/transactions", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const type = req.query.type as string;
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const costType = req.query.costType as string;
    const status = req.query.status as string;
    const dueDateStart = req.query.dueDateStart as string;
    const dueDateEnd = req.query.dueDateEnd as string;

    const where: any = { companyId };
    if (type === "INCOME" || type === "EXPENSE") where.tipo_transacao = type;

    // Filtro por tipo de custo
    if (costType === "FIXO" || costType === "VARIAVEL") {
      where.tipo_custo = costType;
    } else if (costType === "PENDING") {
      where.tipo_custo = null;
      where.tipo_transacao = "EXPENSE";
    }

    // NOVO: Filtro por status
    // CORREÇÃO: Para "OVERDUE", não basta filtrar por status no banco,
    // pois muitas transações vencidas ainda têm status="PENDING" (nunca foram atualizadas).
    // A detecção de vencimento é feita dinamicamente: dueDate < agora E sem pagamento/recebimento.
    if (status === "COMPLETED" || status === "PENDING") {
      where.status = status;
    } else if (status === "OVERDUE") {
      // Buscar transações PENDING ou OVERDUE que têm dueDate no passado e não foram pagas/recebidas
      where.status = { in: ["PENDING", "OVERDUE"] };
      where.detail = {
        ...where.detail,
        dueDate: {
          ...(where.detail?.dueDate || {}),
          lt: new Date(), // dueDate antes de agora = vencida
        },
        paymentDate: null,
        receiptDate: null,
      };
    }

    // Filtro de data de emissão/criação
    // CORREÇÃO TIMEZONE: Usar T00:00:00.000Z (meia-noite UTC) em vez de T03:00:00.000Z.
    // As datas no banco são armazenadas como UTC meia-noite (ex: 2026-04-01T00:00:00.000Z).
    // Com T03:00:00.000Z, o filtro gte para "2026-04-01" virava 01/04 03:00 UTC,
    // excluindo transações de 01/04 00:00 UTC (5 transações sumiam de abril).
    if (startDate || endDate) {
      where.date = {};
      if (startDate) {
        where.date.gte = new Date(startDate + "T00:00:00.000Z");
      }
      if (endDate) {
        const endDateObj = new Date(endDate + "T00:00:00.000Z");
        endDateObj.setDate(endDateObj.getDate() + 1);
        endDateObj.setMilliseconds(endDateObj.getMilliseconds() - 1);
        where.date.lte = endDateObj;
      }
    }

    // NOVO: Filtro por data de vencimento (via TransactionDetail)
    // CORREÇÃO TIMEZONE: Mesma lógica — usar T00:00:00.000Z para consistência com datas UTC.
    // CORREÇÃO: Usar spread para não sobrescrever where.detail já definido pelo filtro OVERDUE.
    if (dueDateStart || dueDateEnd) {
      if (!where.detail) where.detail = {};
      const existingDueDate = where.detail.dueDate || {};
      if (dueDateStart) {
        where.detail.dueDate = { ...existingDueDate, gte: new Date(dueDateStart + "T00:00:00.000Z") };
      }
      if (dueDateEnd) {
        const dueDateEndObj = new Date(dueDateEnd + "T00:00:00.000Z");
        dueDateEndObj.setDate(dueDateEndObj.getDate() + 1);
        dueDateEndObj.setMilliseconds(dueDateEndObj.getMilliseconds() - 1);
        where.detail.dueDate = { ...(where.detail.dueDate || {}), lte: dueDateEndObj };
      }
    }

    const [transactions, total] = await Promise.all([
      prismaDynamic.transaction.findMany({
        where,
        include: {
          category: true,
          counterparty: { select: { id: true, name: true, document: true, type: true } },
          detail: true,
          installment: {
            select: {
              id: true,
              installmentNumber: true,
              totalInstallments: true,
              status: true,
              amount: true,
              dueDate: true,
              documentNumber: true,
              barcode: true,
            },
          },
          obligation: {
            select: {
              id: true,
              type: true,
              status: true,
              source: true,
              documentNumber: true,
              barcode: true,
              earlyDiscountAmount: true,
              earlyDiscountPercent: true,
              earlyDiscountValidUntil: true,
              lateFeeAmount: true,
              lateFeePercent: true,
              lateInterestPercentPerDay: true,
              paymentLimitDate: true,
              taxDetails: true,
              totalTaxAmount: true,
              totalWithholdingAmount: true,
            },
          },
        },
        orderBy: { date: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.transaction.count({ where }),
    ]);

    res.json({
      success: true,
      data: transactions.map((t: any) => ({
        id: t.id,
        date: t.date,
        description: t.description,
        amount: Number(t.amount),
        tipo_transacao: t.tipo_transacao,
        tipo_custo: t.tipo_custo,
        costConfidence: t.costConfidence ? Number(t.costConfidence) : null,
        status: t.status,
        source: t.source,
        category: t.category ? { id: t.category.id, code: t.category.code, name: t.category.name } : null,
        counterparty: t.counterparty ? {
          id: t.counterparty.id,
          name: t.counterparty.name,
          document: t.counterparty.document,
          type: t.counterparty.type,
        } : null,
        detail: t.detail ? {
          dueDate: t.detail.dueDate,
          paymentDate: t.detail.paymentDate,
          receiptDate: t.detail.receiptDate,
          amountOriginal: t.detail.amountOriginal ? Number(t.detail.amountOriginal) : null,
          amountPaid: t.detail.amountPaid ? Number(t.detail.amountPaid) : null,
          amountReceived: t.detail.amountReceived ? Number(t.detail.amountReceived) : null,
          discount: t.detail.discount ? Number(t.detail.discount) : null,
          interest: t.detail.interest ? Number(t.detail.interest) : null,
          documentNumber: t.detail.documentNumber,
          bankReference: t.detail.bankReference,
          reconciliationStatus: t.detail.reconciliationStatus,
          notes: t.detail.notes,
        } : null,
        installment: t.installment ? {
          id: t.installment.id,
          installmentNumber: t.installment.installmentNumber,
          totalInstallments: t.installment.totalInstallments,
          status: t.installment.status,
          amount: Number(t.installment.amount),
          dueDate: t.installment.dueDate,
          documentNumber: t.installment.documentNumber,
          barcode: t.installment.barcode,
        } : null,
        obligation: t.obligation ? {
          id: t.obligation.id,
          type: t.obligation.type,
          status: t.obligation.status,
          source: t.obligation.source,
          documentNumber: t.obligation.documentNumber,
          barcode: t.obligation.barcode,
          earlyDiscountAmount: t.obligation.earlyDiscountAmount ? Number(t.obligation.earlyDiscountAmount) : null,
          earlyDiscountPercent: t.obligation.earlyDiscountPercent ? Number(t.obligation.earlyDiscountPercent) : null,
          earlyDiscountValidUntil: t.obligation.earlyDiscountValidUntil,
          lateFeeAmount: t.obligation.lateFeeAmount ? Number(t.obligation.lateFeeAmount) : null,
          lateFeePercent: t.obligation.lateFeePercent ? Number(t.obligation.lateFeePercent) : null,
          lateInterestPercentPerDay: t.obligation.lateInterestPercentPerDay ? Number(t.obligation.lateInterestPercentPerDay) : null,
          paymentLimitDate: t.obligation.paymentLimitDate,
          taxDetails: t.obligation.taxDetails || [],
          totalTaxAmount: t.obligation.totalTaxAmount ? Number(t.obligation.totalTaxAmount) : null,
          totalWithholdingAmount: t.obligation.totalWithholdingAmount ? Number(t.obligation.totalWithholdingAmount) : null,
        } : null,
        aiClassified: t.aiClassified,
        confidence: t.confidence ? Number(t.confidence) : null,
        notes: t.notes,
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/financial/transactions
// Aceita counterpartyId (se já existe) OU counterpartyName (texto livre, cria automaticamente)
router.post("/transactions", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { date, description, amount, type, notes, counterpartyId, counterpartyName, dueDate, paymentDate, receiptDate, documentNumber, categoryId, categoryCode } = req.body;

    if (!date || !description || !amount || !type) {
      return res.status(400).json({ success: false, error: "Campos obrigatórios: date, description, amount, type" });
    }

    const tipo_transacao = (type === "INCOME" || type === "ENTRADA") ? "INCOME" : "EXPENSE";
    const resolvedCategoryId = await resolveCategoryId({
      companyId,
      categoryId,
      categoryCode,
      tipoTransacao: tipo_transacao,
    });

    // Status derivado de paymentDate/receiptDate
    let status = "PENDING";
    if (tipo_transacao === "EXPENSE" && paymentDate) {
      status = "COMPLETED";
    } else if (tipo_transacao === "INCOME" && receiptDate) {
      status = "COMPLETED";
    }

    // Resolver contraparte: se veio counterpartyName (texto livre), buscar ou criar
    let resolvedCounterpartyId = counterpartyId || null;
    if (!resolvedCounterpartyId && counterpartyName && counterpartyName.trim()) {
      const trimmedName = counterpartyName.trim();
      // Buscar contraparte existente pelo nome (case-insensitive)
      const existing = await prisma.counterparty.findFirst({
        where: {
          companyId,
          name: { equals: trimmedName, mode: "insensitive" },
        },
      });
      if (existing) {
        resolvedCounterpartyId = existing.id;
      } else {
        // Criar nova contraparte automaticamente
        const newCp = await prisma.counterparty.create({
          data: {
            companyId,
            name: trimmedName,
            type: tipo_transacao === "EXPENSE" ? "SUPPLIER" : "CLIENT",
          },
        });
        resolvedCounterpartyId = newCp.id;
      }
    }

    const transaction = await prisma.transaction.create({
      data: {
        companyId,
        date: parseLocalDate(date),
        description,
        amount: Math.abs(parseFloat(amount)),
        tipo_transacao,
        status: status as any,
        source: "MANUAL",
        counterpartyId: resolvedCounterpartyId,
        categoryId: resolvedCategoryId,
        notes: notes || "",
      },
    });

    // Criar TransactionDetail para armazenar datas financeiras
    await prisma.transactionDetail.create({
      data: {
        transactionId: transaction.id,
        counterpartyId: resolvedCounterpartyId,
        dueDate: dueDate ? parseLocalDate(dueDate) : null,
        paymentDate: paymentDate ? parseLocalDate(paymentDate) : null,
        receiptDate: receiptDate ? parseLocalDate(receiptDate) : null,
        documentNumber: documentNumber || null,
        amountOriginal: Math.abs(parseFloat(amount)),
      },
    });

    // Regenerar alertas em background
    const userId = (req as any).userId;
    if (userId) {
      generateAlerts(companyId, userId).catch(err => console.error('[Financial] Erro ao gerar alertas após criação:', err));
    }

    // Classificação de categoria por IA em background (se não veio categoryId do frontend)
    if (!resolvedCategoryId) {
      classifyManualTransaction(transaction.id, companyId, userId, description, Math.abs(parseFloat(amount)), tipo_transacao)
        .catch(err => console.error('[Financial] Erro na classificação IA da transação manual:', err));
    }

    res.json({ success: true, data: transaction });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/financial/transactions/:id
router.delete("/transactions/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;

    const transaction = await prisma.transaction.findFirst({
      where: { id, companyId },
    });

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transação não encontrada" });
    }

    await prisma.transaction.delete({ where: { id } });
    res.json({ success: true, message: "Transação excluída" });
  } catch (error) {
    next(error);
  }
});

// ============================================
// PATCH /api/financial/transactions/:id — Editar transação e detalhes
// ============================================
router.patch("/transactions/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;

    const transaction = await prisma.transaction.findFirst({
      where: { id, companyId },
    });

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transação não encontrada" });
    }

    const {
      date, description, amount, notes, counterpartyId, categoryId, categoryCode,
      dueDate, paymentDate, receiptDate,
      amountPaid, amountReceived, discount, interest,
      documentNumber, bankReference, reconciliationNotes,
    } = req.body;

    // Atualizar campos da transação principal
    const txUpdateData: any = {};
    if (date !== undefined) txUpdateData.date = parseLocalDate(date);
    if (description !== undefined) txUpdateData.description = description;
    if (amount !== undefined) txUpdateData.amount = Math.abs(parseFloat(amount));
    if (notes !== undefined) txUpdateData.notes = notes;
    if (counterpartyId !== undefined) txUpdateData.counterpartyId = counterpartyId || null;
    if (categoryId !== undefined || categoryCode !== undefined) {
      txUpdateData.categoryId = await resolveCategoryId({
        companyId,
        categoryId,
        categoryCode,
        tipoTransacao: transaction.tipo_transacao,
      });
    }

    // Status derivado: se paymentDate/receiptDate preenchido = COMPLETED, senão = PENDING
    if (paymentDate !== undefined || receiptDate !== undefined) {
      const tipo = transaction.tipo_transacao;
      const existingDetail = await prisma.transactionDetail.findUnique({
        where: { transactionId: id },
      });

      const effectivePaymentDate = paymentDate !== undefined ? paymentDate : existingDetail?.paymentDate;
      const effectiveReceiptDate = receiptDate !== undefined ? receiptDate : existingDetail?.receiptDate;

      if ((tipo === "EXPENSE" && effectivePaymentDate) || (tipo === "INCOME" && effectiveReceiptDate)) {
        txUpdateData.status = "COMPLETED";
      } else {
        const effectiveDueDate = dueDate !== undefined ? dueDate : existingDetail?.dueDate;
        if (effectiveDueDate && new Date(effectiveDueDate) < new Date()) {
          txUpdateData.status = "OVERDUE";
        } else {
          txUpdateData.status = "PENDING";
        }
      }
    }

    if (Object.keys(txUpdateData).length > 0) {
      await prisma.transaction.update({
        where: { id },
        data: txUpdateData,
      });
    }

    // Atualizar ou criar detail
    const hasDetailFields = dueDate !== undefined || paymentDate !== undefined || receiptDate !== undefined ||
      amountPaid !== undefined || amountReceived !== undefined || discount !== undefined ||
      interest !== undefined || documentNumber !== undefined || bankReference !== undefined ||
      reconciliationNotes !== undefined;

    if (hasDetailFields) {
      const detailData: any = {};
      if (dueDate !== undefined) detailData.dueDate = dueDate ? parseLocalDate(dueDate) : null;
      if (paymentDate !== undefined) detailData.paymentDate = paymentDate ? parseLocalDate(paymentDate) : null;
      if (receiptDate !== undefined) detailData.receiptDate = receiptDate ? parseLocalDate(receiptDate) : null;
      if (amountPaid !== undefined) detailData.amountPaid = amountPaid ? parseFloat(amountPaid) : null;
      if (amountReceived !== undefined) detailData.amountReceived = amountReceived ? parseFloat(amountReceived) : null;
      if (discount !== undefined) detailData.discount = discount ? parseFloat(discount) : null;
      if (interest !== undefined) detailData.interest = interest ? parseFloat(interest) : null;
      if (documentNumber !== undefined) detailData.documentNumber = documentNumber || null;
      if (bankReference !== undefined) detailData.bankReference = bankReference || null;
      if (reconciliationNotes !== undefined) detailData.notes = reconciliationNotes || null;

      // NÃO setar reconciliationStatus aqui — conciliação é feita apenas
      // via match com extrato bancário (POST /api/reconciliations/batch)

      await prisma.transactionDetail.upsert({
        where: { transactionId: id },
        create: {
          transactionId: id,
          amountOriginal: transaction.amount,
          ...detailData,
        },
        update: detailData,
      });
    }

    const updated = await prisma.transaction.findUnique({
      where: { id },
      include: {
        category: true,
        counterparty: { select: { id: true, name: true, document: true, type: true } },
        detail: true,
      },
    });

    const patchUserId = (req as any).userId;
    if (patchUserId) {
      generateAlerts(companyId, patchUserId).catch(err => console.error('[Financial] Erro ao gerar alertas após edição:', err));
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET /api/financial/cost-breakdown
// REGIME DE CAIXA: apenas COMPLETED, agrupado por paymentDate
// ============================================
router.get("/cost-breakdown", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const months = parseInt(req.query.months as string) || 6;
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    const expenses = await prisma.transaction.findMany({
      where: {
        companyId,
        tipo_transacao: "EXPENSE",
        status: "COMPLETED",
      },
      include: { detail: true },
    });

    // Agrupar por mês (data efetiva de pagamento) e tipo de custo
    const monthlyBreakdown: Record<string, {
      fixo: number;
      variavel: number;
      pendente: number;
    }> = {};

    expenses.forEach((e) => {
      const effectiveDate = e.detail?.paymentDate || e.date;
      if (effectiveDate < startDate) return; // Fora do período

      const monthKey = formatMonthKey(effectiveDate);
      if (!monthlyBreakdown[monthKey]) {
        monthlyBreakdown[monthKey] = { fixo: 0, variavel: 0, pendente: 0 };
      }

      const amount = Number(e.amount);
      if (e.tipo_custo === "FIXO") {
        monthlyBreakdown[monthKey].fixo += amount;
      } else if (e.tipo_custo === "VARIAVEL") {
        monthlyBreakdown[monthKey].variavel += amount;
      } else {
        monthlyBreakdown[monthKey].pendente += amount;
      }
    });

    const result = Object.entries(monthlyBreakdown)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({
        month,
        fixo: data.fixo,
        variavel: data.variavel,
        pendente: data.pendente,
        total: data.fixo + data.variavel + data.pendente,
      }));

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET /api/financial/pending-details
// Retorna transações PENDING e OVERDUE com detalhes para contexto da IA
// Permite que a Reunião Executiva responda sobre transações futuras
// ============================================
router.get("/pending-details", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;

    const pendingTransactions = await prisma.transaction.findMany({
      where: {
        companyId,
        status: { in: ["PENDING", "OVERDUE"] },
      },
      include: {
        category: { select: { name: true, code: true } },
        counterparty: { select: { name: true, type: true } },
        detail: { select: { dueDate: true, documentNumber: true } },
      },
      orderBy: { date: "asc" },
    });

    // Separar por tipo e formatar
    const receivables = pendingTransactions
      .filter((t) => t.tipo_transacao === "INCOME")
      .map((t) => ({
        id: t.id,
        description: t.description,
        amount: Number(t.amount),
        date: t.date,
        dueDate: t.detail?.dueDate || t.date,
        status: t.status,
        counterparty: t.counterparty?.name || "Não identificado",
        category: t.category?.name || "Sem categoria",
        documentNumber: t.detail?.documentNumber || null,
      }));

    const payables = pendingTransactions
      .filter((t) => t.tipo_transacao === "EXPENSE")
      .map((t) => ({
        id: t.id,
        description: t.description,
        amount: Number(t.amount),
        date: t.date,
        dueDate: t.detail?.dueDate || t.date,
        status: t.status,
        counterparty: t.counterparty?.name || "Não identificado",
        category: t.category?.name || "Sem categoria",
        documentNumber: t.detail?.documentNumber || null,
      }));

    // Agrupar por mês de vencimento
    const byMonth: Record<string, { receivables: number; payables: number; net: number; count: number }> = {};

    receivables.forEach((t) => {
      const monthKey = formatMonthKey(new Date(t.dueDate));
      if (!byMonth[monthKey]) byMonth[monthKey] = { receivables: 0, payables: 0, net: 0, count: 0 };
      byMonth[monthKey].receivables += t.amount;
      byMonth[monthKey].net += t.amount;
      byMonth[monthKey].count++;
    });

    payables.forEach((t) => {
      const monthKey = formatMonthKey(new Date(t.dueDate));
      if (!byMonth[monthKey]) byMonth[monthKey] = { receivables: 0, payables: 0, net: 0, count: 0 };
      byMonth[monthKey].payables += t.amount;
      byMonth[monthKey].net -= t.amount;
      byMonth[monthKey].count++;
    });

    const monthlyForecast = Object.entries(byMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({ month, ...data }));

    // Totais
    const totalReceivables = receivables.reduce((s, t) => s + t.amount, 0);
    const totalPayables = payables.reduce((s, t) => s + t.amount, 0);
    const overdueReceivables = receivables.filter((t) => t.status === "OVERDUE");
    const overduePayables = payables.filter((t) => t.status === "OVERDUE");

    res.json({
      success: true,
      data: {
        receivables,
        payables,
        monthlyForecast,
        totals: {
          totalReceivables,
          totalPayables,
          netPending: totalReceivables - totalPayables,
          overdueReceivablesCount: overdueReceivables.length,
          overdueReceivablesAmount: overdueReceivables.reduce((s, t) => s + t.amount, 0),
          overduePayablesCount: overduePayables.length,
          overduePayablesAmount: overduePayables.reduce((s, t) => s + t.amount, 0),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// HELPER: Classificar transação manual por IA (background)
// Replica a lógica do upload.controller.ts para uma única transação
// ============================================
async function classifyManualTransaction(
  transactionId: string,
  companyId: string,
  userId: string,
  description: string,
  amount: number,
  tipo_transacao: string
) {
  try {
    // Buscar categorias globais para match de ID
    const globalCategories = await prisma.category.findMany({
      select: { id: true, code: true, name: true, type: true },
    });

    // Buscar classificações existentes da empresa para contexto
    const existingClassified = await prisma.transaction.findMany({
      where: { companyId, categoryId: { not: null } },
      select: { description: true, category: { select: { code: true } } },
      distinct: ["description"],
      take: 100,
    });
    const accumulatedClassifications = existingClassified
      .filter((t) => t.category?.code)
      .map((t) => ({ description: t.description, categoryCode: t.category!.code }));

    // Chamar IA para classificar
    const batch = [{ id: transactionId, description, amount, type: tipo_transacao }];
    const classifications = await aiService.classifyTransactions(
      userId,
      companyId,
      batch,
      accumulatedClassifications
    );

    if (classifications && classifications.length > 0) {
      const classification = classifications[0];
      const catPrefix = parseInt(classification.categoryCode.split(".")[0]);
      const isRevenueCategory = catPrefix <= 2;
      const isExpenseTransaction = tipo_transacao === "EXPENSE";
      const isIncomeTransaction = tipo_transacao === "INCOME";

      let finalCategoryCode = classification.categoryCode;
      if (isExpenseTransaction && isRevenueCategory) {
        console.warn(`[Manual] IA classificou despesa "${description}" como receita (${classification.categoryCode}). Aplicando fallback 5.0.`);
        finalCategoryCode = "5.0";
      } else if (isIncomeTransaction && !isRevenueCategory) {
        console.warn(`[Manual] IA classificou receita "${description}" como despesa (${classification.categoryCode}). Aplicando fallback 2.5.`);
        finalCategoryCode = "2.5";
      }

      const finalCategory = globalCategories.find((c) => c.code === finalCategoryCode);
      if (finalCategory) {
        await prisma.transaction.update({
          where: { id: transactionId },
          data: {
            categoryId: finalCategory.id,
            aiClassified: true,
            confidence: classification.confidence,
          },
        });
        console.log(`[Manual] Transação "${description}" classificada como ${finalCategory.name} (${finalCategoryCode}) com ${Math.round(classification.confidence * 100)}% de confiança.`);
      }
    }

    // Classificar tipo de custo para despesas
    if (tipo_transacao === "EXPENSE") {
      const txWithCategory = await prisma.transaction.findUnique({
        where: { id: transactionId },
        include: { category: true },
      });

      if (txWithCategory) {
        const companyForCost = await prisma.company.findUnique({
          where: { id: companyId },
          select: { activity: true },
        });

        try {
          const costBatch = [{
            id: transactionId,
            description,
            amount,
            categoryName: txWithCategory.category?.name,
          }];
          const costClassifications = await aiService.classifyCostType(
            userId,
            costBatch,
            companyForCost?.activity
          );
          if (costClassifications && costClassifications.length > 0) {
            await prisma.transaction.update({
              where: { id: transactionId },
              data: {
                tipo_custo: costClassifications[0].costType,
                costConfidence: costClassifications[0].confidence,
              },
            });
          }
        } catch (costErr) {
          console.error('[Manual] Erro na classificação de tipo de custo:', costErr);
        }
      }
    }
  } catch (err) {
    console.error('[Manual] Erro na classificação IA:', err);
  }
}

export default router;
