import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../../shared/database.js";
import { authMiddleware } from "../auth/auth.middleware.js";

const router = Router();
router.use(authMiddleware);

// ============================================
// GET /api/reconciliations/dashboard — Dashboard de conciliação
// ============================================
router.get("/dashboard", async (req: Request, res: Response, next: NextFunction) => {
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

    // Total de transações
    const totalTransactions = await prisma.transaction.count({
      where: { companyId },
    });

    // Buscar detalhes de conciliação
    const details = await prisma.transactionDetail.findMany({
      where: {
        transaction: { companyId },
      },
      select: {
        reconciliationStatus: true,
        transaction: {
          select: { amount: true, status: true },
        },
      },
    });

    const reconciled = details.filter((d) => d.reconciliationStatus === "RECONCILED").length;
    const divergent = details.filter((d) => d.reconciliationStatus === "DIVERGENT").length;
    const pending = totalTransactions - reconciled - divergent;

    const reconciledPercentage = totalTransactions > 0 ? (reconciled / totalTransactions) * 100 : 0;

    // Valor pendente (transações com status PENDING)
    const pendingTxs = await prisma.transaction.aggregate({
      where: { companyId, status: "PENDING" },
      _sum: { amount: true },
    });

    // Valor vencido (transações com status OVERDUE)
    const overdueTxs = await prisma.transaction.aggregate({
      where: { companyId, status: "OVERDUE" },
      _sum: { amount: true },
    });

    return res.json({
      success: true,
      data: {
        totalTransactions,
        reconciled,
        pending,
        divergent,
        reconciledPercentage: Math.round(reconciledPercentage * 10) / 10,
        totalPendingAmount: Number(pendingTxs._sum?.amount || 0),
        totalOverdueAmount: Number(overdueTxs._sum?.amount || 0),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// POST /api/reconciliations/batch — Conciliação em lote
// ============================================
router.post("/batch", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user?.companyId) {
      return res.status(400).json({ success: false, error: "Empresa não encontrada" });
    }

    const { items, notes } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: "Nenhuma transação selecionada" });
    }

    const companyId = user.companyId;
    let reconciledCount = 0;

    for (const item of items) {
      const { transactionId } = item;

      // Verificar se a transação pertence à empresa
      const tx = await prisma.transaction.findFirst({
        where: { id: transactionId, companyId },
      });

      if (!tx) continue;

      // Atualizar status da transação
      await prisma.transaction.update({
        where: { id: transactionId },
        data: { status: "COMPLETED" },
      });

      // Criar ou atualizar detalhe de conciliação
      await prisma.transactionDetail.upsert({
        where: { transactionId },
        create: {
          transactionId,
          reconciliationStatus: "RECONCILED",
          amountOriginal: tx.amount,
          notes: notes || null,
          ...(tx.tipo_transacao === "EXPENSE"
            ? { paymentDate: new Date(), amountPaid: tx.amount }
            : { receiptDate: new Date(), amountReceived: tx.amount }),
        },
        update: {
          reconciliationStatus: "RECONCILED",
          notes: notes || null,
          ...(tx.tipo_transacao === "EXPENSE"
            ? { paymentDate: new Date(), amountPaid: tx.amount }
            : { receiptDate: new Date(), amountReceived: tx.amount }),
        },
      });

      reconciledCount++;
    }

    return res.json({
      success: true,
      message: `${reconciledCount} transação(ões) conciliada(s)`,
      data: { reconciledCount },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
