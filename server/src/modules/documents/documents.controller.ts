import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../../shared/database.js";
import { authMiddleware } from "../auth/auth.middleware.js";

const router = Router();
router.use(authMiddleware);

// ============================================
// GET /api/documents — Listar documentos fiscais
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
    if (req.query.status) {
      where.status = req.query.status;
    }
    if (req.query.search) {
      where.OR = [
        { number: { contains: req.query.search as string, mode: "insensitive" } },
        { description: { contains: req.query.search as string, mode: "insensitive" } },
      ];
    }

    const documents = await prisma.document.findMany({
      where,
      include: {
        counterparty: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json({ success: true, data: documents });
  } catch (error) {
    next(error);
  }
});

// ============================================
// POST /api/documents — Criar documento fiscal
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

    const { number, type, description, amount, issueDate, dueDate, counterpartyId, notes } = req.body;

    if (!number || !type) {
      return res.status(400).json({ success: false, error: "Número e tipo são obrigatórios" });
    }

    const document = await prisma.document.create({
      data: {
        companyId: user.companyId,
        number,
        type,
        description: description || null,
        amount: amount || null,
        issueDate: issueDate ? new Date(issueDate) : null,
        dueDate: dueDate ? new Date(dueDate) : null,
        counterpartyId: counterpartyId || null,
        notes: notes || null,
      },
      include: {
        counterparty: { select: { id: true, name: true } },
      },
    });

    return res.status(201).json({ success: true, data: document });
  } catch (error) {
    next(error);
  }
});

// ============================================
// PUT /api/documents/:id — Atualizar documento fiscal
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

    const existing = await prisma.document.findFirst({
      where: { id, companyId: user.companyId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "Documento não encontrado" });
    }

    const { number, type, description, amount, issueDate, dueDate, counterpartyId, notes, status } = req.body;

    const updated = await prisma.document.update({
      where: { id },
      data: {
        ...(number !== undefined && { number }),
        ...(type !== undefined && { type }),
        ...(description !== undefined && { description }),
        ...(amount !== undefined && { amount }),
        ...(issueDate !== undefined && { issueDate: issueDate ? new Date(issueDate) : null }),
        ...(dueDate !== undefined && { dueDate: dueDate ? new Date(dueDate) : null }),
        ...(counterpartyId !== undefined && { counterpartyId: counterpartyId || null }),
        ...(notes !== undefined && { notes }),
        ...(status !== undefined && { status }),
      },
      include: {
        counterparty: { select: { id: true, name: true } },
      },
    });

    return res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// ============================================
// DELETE /api/documents/:id — Remover documento fiscal
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

    const existing = await prisma.document.findFirst({
      where: { id, companyId: user.companyId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "Documento não encontrado" });
    }

    await prisma.document.delete({ where: { id } });

    return res.json({ success: true, message: "Documento removido" });
  } catch (error) {
    next(error);
  }
});

export default router;
