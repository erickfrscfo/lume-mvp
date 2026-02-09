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

    // Calcular métricas
    const thisMonthTx = transactions.filter((t) => t.date >= thisMonth);
    const lastMonthTx = transactions.filter((t) => t.date >= lastMonth && t.date < thisMonth);

    const currentIncome = thisMonthTx.filter((t) => t.type === "INCOME").reduce((s, t) => s + Number(t.amount), 0);
    const currentExpense = thisMonthTx.filter((t) => t.type === "EXPENSE").reduce((s, t) => s + Number(t.amount), 0);
    const lastIncome = lastMonthTx.filter((t) => t.type === "INCOME").reduce((s, t) => s + Number(t.amount), 0);
    const lastExpense = lastMonthTx.filter((t) => t.type === "EXPENSE").reduce((s, t) => s + Number(t.amount), 0);

    const totalIncome = transactions.filter((t) => t.type === "INCOME").reduce((s, t) => s + Number(t.amount), 0);
    const totalExpense = transactions.filter((t) => t.type === "EXPENSE").reduce((s, t) => s + Number(t.amount), 0);
    const cashBalance = totalIncome - totalExpense;

    const burnRate = currentExpense - currentIncome;
    const lastBurnRate = lastExpense - lastIncome;
    const burnChange = lastBurnRate > 0 ? ((burnRate - lastBurnRate) / lastBurnRate) * 100 : 0;

    const runway = burnRate > 0 ? cashBalance / burnRate : 99;
    const growth = lastIncome > 0 ? ((currentIncome - lastIncome) / lastIncome) * 100 : 0;

    res.json({
      success: true,
      data: {
        cashBalance: { value: cashBalance, change: ((cashBalance / (totalIncome - totalExpense + burnRate)) - 1) * 100 },
        burnRate: { value: burnRate, change: burnChange },
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
    const monthlyData: Record<string, { income: number; expense: number }> = {};
    transactions.forEach((t) => {
      const key = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyData[key]) monthlyData[key] = { income: 0, expense: 0 };
      if (t.type === "INCOME") monthlyData[key].income += Number(t.amount);
      else monthlyData[key].expense += Number(t.amount);
    });

    const cashflow = Object.entries(monthlyData).map(([month, data]) => ({
      month,
      income: data.income,
      expense: data.expense,
      net: data.income - data.expense,
    }));

    res.json({ success: true, data: cashflow });
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

    const where: any = { companyId };
    if (type === "INCOME" || type === "EXPENSE") where.type = type;

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
      data: transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/financial/transactions
const createTransactionSchema = z.object({
  date: z.string(),
  description: z.string().min(1),
  amount: z.number().positive(),
  type: z.enum(["INCOME", "EXPENSE"]),
  categoryId: z.string().optional(),
  notes: z.string().optional(),
});

router.post("/transactions", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createTransactionSchema.parse(req.body);
    const companyId = (req as any).companyId;

    const transaction = await prisma.transaction.create({
      data: {
        ...data,
        date: new Date(data.date),
        amount: data.amount,
        companyId,
      },
      include: { category: true },
    });

    res.status(201).json({ success: true, data: transaction });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/financial/transactions/:id
router.delete("/transactions/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    await prisma.transaction.deleteMany({
      where: { id: req.params.id, companyId },
    });
    res.json({ success: true, message: "Transação removida" });
  } catch (error) {
    next(error);
  }
});

export default router;
