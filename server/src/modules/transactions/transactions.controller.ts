import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../../shared/database.js";
import { authMiddleware } from "../auth/auth.middleware.js";

const router = Router();
router.use(authMiddleware);

// ============================================
// GET /api/transactions — Listar transações com filtros e paginação
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
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    // Filtros
    const where: any = { companyId };

    if (req.query.tipo_transacao) {
      where.tipo_transacao = req.query.tipo_transacao;
    }
    if (req.query.status) {
      where.status = req.query.status;
    }
    if (req.query.counterpartyId) {
      where.counterpartyId = req.query.counterpartyId;
    }
    if (req.query.startDate || req.query.endDate) {
      where.date = {};
      if (req.query.startDate) where.date.gte = new Date(req.query.startDate as string);
      if (req.query.endDate) where.date.lte = new Date(req.query.endDate as string);
    }
    if (req.query.search) {
      where.description = { contains: req.query.search as string, mode: "insensitive" };
    }

    // Filtro de reconciliação (via detail)
    const reconciliationStatus = req.query.reconciliationStatus as string;

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: {
          category: { select: { id: true, name: true, code: true } },
          counterparty: { select: { id: true, name: true } },
          detail: {
            include: {
              counterparty: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { date: "desc" },
        skip,
        take: limit,
      }),
      prisma.transaction.count({ where }),
    ]);

    // Filtrar por reconciliationStatus no lado do servidor se necessário
    let filtered = transactions;
    if (reconciliationStatus) {
      filtered = transactions.filter((tx) => {
        const status = tx.detail?.reconciliationStatus || "PENDING";
        return status === reconciliationStatus;
      });
    }

    return res.json({
      success: true,
      data: filtered,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// PATCH /api/transactions/:id/mark-paid — Marcar como pago (despesa)
// ============================================
router.patch("/:id/mark-paid", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user?.companyId) {
      return res.status(400).json({ success: false, error: "Empresa não encontrada" });
    }

    const { id } = req.params;
    const { paymentDate, amountPaid } = req.body;

    // Verificar se a transação pertence à empresa
    const transaction = await prisma.transaction.findFirst({
      where: { id, companyId: user.companyId },
    });

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transação não encontrada" });
    }

    // Atualizar status da transação
    await prisma.transaction.update({
      where: { id },
      data: { status: "COMPLETED" },
    });

    // Criar ou atualizar detalhe
    await prisma.transactionDetail.upsert({
      where: { transactionId: id },
      create: {
        transactionId: id,
        paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
        amountPaid: amountPaid || transaction.amount,
        amountOriginal: transaction.amount,
        reconciliationStatus: "RECONCILED",
      },
      update: {
        paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
        amountPaid: amountPaid || transaction.amount,
        reconciliationStatus: "RECONCILED",
      },
    });

    return res.json({ success: true, message: "Transação marcada como paga" });
  } catch (error) {
    next(error);
  }
});

// ============================================
// PATCH /api/transactions/:id/mark-received — Marcar como recebido (receita)
// ============================================
router.patch("/:id/mark-received", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user?.companyId) {
      return res.status(400).json({ success: false, error: "Empresa não encontrada" });
    }

    const { id } = req.params;
    const { receiptDate, amountReceived } = req.body;

    const transaction = await prisma.transaction.findFirst({
      where: { id, companyId: user.companyId },
    });

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transação não encontrada" });
    }

    await prisma.transaction.update({
      where: { id },
      data: { status: "COMPLETED" },
    });

    await prisma.transactionDetail.upsert({
      where: { transactionId: id },
      create: {
        transactionId: id,
        receiptDate: receiptDate ? new Date(receiptDate) : new Date(),
        amountReceived: amountReceived || transaction.amount,
        amountOriginal: transaction.amount,
        reconciliationStatus: "RECONCILED",
      },
      update: {
        receiptDate: receiptDate ? new Date(receiptDate) : new Date(),
        amountReceived: amountReceived || transaction.amount,
        reconciliationStatus: "RECONCILED",
      },
    });

    return res.json({ success: true, message: "Transação marcada como recebida" });
  } catch (error) {
    next(error);
  }
});

export default router;
