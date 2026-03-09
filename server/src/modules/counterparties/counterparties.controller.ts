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

    const [counterparties, total] = await Promise.all([
      prisma.counterparty.findMany({
        where,
        include: {
          _count: {
            select: {
              transactionDetails: true,
              documents: true,
            },
          },
        },
        orderBy: { name: "asc" },
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
// GET /api/counterparties/:id — Detalhes de uma contraparte
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
                description: true,
                amount: true,
                date: true,
                tipo_transacao: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        },
        documents: {
          orderBy: { issueDate: "desc" },
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
// POST /api/counterparties — Criar contraparte
// =============================================
const createCounterpartySchema = z.object({
  name: z.string().min(2, "Nome deve ter pelo menos 2 caracteres"),
  document: z.string().optional(),
  type: z.enum(["SUPPLIER", "CLIENT", "BOTH"]).default("SUPPLIER"),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  notes: z.string().optional(),
});

router.post("/", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const data = createCounterpartySchema.parse(req.body);

    // Verificar duplicata por documento na mesma empresa
    if (data.document) {
      const existing = await prisma.counterparty.findFirst({
        where: { companyId, document: data.document },
      });
      if (existing) {
        return res.status(409).json({
          success: false,
          error: "Já existe uma contraparte com este documento",
          data: existing,
        });
      }
    }

    const counterparty = await prisma.counterparty.create({
      data: {
        companyId,
        ...data,
        email: data.email || null,
      },
    });

    res.status(201).json({ success: true, data: counterparty });
  } catch (error) {
    next(error);
  }
});

// =============================================
// PATCH /api/counterparties/:id — Atualizar contraparte
// =============================================
const updateCounterpartySchema = z.object({
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
    const data = updateCounterpartySchema.parse(req.body);

    const existing = await prisma.counterparty.findFirst({
      where: { id, companyId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "Contraparte não encontrada" });
    }

    const updated = await prisma.counterparty.update({
      where: { id },
      data: {
        ...data,
        email: data.email === "" ? null : data.email,
      },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// =============================================
// DELETE /api/counterparties/:id — Remover contraparte
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

    // Soft delete — apenas desativa
    await prisma.counterparty.update({
      where: { id },
      data: { isActive: false },
    });

    res.json({ success: true, message: "Contraparte desativada com sucesso" });
  } catch (error) {
    next(error);
  }
});

export default router;
