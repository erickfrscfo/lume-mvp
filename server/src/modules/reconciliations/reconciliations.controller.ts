import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../auth/auth.middleware.js";
import { prisma } from "../../shared/database.js";
import { z } from "zod";

const router = Router();

// =============================================
// GET /api/reconciliations — Listar conciliações
// =============================================
router.get("/", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const {
      page = "1",
      limit = "20",
      method,
      startDate,
      endDate,
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { companyId };

    if (method && ["MANUAL", "AUTO_EXACT", "AUTO_FUZZY", "AI_SUGGESTED"].includes(method)) {
      where.method = method;
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [reconciliations, total] = await Promise.all([
      prisma.reconciliation.findMany({
        where,
        include: {
          transactionDetail: {
            include: {
              transaction: {
                select: {
                  id: true,
                  description: true,
                  amount: true,
                  date: true,
                  tipo_transacao: true,
                },
              },
              counterparty: { select: { id: true, name: true } },
            },
          },
          document: {
            select: {
              id: true,
              type: true,
              number: true,
              amount: true,
              issueDate: true,
            },
          },
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

// =============================================
// GET /api/reconciliations/dashboard — Dashboard de conciliação
// =============================================
router.get("/dashboard", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;

    // Total de transações da empresa
    const totalTransactions = await prisma.transaction.count({
      where: { companyId },
    });

    // Transações com detalhe e status
    const details = await prisma.transactionDetail.findMany({
      where: { transaction: { companyId } },
      select: { reconciliationStatus: true },
    });

    const reconciled = details.filter((d) => d.reconciliationStatus === "RECONCILED").length;
    const pending = totalTransactions - details.length + details.filter((d) => d.reconciliationStatus === "PENDING").length;
    const divergent = details.filter((d) => d.reconciliationStatus === "DIVERGENT").length;
    const partial = details.filter((d) => d.reconciliationStatus === "PARTIAL").length;

    // Conciliações recentes
    const recentReconciliations = await prisma.reconciliation.findMany({
      where: { companyId },
      include: {
        transactionDetail: {
          include: {
            transaction: {
              select: { description: true, amount: true, date: true },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    // Total conciliado por método
    const byMethod = await prisma.reconciliation.groupBy({
      by: ["method"],
      where: { companyId },
      _count: { id: true },
    });

    res.json({
      success: true,
      data: {
        summary: {
          totalTransactions,
          reconciled,
          pending,
          divergent,
          partial,
          percentReconciled:
            totalTransactions > 0
              ? Math.round((reconciled / totalTransactions) * 100)
              : 0,
        },
        byMethod: byMethod.map((m) => ({
          method: m.method,
          count: m._count.id,
        })),
        recentReconciliations,
      },
    });
  } catch (error) {
    next(error);
  }
});

// =============================================
// POST /api/reconciliations — Criar conciliação manual
// =============================================
const createReconciliationSchema = z.object({
  transactionId: z.string(),
  documentId: z.string().optional(),
  counterpartyId: z.string().optional(),
  notes: z.string().optional(),
});

router.post("/", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const userId = (req as any).userId;
    const data = createReconciliationSchema.parse(req.body);

    // Verificar se a transação pertence à empresa
    const transaction = await prisma.transaction.findFirst({
      where: { id: data.transactionId, companyId },
      include: { detail: true },
    });

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transação não encontrada" });
    }

    // Verificar se já está conciliada
    if (transaction.detail?.reconciliationStatus === "RECONCILED") {
      return res.status(409).json({
        success: false,
        error: "Transação já está conciliada",
      });
    }

    // Verificar documento se fornecido
    if (data.documentId) {
      const document = await prisma.document.findFirst({
        where: { id: data.documentId, companyId },
      });
      if (!document) {
        return res.status(404).json({ success: false, error: "Documento não encontrado" });
      }
    }

    // Usar transação do Prisma para garantir atomicidade
    const result = await prisma.$transaction(async (tx) => {
      // Criar ou atualizar TransactionDetail
      const detail = await tx.transactionDetail.upsert({
        where: { transactionId: data.transactionId },
        update: {
          reconciliationStatus: "RECONCILED",
          counterpartyId: data.counterpartyId || undefined,
          reconciledBy: userId,
          reconciledAt: new Date(),
        },
        create: {
          transactionId: data.transactionId,
          reconciliationStatus: "RECONCILED",
          counterpartyId: data.counterpartyId || null,
          reconciledBy: userId,
          reconciledAt: new Date(),
        },
      });

      // Criar registro de Reconciliation
      const reconciliation = await tx.reconciliation.create({
        data: {
          companyId,
          transactionDetailId: detail.id,
          documentId: data.documentId || null,
          method: "MANUAL",
          notes: data.notes || null,
          reconciledBy: userId,
        },
        include: {
          transactionDetail: {
            include: {
              transaction: {
                select: { id: true, description: true, amount: true, date: true },
              },
            },
          },
          document: true,
        },
      });

      return reconciliation;
    });

    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// =============================================
// POST /api/reconciliations/batch — Conciliação em lote
// =============================================
const batchReconciliationSchema = z.object({
  items: z.array(
    z.object({
      transactionId: z.string(),
      documentId: z.string().optional(),
      counterpartyId: z.string().optional(),
    })
  ).min(1, "Pelo menos um item é necessário"),
  notes: z.string().optional(),
});

router.post("/batch", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const userId = (req as any).userId;
    const data = batchReconciliationSchema.parse(req.body);

    const results: any[] = [];
    const errors: any[] = [];

    for (const item of data.items) {
      try {
        const transaction = await prisma.transaction.findFirst({
          where: { id: item.transactionId, companyId },
          include: { detail: true },
        });

        if (!transaction) {
          errors.push({ transactionId: item.transactionId, error: "Transação não encontrada" });
          continue;
        }

        if (transaction.detail?.reconciliationStatus === "RECONCILED") {
          errors.push({ transactionId: item.transactionId, error: "Já conciliada" });
          continue;
        }

        const result = await prisma.$transaction(async (tx) => {
          const detail = await tx.transactionDetail.upsert({
            where: { transactionId: item.transactionId },
            update: {
              reconciliationStatus: "RECONCILED",
              counterpartyId: item.counterpartyId || undefined,
              reconciledBy: userId,
              reconciledAt: new Date(),
            },
            create: {
              transactionId: item.transactionId,
              reconciliationStatus: "RECONCILED",
              counterpartyId: item.counterpartyId || null,
              reconciledBy: userId,
              reconciledAt: new Date(),
            },
          });

          return tx.reconciliation.create({
            data: {
              companyId,
              transactionDetailId: detail.id,
              documentId: item.documentId || null,
              method: "MANUAL",
              notes: data.notes || null,
              reconciledBy: userId,
            },
          });
        });

        results.push(result);
      } catch (err: any) {
        errors.push({ transactionId: item.transactionId, error: err.message });
      }
    }

    res.status(201).json({
      success: true,
      data: {
        reconciled: results.length,
        failed: errors.length,
        total: data.items.length,
        errors: errors.length > 0 ? errors : undefined,
      },
    });
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
    });

    if (!reconciliation) {
      return res.status(404).json({ success: false, error: "Conciliação não encontrada" });
    }

    // Reverter: deletar reconciliation e voltar status do detail para PENDING
    await prisma.$transaction(async (tx) => {
      await tx.reconciliation.delete({ where: { id } });
      await tx.transactionDetail.update({
        where: { id: reconciliation.transactionDetailId },
        data: {
          reconciliationStatus: "PENDING",
          reconciledBy: null,
          reconciledAt: null,
        },
      });
    });

    res.json({ success: true, message: "Conciliação desfeita com sucesso" });
  } catch (error) {
    next(error);
  }
});

export default router;
