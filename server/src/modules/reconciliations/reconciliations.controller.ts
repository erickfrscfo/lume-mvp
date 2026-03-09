import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../auth/auth.middleware.js";
import { prisma } from "../../shared/database.js";
import { z } from "zod";

const router = Router();

// =============================================
// GET /api/reconciliations/dashboard — Dashboard de conciliação
// =============================================
router.get("/dashboard", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
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
        detail: { select: { reconciliationStatus: true, dueDate: true, paymentDate: true } },
      },
    });

    const total = transactions.length;
    const reconciled = transactions.filter(
      (t) => t.detail?.reconciliationStatus === "RECONCILED"
    ).length;
    const pending = transactions.filter(
      (t) => !t.detail || t.detail.reconciliationStatus === "PENDING"
    ).length;
    const divergent = transactions.filter(
      (t) => t.detail?.reconciliationStatus === "DIVERGENT"
    ).length;
    const partial = transactions.filter(
      (t) => t.detail?.reconciliationStatus === "PARTIAL"
    ).length;

    // Transações vencidas (dueDate < hoje e não conciliadas)
    const now = new Date();
    const overdue = transactions.filter(
      (t) =>
        t.detail?.dueDate &&
        t.detail.dueDate < now &&
        t.detail.reconciliationStatus !== "RECONCILED"
    ).length;

    // Valor total pendente
    const pendingAmount = transactions
      .filter((t) => !t.detail || t.detail.reconciliationStatus === "PENDING")
      .reduce((sum, t) => sum + Number(t.amount), 0);

    // Valor total conciliado
    const reconciledAmount = transactions
      .filter((t) => t.detail?.reconciliationStatus === "RECONCILED")
      .reduce((sum, t) => sum + Number(t.amount), 0);

    // Últimas conciliações
    const recentReconciliations = await prisma.reconciliation.findMany({
      where: { companyId },
      include: {
        transactionDetail: {
          include: {
            transaction: { select: { description: true, amount: true, date: true } },
            counterparty: { select: { name: true } },
          },
        },
        document: { select: { number: true, type: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    res.json({
      success: true,
      data: {
        summary: {
          total,
          reconciled,
          pending,
          divergent,
          partial,
          overdue,
          percentReconciled: total > 0 ? Math.round((reconciled / total) * 100) : 0,
          pendingAmount,
          reconciledAmount,
        },
        recentReconciliations,
      },
    });
  } catch (error) {
    next(error);
  }
});

// =============================================
// POST /api/reconciliations — Conciliar transação manualmente
// =============================================
const reconcileSchema = z.object({
  transactionId: z.string(),
  documentId: z.string().optional(),
  method: z.enum(["MANUAL", "AUTO_EXACT", "AUTO_FUZZY", "AI_SUGGESTED"]).default("MANUAL"),
  confidence: z.number().min(0).max(1).optional(),
  notes: z.string().optional(),
  proofDescription: z.string().optional(),
  proofDocumentId: z.string().optional(),
  bankTransactionRef: z.string().optional(),
  bankTransactionDate: z.string().optional(),
  bankTransactionAmount: z.number().optional(),
});

router.post("/", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const userId = (req as any).userId;
    const data = reconcileSchema.parse(req.body);

    // Verificar se a transação pertence à empresa
    const transaction = await prisma.transaction.findFirst({
      where: { id: data.transactionId, companyId },
      include: { detail: true },
    });

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transação não encontrada" });
    }

    // Garantir que existe TransactionDetail
    let detail = transaction.detail;
    if (!detail) {
      detail = await prisma.transactionDetail.create({
        data: {
          transactionId: data.transactionId,
          reconciliationStatus: "RECONCILED",
          reconciledBy: userId,
          reconciledAt: new Date(),
        },
      });
    } else {
      detail = await prisma.transactionDetail.update({
        where: { transactionId: data.transactionId },
        data: {
          reconciliationStatus: "RECONCILED",
          reconciledBy: userId,
          reconciledAt: new Date(),
        },
      });
    }

    // Criar registro de conciliação
    const reconciliation = await prisma.reconciliation.create({
      data: {
        companyId,
        transactionDetailId: detail.id,
        documentId: data.documentId || null,
        method: data.method,
        confidence: data.confidence,
        notes: data.notes,
        proofDescription: data.proofDescription,
        proofDocumentId: data.proofDocumentId,
        bankTransactionRef: data.bankTransactionRef,
        bankTransactionDate: data.bankTransactionDate ? new Date(data.bankTransactionDate) : null,
        bankTransactionAmount: data.bankTransactionAmount,
        reconciledBy: userId,
        status: "CONFIRMED",
      },
    });

    // Atualizar status da transação
    await prisma.transaction.update({
      where: { id: data.transactionId },
      data: { status: "COMPLETED" },
    });

    res.status(201).json({ success: true, data: reconciliation });
  } catch (error) {
    next(error);
  }
});

// =============================================
// POST /api/reconciliations/batch — Conciliar em lote
// =============================================
const batchSchema = z.object({
  transactionIds: z.array(z.string()).min(1).max(100),
  method: z.enum(["MANUAL", "AUTO_EXACT", "AUTO_FUZZY", "AI_SUGGESTED"]).default("MANUAL"),
  notes: z.string().optional(),
});

router.post("/batch", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const userId = (req as any).userId;
    const data = batchSchema.parse(req.body);

    const results = { success: 0, failed: 0, errors: [] as string[] };

    for (const transactionId of data.transactionIds) {
      try {
        const transaction = await prisma.transaction.findFirst({
          where: { id: transactionId, companyId },
          include: { detail: true },
        });

        if (!transaction) {
          results.failed++;
          results.errors.push(`Transação ${transactionId} não encontrada`);
          continue;
        }

        // Garantir TransactionDetail
        let detail = transaction.detail;
        if (!detail) {
          detail = await prisma.transactionDetail.create({
            data: {
              transactionId,
              reconciliationStatus: "RECONCILED",
              reconciledBy: userId,
              reconciledAt: new Date(),
            },
          });
        } else {
          detail = await prisma.transactionDetail.update({
            where: { transactionId },
            data: {
              reconciliationStatus: "RECONCILED",
              reconciledBy: userId,
              reconciledAt: new Date(),
            },
          });
        }

        await prisma.reconciliation.create({
          data: {
            companyId,
            transactionDetailId: detail.id,
            method: data.method,
            notes: data.notes,
            reconciledBy: userId,
            status: "CONFIRMED",
          },
        });

        await prisma.transaction.update({
          where: { id: transactionId },
          data: { status: "COMPLETED" },
        });

        results.success++;
      } catch (e: any) {
        results.failed++;
        results.errors.push(`${transactionId}: ${e.message}`);
      }
    }

    res.json({ success: true, data: results });
  } catch (error) {
    next(error);
  }
});

// =============================================
// DELETE /api/reconciliations/:id — Desfazer conciliação
// =============================================
router.delete("/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;

    const reconciliation = await prisma.reconciliation.findFirst({
      where: { id, companyId },
      include: { transactionDetail: true },
    });

    if (!reconciliation) {
      return res.status(404).json({ success: false, error: "Conciliação não encontrada" });
    }

    // Reverter status do TransactionDetail
    await prisma.transactionDetail.update({
      where: { id: reconciliation.transactionDetailId },
      data: {
        reconciliationStatus: "PENDING",
        reconciledBy: null,
        reconciledAt: null,
      },
    });

    // Reverter status da transação
    if (reconciliation.transactionDetail) {
      await prisma.transaction.update({
        where: { id: reconciliation.transactionDetail.transactionId },
        data: { status: "PENDING" },
      });
    }

    // Remover conciliação
    await prisma.reconciliation.delete({ where: { id } });

    res.json({ success: true, message: "Conciliação desfeita" });
  } catch (error) {
    next(error);
  }
});

// =============================================
// GET /api/reconciliations — Listar conciliações
// =============================================
router.get("/", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { page = "1", limit = "20", method, status } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { companyId };
    if (method) where.method = method;
    if (status) where.status = status;

    const [reconciliations, total] = await Promise.all([
      prisma.reconciliation.findMany({
        where,
        include: {
          transactionDetail: {
            include: {
              transaction: { select: { id: true, description: true, amount: true, date: true, tipo_transacao: true } },
              counterparty: { select: { id: true, name: true } },
            },
          },
          document: { select: { id: true, number: true, type: true, amount: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limitNum,
      }),
      prisma.reconciliation.count({ where }),
    ]);

    res.json({
      success: true,
      data: reconciliations,
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

export default router;
