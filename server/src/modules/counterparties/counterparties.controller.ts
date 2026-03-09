import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../auth/auth.middleware.js";
import { prisma } from "../../shared/database.js";
import { z } from "zod";

const router = Router();

// =============================================
// GET /api/counterparties — Listar contrapartes
// =============================================
router.get("/", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const {
      page = "1",
      limit = "20",
      type,
      search,
      isActive,
      sortBy = "name",
      sortOrder = "asc",
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { companyId };

    if (type && ["SUPPLIER", "CLIENT", "BOTH"].includes(type)) {
      where.type = type;
    }

    if (isActive !== undefined) {
      where.isActive = isActive === "true";
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { document: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    const orderBy: any = {};
    const validFields = ["name", "createdAt", "totalTransactions", "reliabilityScore"];
    const field = validFields.includes(sortBy) ? sortBy : "name";
    orderBy[field] = sortOrder === "asc" ? "asc" : "desc";

    const [counterparties, total] = await Promise.all([
      prisma.counterparty.findMany({
        where,
        orderBy,
        skip,
        take: limitNum,
      }),
      prisma.counterparty.count({ where }),
    ]);

    res.json({
      success: true,
      data: counterparties,
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
// GET /api/counterparties/:id — Detalhes com métricas
// =============================================
router.get("/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;

    const counterparty = await prisma.counterparty.findFirst({
      where: { id, companyId },
      include: {
        transactionDetails: {
          include: {
            transaction: {
              select: {
                id: true,
                date: true,
                description: true,
                amount: true,
                tipo_transacao: true,
                status: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        },
        documents: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
        _count: {
          select: {
            transactionDetails: true,
            documents: true,
          },
        },
      },
    });

    if (!counterparty) {
      return res.status(404).json({ success: false, error: "Contraparte não encontrada" });
    }

    res.json({ success: true, data: counterparty });
  } catch (error) {
    next(error);
  }
});

// =============================================
// GET /api/counterparties/:id/history — Histórico de transações
// =============================================
router.get("/:id/history", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;
    const { page = "1", limit = "20" } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    // Verificar se contraparte pertence à empresa
    const counterparty = await prisma.counterparty.findFirst({
      where: { id, companyId },
    });

    if (!counterparty) {
      return res.status(404).json({ success: false, error: "Contraparte não encontrada" });
    }

    const [details, total] = await Promise.all([
      prisma.transactionDetail.findMany({
        where: { counterpartyId: id },
        include: {
          transaction: {
            include: {
              category: { select: { id: true, name: true, code: true } },
            },
          },
          reconciliation: true,
        },
        orderBy: { transaction: { date: "desc" } },
        skip,
        take: limitNum,
      }),
      prisma.transactionDetail.count({ where: { counterpartyId: id } }),
    ]);

    res.json({
      success: true,
      data: details,
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
// POST /api/counterparties — Criar contraparte
// =============================================
const createSchema = z.object({
  name: z.string().min(2),
  document: z.string().optional(),
  type: z.enum(["SUPPLIER", "CLIENT", "BOTH"]).default("SUPPLIER"),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  notes: z.string().optional(),
});

router.post("/", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const data = createSchema.parse(req.body);

    // Verificar duplicata por documento
    if (data.document) {
      const existing = await prisma.counterparty.findFirst({
        where: { companyId, document: data.document },
      });
      if (existing) {
        return res.status(409).json({
          success: false,
          error: `Já existe uma contraparte com o documento ${data.document}`,
          data: existing,
        });
      }
    }

    const counterparty = await prisma.counterparty.create({
      data: { companyId, ...data, email: data.email || null },
    });

    res.status(201).json({ success: true, data: counterparty });
  } catch (error) {
    next(error);
  }
});

// =============================================
// PATCH /api/counterparties/:id — Atualizar contraparte
// =============================================
const updateSchema = z.object({
  name: z.string().min(2).optional(),
  document: z.string().optional(),
  type: z.enum(["SUPPLIER", "CLIENT", "BOTH"]).optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  notes: z.string().optional(),
  isActive: z.boolean().optional(),
});

router.patch("/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;
    const data = updateSchema.parse(req.body);

    const existing = await prisma.counterparty.findFirst({
      where: { id, companyId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "Contraparte não encontrada" });
    }

    const updated = await prisma.counterparty.update({
      where: { id },
      data: { ...data, email: data.email || null },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// =============================================
// DELETE /api/counterparties/:id — Desativar contraparte
// =============================================
router.delete("/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;

    const existing = await prisma.counterparty.findFirst({
      where: { id, companyId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "Contraparte não encontrada" });
    }

    // Soft delete: desativar em vez de remover
    await prisma.counterparty.update({
      where: { id },
      data: { isActive: false },
    });

    res.json({ success: true, message: "Contraparte desativada" });
  } catch (error) {
    next(error);
  }
});

export default router;
