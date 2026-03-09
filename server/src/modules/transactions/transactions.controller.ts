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
      status,
      source,
      counterpartyId,
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

    if (status && ["PENDING", "COMPLETED", "OVERDUE", "PARTIAL"].includes(status)) {
      where.status = status;
    }

    if (source && ["MANUAL", "UPLOAD", "OCR", "BANK_SYNC"].includes(source)) {
      where.source = source;
    }

    if (counterpartyId) {
      where.counterpartyId = counterpartyId;
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
    const validSortFields = ["date", "amount", "description", "createdAt", "status"];
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
              receiptDate: true,
              documentNumber: true,
              amountOriginal: true,
              amountPaid: true,
              amountReceived: true,
              discount: true,
              interest: true,
              counterparty: { select: { id: true, name: true, type: true } },
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

    // Contadores por status
    const statusCounts = {
      pending: transactions.filter((t) => (t as any).status === "PENDING").length,
      completed: transactions.filter((t) => (t as any).status === "COMPLETED").length,
      overdue: transactions.filter((t) => (t as any).status === "OVERDUE").length,
      partial: transactions.filter((t) => (t as any).status === "PARTIAL").length,
    };

    res.json({
      success: true,
      data: {
        totalIncome,
        totalExpense,
        balance: totalIncome - totalExpense,
        totalTransactions: transactions.length,
        statusCounts,
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
  date: z.string().optional(),
  tipo_transacao: z.enum(["INCOME", "EXPENSE"]).optional(),
  categoryId: z.string().optional(),
  status: z.enum(["PENDING", "COMPLETED", "OVERDUE", "PARTIAL"]).optional(),
  counterpartyId: z.string().nullable().optional(),
  documentId: z.string().nullable().optional(),
  notes: z.string().optional(),
});

router.patch("/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;
    const data = updateTransactionSchema.parse(req.body);

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
  counterpartyId: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  paymentDate: z.string().nullable().optional(),
  receiptDate: z.string().nullable().optional(),
  documentNumber: z.string().optional(),
  bankReference: z.string().optional(),
  amountOriginal: z.number().optional(),
  amountPaid: z.number().nullable().optional(),
  amountReceived: z.number().nullable().optional(),
  discount: z.number().nullable().optional(),
  interest: z.number().nullable().optional(),
  notes: z.string().optional(),
});

router.post("/:id/detail", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;
    const data = detailSchema.parse(req.body);

    const transaction = await prisma.transaction.findFirst({
      where: { id, companyId },
    });

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transação não encontrada" });
    }

    const detailData: any = { ...data };
    if (data.dueDate) detailData.dueDate = new Date(data.dueDate);
    if (data.paymentDate) detailData.paymentDate = new Date(data.paymentDate);
    if (data.receiptDate) detailData.receiptDate = new Date(data.receiptDate);

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

// =============================================
// POST /api/transactions/:id/mark-paid — Marcar como pago
// =============================================
router.post("/:id/mark-paid", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const userId = (req as any).userId;
    const { id } = req.params;
    const { paymentDate, amountPaid, discount, interest, notes } = req.body;

    const transaction = await prisma.transaction.findFirst({
      where: { id, companyId },
      include: { detail: true },
    });

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transação não encontrada" });
    }

    // Atualizar status da transação
    const effectiveAmountPaid = amountPaid ?? Number(transaction.amount);
    const isPartial = effectiveAmountPaid < Number(transaction.amount);

    await prisma.transaction.update({
      where: { id },
      data: { status: isPartial ? "PARTIAL" : "COMPLETED" },
    });

    // Criar/atualizar detalhe
    const detail = await prisma.transactionDetail.upsert({
      where: { transactionId: id },
      update: {
        paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
        amountPaid: effectiveAmountPaid,
        amountOriginal: Number(transaction.amount),
        discount: discount ?? null,
        interest: interest ?? null,
        notes: notes ?? transaction.detail?.notes,
        reconciledBy: userId,
        reconciledAt: new Date(),
      },
      create: {
        transactionId: id,
        paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
        amountPaid: effectiveAmountPaid,
        amountOriginal: Number(transaction.amount),
        discount: discount ?? null,
        interest: interest ?? null,
        notes: notes ?? null,
        reconciledBy: userId,
        reconciledAt: new Date(),
      },
    });

    // Atualizar métricas da contraparte se existir
    if (transaction.detail?.counterpartyId || (transaction as any).counterpartyId) {
      const cpId = transaction.detail?.counterpartyId || (transaction as any).counterpartyId;
      await updateCounterpartyMetrics(cpId);
    }

    res.json({
      success: true,
      data: { transaction: { ...transaction, status: isPartial ? "PARTIAL" : "COMPLETED" }, detail },
      message: isPartial ? "Pagamento parcial registrado" : "Transação marcada como paga",
    });
  } catch (error) {
    next(error);
  }
});

// =============================================
// POST /api/transactions/:id/mark-received — Marcar como recebido
// =============================================
router.post("/:id/mark-received", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const userId = (req as any).userId;
    const { id } = req.params;
    const { receiptDate, amountReceived, discount, notes } = req.body;

    const transaction = await prisma.transaction.findFirst({
      where: { id, companyId },
      include: { detail: true },
    });

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transação não encontrada" });
    }

    if (transaction.tipo_transacao !== "INCOME") {
      return res.status(400).json({ success: false, error: "Apenas receitas podem ser marcadas como recebidas" });
    }

    const effectiveAmountReceived = amountReceived ?? Number(transaction.amount);
    const isPartial = effectiveAmountReceived < Number(transaction.amount);

    await prisma.transaction.update({
      where: { id },
      data: { status: isPartial ? "PARTIAL" : "COMPLETED" },
    });

    const detail = await prisma.transactionDetail.upsert({
      where: { transactionId: id },
      update: {
        receiptDate: receiptDate ? new Date(receiptDate) : new Date(),
        amountReceived: effectiveAmountReceived,
        amountOriginal: Number(transaction.amount),
        discount: discount ?? null,
        notes: notes ?? transaction.detail?.notes,
        reconciledBy: userId,
        reconciledAt: new Date(),
      },
      create: {
        transactionId: id,
        receiptDate: receiptDate ? new Date(receiptDate) : new Date(),
        amountReceived: effectiveAmountReceived,
        amountOriginal: Number(transaction.amount),
        discount: discount ?? null,
        notes: notes ?? null,
        reconciledBy: userId,
        reconciledAt: new Date(),
      },
    });

    if (transaction.detail?.counterpartyId || (transaction as any).counterpartyId) {
      const cpId = transaction.detail?.counterpartyId || (transaction as any).counterpartyId;
      await updateCounterpartyMetrics(cpId);
    }

    res.json({
      success: true,
      data: { transaction: { ...transaction, status: isPartial ? "PARTIAL" : "COMPLETED" }, detail },
      message: isPartial ? "Recebimento parcial registrado" : "Transação marcada como recebida",
    });
  } catch (error) {
    next(error);
  }
});

// =============================================
// Helper: Atualizar métricas da contraparte
// =============================================
async function updateCounterpartyMetrics(counterpartyId: string) {
  try {
    const details = await prisma.transactionDetail.findMany({
      where: { counterpartyId },
      include: { transaction: true },
    });

    const totalTransactions = details.length;
    let totalDaysToPay = 0;
    let totalDaysToReceive = 0;
    let payCount = 0;
    let receiveCount = 0;
    let latePaymentCount = 0;

    for (const d of details) {
      if (d.dueDate && d.paymentDate) {
        const days = Math.ceil(
          (d.paymentDate.getTime() - d.dueDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        if (d.transaction.tipo_transacao === "EXPENSE") {
          totalDaysToPay += Math.max(0, days);
          payCount++;
          if (days > 0) latePaymentCount++;
        } else {
          totalDaysToReceive += Math.max(0, days);
          receiveCount++;
        }
      }
    }

    const avgDaysToPay = payCount > 0 ? totalDaysToPay / payCount : null;
    const avgDaysToReceive = receiveCount > 0 ? totalDaysToReceive / receiveCount : null;

    // Reliability: 100% se nunca atrasou, diminui proporcionalmente
    const reliabilityScore = totalTransactions > 0
      ? Math.max(0, Math.min(1, 1 - (latePaymentCount / totalTransactions)))
      : null;

    await prisma.counterparty.update({
      where: { id: counterpartyId },
      data: {
        totalTransactions,
        latePaymentCount,
        avgDaysToPay,
        avgDaysToReceive,
        reliabilityScore,
      },
    });
  } catch (error) {
    console.error(`Erro ao atualizar métricas da contraparte ${counterpartyId}:`, error);
  }
}

export default router;
