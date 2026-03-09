import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../auth/auth.middleware.js";
import { prisma } from "../../shared/database.js";
import { z } from "zod";

const router = Router();

// =============================================
// GET /api/insights — Listar alertas inteligentes
// =============================================
router.get("/", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const {
      page = "1",
      limit = "20",
      type,
      severity,
      isRead,
      isDismissed,
      category,
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { companyId };

    if (type) {
      where.type = type;
    }

    if (severity && ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(severity)) {
      where.severity = severity;
    }

    if (isRead !== undefined) {
      where.isRead = isRead === "true";
    }

    if (isDismissed !== undefined) {
      where.isDismissed = isDismissed === "true";
    }

    if (category) {
      where.category = category;
    }

    const [alerts, total] = await Promise.all([
      prisma.alert.findMany({
        where,
        orderBy: [
          { isDismissed: "asc" },
          { createdAt: "desc" },
        ],
        skip,
        take: limitNum,
      }),
      prisma.alert.count({ where }),
    ]);

    res.json({
      success: true,
      data: alerts,
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
// GET /api/insights/summary — Resumo dos alertas
// =============================================
router.get("/summary", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;

    const [total, unread, bySeverity, byType, totalSavings] = await Promise.all([
      prisma.alert.count({ where: { companyId, isDismissed: false } }),
      prisma.alert.count({ where: { companyId, isRead: false, isDismissed: false } }),
      prisma.alert.groupBy({
        by: ["severity"],
        where: { companyId, isDismissed: false },
        _count: { id: true },
      }),
      prisma.alert.groupBy({
        by: ["type"],
        where: { companyId, isDismissed: false },
        _count: { id: true },
      }),
      prisma.alert.aggregate({
        where: { companyId, isDismissed: false },
        _sum: { potentialSavings: true },
      }),
    ]);

    res.json({
      success: true,
      data: {
        total,
        unread,
        potentialSavings: totalSavings._sum.potentialSavings || 0,
        bySeverity: bySeverity.map((s) => ({
          severity: s.severity,
          count: s._count.id,
        })),
        byType: byType.map((t) => ({
          type: t.type,
          count: t._count.id,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

// =============================================
// GET /api/insights/:id — Detalhes de um alerta
// =============================================
router.get("/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;

    const alert = await prisma.alert.findFirst({
      where: { id, companyId },
    });

    if (!alert) {
      return res.status(404).json({ success: false, error: "Alerta não encontrado" });
    }

    // Marcar como lido automaticamente ao visualizar
    if (!alert.isRead) {
      await prisma.alert.update({
        where: { id },
        data: { isRead: true },
      });
      alert.isRead = true;
    }

    res.json({ success: true, data: alert });
  } catch (error) {
    next(error);
  }
});

// =============================================
// PATCH /api/insights/:id/read — Marcar como lido
// =============================================
router.patch("/:id/read", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;

    const alert = await prisma.alert.findFirst({
      where: { id, companyId },
    });

    if (!alert) {
      return res.status(404).json({ success: false, error: "Alerta não encontrado" });
    }

    const updated = await prisma.alert.update({
      where: { id },
      data: { isRead: true },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// =============================================
// PATCH /api/insights/:id/dismiss — Dispensar alerta
// =============================================
router.patch("/:id/dismiss", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;

    const alert = await prisma.alert.findFirst({
      where: { id, companyId },
    });

    if (!alert) {
      return res.status(404).json({ success: false, error: "Alerta não encontrado" });
    }

    const updated = await prisma.alert.update({
      where: { id },
      data: { isDismissed: true, isRead: true },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// =============================================
// POST /api/insights/read-all — Marcar todos como lidos
// =============================================
router.post("/read-all", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;

    const result = await prisma.alert.updateMany({
      where: { companyId, isRead: false },
      data: { isRead: true },
    });

    res.json({
      success: true,
      data: { updated: result.count },
    });
  } catch (error) {
    next(error);
  }
});

// =============================================
// POST /api/insights/dismiss-all — Dispensar todos
// =============================================
router.post("/dismiss-all", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { type, severity } = req.body;

    const where: any = { companyId, isDismissed: false };
    if (type) where.type = type;
    if (severity) where.severity = severity;

    const result = await prisma.alert.updateMany({
      where,
      data: { isDismissed: true, isRead: true },
    });

    res.json({
      success: true,
      data: { dismissed: result.count },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
