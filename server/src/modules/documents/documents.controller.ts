import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../auth/auth.middleware.js";
import { prisma } from "../../shared/database.js";
import { z } from "zod";

const router = Router();

// =============================================
// GET /api/documents — Listar documentos
// =============================================
router.get("/", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const {
      page = "1",
      limit = "20",
      type,
      status,
      counterpartyId,
      search,
      startDate,
      endDate,
      sortBy = "issueDate",
      sortOrder = "desc",
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { companyId };

    if (type && ["INVOICE", "RECEIPT", "BANK_STATEMENT", "CONTRACT", "OTHER"].includes(type)) {
      where.type = type;
    }

    if (status && ["ACTIVE", "CANCELLED", "ARCHIVED"].includes(status)) {
      where.status = status;
    }

    if (counterpartyId) {
      where.counterpartyId = counterpartyId;
    }

    if (search) {
      where.OR = [
        { number: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    if (startDate || endDate) {
      where.issueDate = {};
      if (startDate) where.issueDate.gte = new Date(startDate);
      if (endDate) where.issueDate.lte = new Date(endDate);
    }

    const orderBy: any = {};
    const validFields = ["issueDate", "amount", "number", "createdAt"];
    const field = validFields.includes(sortBy) ? sortBy : "issueDate";
    orderBy[field] = sortOrder === "asc" ? "asc" : "desc";

    const [documents, total] = await Promise.all([
      prisma.document.findMany({
        where,
        include: {
          counterparty: { select: { id: true, name: true } },
          reconciliation: { select: { id: true, method: true, createdAt: true } },
        },
        orderBy,
        skip,
        take: limitNum,
      }),
      prisma.document.count({ where }),
    ]);

    res.json({
      success: true,
      data: documents,
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
// GET /api/documents/:id — Detalhes do documento
// =============================================
router.get("/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;

    const document = await prisma.document.findFirst({
      where: { id, companyId },
      include: {
        counterparty: true,
        reconciliation: {
          include: {
            transactionDetail: {
              include: { transaction: true },
            },
          },
        },
      },
    });

    if (!document) {
      return res.status(404).json({ success: false, error: "Documento não encontrado" });
    }

    res.json({ success: true, data: document });
  } catch (error) {
    next(error);
  }
});

// =============================================
// POST /api/documents — Criar documento
// =============================================
const createSchema = z.object({
  counterpartyId: z.string().optional(),
  type: z.enum(["INVOICE", "RECEIPT", "BANK_STATEMENT", "CONTRACT", "OTHER"]),
  number: z.string().min(1),
  issueDate: z.string(),
  amount: z.number(),
  description: z.string().optional(),
  fileUrl: z.string().optional(),
  fileName: z.string().optional(),
  fileType: z.string().optional(),
  fileSize: z.number().optional(),
});

router.post("/", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const data = createSchema.parse(req.body);

    const document = await prisma.document.create({
      data: {
        companyId,
        counterpartyId: data.counterpartyId || null,
        type: data.type,
        number: data.number,
        issueDate: new Date(data.issueDate),
        amount: data.amount,
        description: data.description,
        fileUrl: data.fileUrl,
        fileName: data.fileName,
        fileType: data.fileType,
        fileSize: data.fileSize,
      },
      include: {
        counterparty: { select: { id: true, name: true } },
      },
    });

    res.status(201).json({ success: true, data: document });
  } catch (error) {
    next(error);
  }
});

// =============================================
// PATCH /api/documents/:id — Atualizar documento
// =============================================
const updateSchema = z.object({
  counterpartyId: z.string().nullable().optional(),
  type: z.enum(["INVOICE", "RECEIPT", "BANK_STATEMENT", "CONTRACT", "OTHER"]).optional(),
  number: z.string().optional(),
  issueDate: z.string().optional(),
  amount: z.number().optional(),
  description: z.string().optional(),
  fileUrl: z.string().optional(),
  status: z.enum(["ACTIVE", "CANCELLED", "ARCHIVED"]).optional(),
  extractedData: z.any().optional(),
  extractionConfidence: z.number().optional(),
});

router.patch("/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;
    const data = updateSchema.parse(req.body);

    const existing = await prisma.document.findFirst({
      where: { id, companyId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "Documento não encontrado" });
    }

    const updateData: any = { ...data };
    if (data.issueDate) updateData.issueDate = new Date(data.issueDate);

    const updated = await prisma.document.update({
      where: { id },
      data: updateData,
      include: {
        counterparty: { select: { id: true, name: true } },
      },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// =============================================
// DELETE /api/documents/:id — Arquivar documento
// =============================================
router.delete("/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;

    const existing = await prisma.document.findFirst({
      where: { id, companyId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "Documento não encontrado" });
    }

    await prisma.document.update({
      where: { id },
      data: { status: "ARCHIVED" },
    });

    res.json({ success: true, message: "Documento arquivado" });
  } catch (error) {
    next(error);
  }
});

export default router;
