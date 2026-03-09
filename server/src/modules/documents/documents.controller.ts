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
      startDate,
      endDate,
      search,
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

    if (startDate || endDate) {
      where.issueDate = {};
      if (startDate) where.issueDate.gte = new Date(startDate);
      if (endDate) where.issueDate.lte = new Date(endDate);
    }

    if (search) {
      where.OR = [
        { number: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    const [documents, total] = await Promise.all([
      prisma.document.findMany({
        where,
        include: {
          counterparty: { select: { id: true, name: true, document: true } },
          reconciliation: { select: { id: true, createdAt: true } },
        },
        orderBy: { issueDate: "desc" },
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
// GET /api/documents/:id — Detalhes de um documento
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
const createDocumentSchema = z.object({
  type: z.enum(["INVOICE", "RECEIPT", "BANK_STATEMENT", "CONTRACT", "OTHER"]),
  number: z.string().min(1, "Número do documento é obrigatório"),
  issueDate: z.string(),
  amount: z.number().positive("Valor deve ser positivo"),
  description: z.string().optional(),
  counterpartyId: z.string().optional(),
  fileUrl: z.string().url().optional(),
});

router.post("/", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const data = createDocumentSchema.parse(req.body);

    // Verificar duplicata de número na mesma empresa
    const existing = await prisma.document.findFirst({
      where: { companyId, number: data.number, type: data.type },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        error: "Já existe um documento com este número e tipo",
      });
    }

    // Verificar se counterpartyId pertence à empresa
    if (data.counterpartyId) {
      const counterparty = await prisma.counterparty.findFirst({
        where: { id: data.counterpartyId, companyId },
      });
      if (!counterparty) {
        return res.status(400).json({
          success: false,
          error: "Contraparte não encontrada",
        });
      }
    }

    const document = await prisma.document.create({
      data: {
        companyId,
        type: data.type,
        number: data.number,
        issueDate: new Date(data.issueDate),
        amount: data.amount,
        description: data.description || null,
        counterpartyId: data.counterpartyId || null,
        fileUrl: data.fileUrl || null,
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
const updateDocumentSchema = z.object({
  number: z.string().optional(),
  issueDate: z.string().optional(),
  amount: z.number().positive().optional(),
  description: z.string().optional(),
  counterpartyId: z.string().optional(),
  fileUrl: z.string().url().optional(),
  status: z.enum(["ACTIVE", "CANCELLED", "ARCHIVED"]).optional(),
});

router.patch("/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;
    const data = updateDocumentSchema.parse(req.body);

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

    // Soft delete — muda status para ARCHIVED
    await prisma.document.update({
      where: { id },
      data: { status: "ARCHIVED" },
    });

    res.json({ success: true, message: "Documento arquivado com sucesso" });
  } catch (error) {
    next(error);
  }
});

export default router;
