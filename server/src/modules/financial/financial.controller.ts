import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../auth/auth.middleware.js";
import { prisma } from "../../shared/database.js";
import { z } from "zod";

const router = Router();

// GET /api/financial/dashboard
router.get("/dashboard", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1);

    // Transações dos últimos 6 meses
    const transactions = await prisma.transaction.findMany({
      where: { companyId, date: { gte: sixMonthsAgo } },
    });

    // Totais gerais
    const totalIncome = transactions.filter((t) => t.type === "INCOME").reduce((s, t) => s + Number(t.amount), 0);
    const totalExpense = transactions.filter((t) => t.type === "EXPENSE").reduce((s, t) => s + Number(t.amount), 0);
    const cashBalance = totalIncome - totalExpense;

    // ============================================
    // BURN RATE CORRIGIDO
    // Calcula a média mensal de (Despesas - Receitas) usando TODOS os meses com dados,
    // não apenas o mês atual. Isso garante que funciona mesmo quando o mês atual
    // ainda não tem transações.
    // ============================================

    // Agrupar transações por mês
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

    const monthKeys = Object.keys(monthlyData).sort();
    const numMonths = monthKeys.length;

    // Net Burn Rate = média mensal de (despesas - receitas)
    // Se positivo → empresa queima caixa
    // Se zero ou negativo → empresa gera caixa
    let avgNetBurn = 0;
    if (numMonths > 0) {
      const totalNetBurn = monthKeys.reduce((sum, mk) => {
        return sum + (monthlyData[mk].expense - monthlyData[mk].income);
      }, 0);
      avgNetBurn = totalNetBurn / numMonths;
    }

    const burnRate = avgNetBurn > 0 ? avgNetBurn : 0;

    // ============================================
    // RUNWAY CORRIGIDO
    // Runway = Saldo Total em Caixa / Net Burn Rate Mensal
    // Se saldo <= 0 → runway = 0 (sem caixa)
    // Se burn rate <= 0 → runway = 99 (empresa lucrativa, "infinito")
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

    // Variação do saldo: comparar saldo total com saldo sem o último mês
    const lastMonthKey = monthKeys.length > 0 ? monthKeys[monthKeys.length - 1] : null;
    let cashBalanceChange = 0;
    if (lastMonthKey && monthlyData[lastMonthKey]) {
      const lastMonthNet = monthlyData[lastMonthKey].income - monthlyData[lastMonthKey].expense;
      const previousBalance = cashBalance - lastMonthNet;
      if (previousBalance !== 0) {
        cashBalanceChange = ((cashBalance - previousBalance) / Math.abs(previousBalance)) * 100;
      }
    }

    // Crescimento de receita (último mês com dados vs penúltimo)
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

    res.json({
      success: true,
      data: {
        cashBalance: { value: cashBalance, change: cashBalanceChange },
        burnRate: { value: burnRate, change: 0 },
        runway: { value: runway, change: 0 },
        growth: { value: growth, change: 0 },
        transactionCount: transactions.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/financial/cashflow
router.get("/cashflow", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const months = parseInt(req.query.months as string) || 12;
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    const transactions = await prisma.transaction.findMany({
      where: { companyId, date: { gte: startDate } },
      orderBy: { date: "asc" },
    });

    // Agrupar por mês
    const monthlyMap: Record<string, { income: number; expense: number }> = {};
    transactions.forEach((t) => {
      const monthKey = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyMap[monthKey]) monthlyMap[monthKey] = { income: 0, expense: 0 };
      if (t.type === "INCOME") {
        monthlyMap[monthKey].income += Number(t.amount);
      } else {
        monthlyMap[monthKey].expense += Number(t.amount);
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

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// GET /api/financial/dre
router.get("/dre", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const months = parseInt(req.query.months as string) || 7;
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    const transactions = await prisma.transaction.findMany({
      where: { companyId, date: { gte: startDate } },
      include: { category: true },
      orderBy: { date: "asc" },
    });

    // Agrupar por mês e categoria
    const dreData: Record<string, Record<string, number>> = {};
    transactions.forEach((t) => {
      const monthKey = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`;
      const catCode = t.category?.code || "0.0";
      if (!dreData[monthKey]) dreData[monthKey] = {};
      dreData[monthKey][catCode] = (dreData[monthKey][catCode] || 0) + Number(t.amount);
    });

    res.json({ success: true, data: dreData });
  } catch (error) {
    next(error);
  }
});

// GET /api/financial/transactions
router.get("/transactions", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const type = req.query.type as string;
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;

    const where: any = { companyId };
    if (type === "INCOME" || type === "EXPENSE") where.type = type;

    // Filtro de data (usar horário local, não UTC, para evitar problemas de fuso)
    if (startDate || endDate) {
      where.date = {};
      if (startDate) {
        // Início do dia no fuso GMT-3 = 03:00 UTC
        where.date.gte = new Date(startDate + "T03:00:00.000Z");
      }
      if (endDate) {
        // Fim do dia no fuso GMT-3 = próximo dia 02:59:59 UTC
        where.date.lte = new Date(endDate + "T02:59:59.999Z");
        // Adicionar 1 dia para cobrir o dia inteiro
        const endDateObj = new Date(endDate + "T03:00:00.000Z");
        endDateObj.setDate(endDateObj.getDate() + 1);
        endDateObj.setMilliseconds(endDateObj.getMilliseconds() - 1);
        where.date.lte = endDateObj;
      }
    }

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: { category: true },
        orderBy: { date: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.transaction.count({ where }),
    ]);

    res.json({
      success: true,
      data: transactions.map((t) => ({
        id: t.id,
        date: t.date,
        description: t.description,
        amount: Number(t.amount),
        type: t.type,
        category: t.category ? { code: t.category.code, name: t.category.name } : null,
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
router.post("/transactions", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { date, description, amount, type, notes } = req.body;

    if (!date || !description || !amount || !type) {
      return res.status(400).json({ success: false, error: "Campos obrigatórios: date, description, amount, type" });
    }

    const transaction = await prisma.transaction.create({
      data: {
        companyId,
        date: new Date(date),
        description,
        amount: Math.abs(parseFloat(amount)),
        type: type === "INCOME" || type === "ENTRADA" ? "INCOME" : "EXPENSE",
        notes: notes || "",
      },
    });

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

export default router;
