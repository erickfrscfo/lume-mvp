import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../../shared/database.js";
import { authMiddleware } from "../auth/auth.middleware.js";

const router = Router();
router.use(authMiddleware);

// ============================================
// GET /api/counterparties — Listar contrapartes
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
    const where: any = { companyId };

    if (req.query.type) {
      where.type = req.query.type;
    }
    if (req.query.isActive !== undefined) {
      where.isActive = req.query.isActive === "true";
    }
    if (req.query.search) {
      where.OR = [
        { name: { contains: req.query.search as string, mode: "insensitive" } },
        { document: { contains: req.query.search as string, mode: "insensitive" } },
      ];
    }

    const counterparties = await prisma.counterparty.findMany({
      where,
      orderBy: { name: "asc" },
    });

    // Enriquecer com dados de transações
    const enriched = await Promise.all(
      counterparties.map(async (cp) => {
        const txStats = await prisma.transaction.aggregate({
          where: { companyId, counterpartyId: cp.id },
          _count: true,
          _sum: { amount: true },
        });

        const lastTx = await prisma.transaction.findFirst({
          where: { companyId, counterpartyId: cp.id },
          orderBy: { date: "desc" },
          select: { date: true },
        });

        return {
          ...cp,
          totalTransactions: txStats._count || 0,
          totalAmount: Number(txStats._sum?.amount || 0),
          avgPaymentDays: 0, // Calculado quando houver dados de pagamento
          lastTransactionDate: lastTx?.date?.toISOString() || null,
        };
      })
    );

    return res.json({ success: true, data: enriched });
  } catch (error) {
    next(error);
  }
});

// ============================================
// POST /api/counterparties — Criar contraparte
// ============================================
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user?.companyId) {
      return res.status(400).json({ success: false, error: "Empresa não encontrada" });
    }

    const { name, document, type, email, phone, address, notes } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, error: "Nome é obrigatório" });
    }

    const counterparty = await prisma.counterparty.create({
      data: {
        companyId: user.companyId,
        name,
        document: document || null,
        type: type || "SUPPLIER",
        email: email || null,
        phone: phone || null,
        address: address || null,
        notes: notes || null,
      },
    });

    return res.status(201).json({ success: true, data: counterparty });
  } catch (error) {
    next(error);
  }
});

// ============================================
// PUT /api/counterparties/:id — Atualizar contraparte
// ============================================
router.put("/:id", async (req: Request, res: Response, next: NextFunction) => {
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

    // Verificar se pertence à empresa
    const existing = await prisma.counterparty.findFirst({
      where: { id, companyId: user.companyId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "Contraparte não encontrada" });
    }

    const { name, document, type, email, phone, address, notes, isActive } = req.body;

    const updated = await prisma.counterparty.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(document !== undefined && { document }),
        ...(type !== undefined && { type }),
        ...(email !== undefined && { email }),
        ...(phone !== undefined && { phone }),
        ...(address !== undefined && { address }),
        ...(notes !== undefined && { notes }),
        ...(isActive !== undefined && { isActive }),
      },
    });

    return res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// ============================================
// DELETE /api/counterparties/:id — Desativar contraparte (soft delete)
// ============================================
router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
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

    const existing = await prisma.counterparty.findFirst({
      where: { id, companyId: user.companyId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "Contraparte não encontrada" });
    }

    // Soft delete: desativar em vez de remover
    await prisma.counterparty.update({
      where: { id },
      data: { isActive: false },
    });

    return res.json({ success: true, message: "Contraparte desativada" });
  } catch (error) {
    next(error);
  }
});

export default router;
