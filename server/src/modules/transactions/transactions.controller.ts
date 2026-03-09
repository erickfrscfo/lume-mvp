import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../auth/auth.middleware.js";
import { prisma } from "../../shared/database.js";
import { z } from "zod";

const router = Router();

// =============================================
// GET /api/transactions — Listar transações com filtros
// =============================================
router.get("/", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const {
      page = "1",
      limit = "20",
      tipo_transacao,
      categoryId,
      startDate,
      endDate,
      search,
      reconciliationStatus,
      sortBy = "date",
      sortOrder = "desc",
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    // Construir filtro dinâmico
    const where: any = { companyId };

    if (tipo_transacao && ["INCOME", "EXPENSE"].includes(tipo_transacao)) {
      where.tipo_transacao = tipo_transacao;
    }

    if (categoryId) {
      where.categoryId = categoryId;
    }

    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = new Date(startDate);
      if (endDate) where.date.lte = new Date(endDate);
    }

    if (search) {
      where.description = { contains: search, mode: "insensitive" };
    }

    // Filtro por status de conciliação (via TransactionDetail)
    if (reconciliationStatus) {
      where.detail = { reconciliationStatus };
    }

    // Ordenação
    const orderBy: any = {};
    const validSortFields = ["date", "amount", "description", "createdAt"];
    const field = validSortFields.includes(sortBy) ? sortBy : "date";
    orderBy[field] = sortOrder === "asc" ? "asc" : "desc";

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: {
          category: { select: { id: true, name: true, code: true } },
          detail: {
            select: {
              id: true,
              reconciliationStatus: true,
              counterpartyId: true,
              dueDate: true,
              paymentDate: true,
              documentNumber: true,
              counterparty: { select: { id: true, name: true } },
            },
          },
        },
        orderBy,
        skip,
        take: limitNum,
      }),
      prisma.transaction.count({ where }),
    ]);

    res.json({
      success: true,
      data: transactions,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
});

// =============================================
// GET /api/transactions/summary — Resumo financeiro
// =============================================
router.get("/summary", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { startDate, endDate } = req.query as Record<string, string>;

    const where: any = { companyId };
    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = new Date(startDate);
      if (endDate) where.date.lte = new Date(endDate);
    }

    const transactions = await prisma.transaction.findMany({
      where,
      include: {
        detail: { select: { reconciliationStatus: true } },
      },
    });

    const totalIncome = transactions
      .filter((t) => t.tipo_transacao === "INCOME")
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const totalExpense = transactions
      .filter((t) => t.tipo_transacao === "EXPENSE")
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const reconciled = transactions.filter(
      (t) => t.detail?.reconciliationStatus === "RECONCILED"
    ).length;
    const pending = transactions.filter(
      (t) => !t.detail || t.detail.reconciliationStatus === "PENDING"
    ).length;
    const divergent = transactions.filter(
      (t) => t.detail?.reconciliationStatus === "DIVERGENT"
    ).length;

    res.json({
      success: true,
      data: {
        totalIncome,
        totalExpense,
        balance: totalIncome - totalExpense,
        totalTransactions: transactions.length,
        reconciliation: {
          reconciled,
          pending,
          divergent,
          percentReconciled:
            transactions.length > 0
              ? Math.round((reconciled / transactions.length) * 100)
              : 0,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// =============================================
// GET /api/transactions/:id — Detalhes de uma transação
// =============================================
router.get("/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;

    const transaction = await prisma.transaction.findFirst({
      where: { id, companyId },
      include: {
        category: true,
        detail: {
          include: {
            counterparty: true,
            reconciliation: true,
          },
        },
      },
    });

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transação não encontrada" });
    }

    res.json({ success: true, data: transaction });
  } catch (error) {
    next(error);
  }
});

// =============================================
// PATCH /api/transactions/:id — Atualizar transação
// =============================================
const updateTransactionSchema = z.object({
  description: z.string().optional(),
  amount: z.number().optional(),
  date: z.string().datetime().optional(),
  tipo_transacao: z.enum(["INCOME", "EXPENSE"]).optional(),
  categoryId: z.string().optional(),
  notes: z.string().optional(),
});

router.patch("/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;
    const data = updateTransactionSchema.parse(req.body);

    // Verificar se pertence à empresa
    const existing = await prisma.transaction.findFirst({
      where: { id, companyId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "Transação não encontrada" });
    }

    const updateData: any = { ...data };
    if (data.date) updateData.date = new Date(data.date);

    const updated = await prisma.transaction.update({
      where: { id },
      data: updateData,
      include: {
        category: true,
        detail: { include: { counterparty: true } },
      },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// =============================================
// POST /api/transactions/:id/detail — Criar/atualizar detalhe
// =============================================
const detailSchema = z.object({
  counterpartyId: z.string().optional(),
  dueDate: z.string().optional(),
  paymentDate: z.string().optional(),
  documentNumber: z.string().optional(),
  bankReference: z.string().optional(),
  notes: z.string().optional(),
});

router.post("/:id/detail", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;
    const data = detailSchema.parse(req.body);

    // Verificar se a transação pertence à empresa
    const transaction = await prisma.transaction.findFirst({
      where: { id, companyId },
    });

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transação não encontrada" });
    }

    const detailData: any = { ...data };
    if (data.dueDate) detailData.dueDate = new Date(data.dueDate);
    if (data.paymentDate) detailData.paymentDate = new Date(data.paymentDate);

    const detail = await prisma.transactionDetail.upsert({
      where: { transactionId: id },
      update: detailData,
      create: {
        transactionId: id,
        ...detailData,
      },
      include: { counterparty: true },
    });

    res.json({ success: true, data: detail });
  } catch (error) {
    next(error);
  }
});

export default router;
