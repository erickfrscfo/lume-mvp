import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../auth/auth.middleware.js";
import { prisma } from "../../shared/database.js";

const router = Router();

// =============================================
// GET /api/insights — Listar insights/alertas inteligentes
// =============================================
router.get("/", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const {
      page = "1",
      limit = "20",
      insightType,
      severity,
      showDismissed = "false",
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { companyId };

    if (showDismissed !== "true") {
      where.isDismissed = false;
    }

    if (insightType) {
      where.insightType = insightType;
    }

    if (severity && ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(severity)) {
      where.severity = severity;
    }

    // Filtrar insights expirados
    where.OR = [
      { expiresAt: null },
      { expiresAt: { gt: new Date() } },
    ];

    const [insights, total, unreadCount] = await Promise.all([
      prisma.aiInsight.findMany({
        where,
        include: {
          counterparty: { select: { id: true, name: true } },
        },
        orderBy: [
          { severity: "desc" },
          { createdAt: "desc" },
        ],
        skip,
        take: limitNum,
      }),
      prisma.aiInsight.count({ where }),
      prisma.aiInsight.count({
        where: { companyId, isRead: false, isDismissed: false },
      }),
    ]);

    res.json({
      success: true,
      data: insights,
      unreadCount,
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
// GET /api/insights/summary — Resumo de insights
// =============================================
router.get("/summary", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;

    const insights = await prisma.aiInsight.findMany({
      where: {
        companyId,
        isDismissed: false,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } },
        ],
      },
    });

    const bySeverity = {
      CRITICAL: insights.filter((i) => i.severity === "CRITICAL").length,
      HIGH: insights.filter((i) => i.severity === "HIGH").length,
      MEDIUM: insights.filter((i) => i.severity === "MEDIUM").length,
      LOW: insights.filter((i) => i.severity === "LOW").length,
    };

    const byType: Record<string, number> = {};
    insights.forEach((i) => {
      byType[i.insightType] = (byType[i.insightType] || 0) + 1;
    });

    const totalPotentialImpact = insights.reduce(
      (sum, i) => sum + Number(i.potentialImpact || 0),
      0
    );

    const totalPotentialSavings = insights.reduce(
      (sum, i) => sum + Number(i.potentialSavings || 0),
      0
    );

    res.json({
      success: true,
      data: {
        total: insights.length,
        unread: insights.filter((i) => !i.isRead).length,
        bySeverity,
        byType,
        totalPotentialImpact,
        totalPotentialSavings,
      },
    });
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

    const insight = await prisma.aiInsight.findFirst({
      where: { id, companyId },
    });

    if (!insight) {
      return res.status(404).json({ success: false, error: "Insight não encontrado" });
    }

    const updated = await prisma.aiInsight.update({
      where: { id },
      data: { isRead: true, readAt: new Date() },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// =============================================
// PATCH /api/insights/:id/dismiss — Dispensar insight
// =============================================
router.patch("/:id/dismiss", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;

    const insight = await prisma.aiInsight.findFirst({
      where: { id, companyId },
    });

    if (!insight) {
      return res.status(404).json({ success: false, error: "Insight não encontrado" });
    }

    const updated = await prisma.aiInsight.update({
      where: { id },
      data: { isDismissed: true },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// =============================================
// PATCH /api/insights/:id/act — Marcar como ação tomada
// =============================================
router.patch("/:id/act", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;

    const insight = await prisma.aiInsight.findFirst({
      where: { id, companyId },
    });

    if (!insight) {
      return res.status(404).json({ success: false, error: "Insight não encontrado" });
    }

    const updated = await prisma.aiInsight.update({
      where: { id },
      data: { actedAt: new Date(), isRead: true, readAt: insight.readAt || new Date() },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// =============================================
// POST /api/insights/mark-all-read — Marcar todos como lidos
// =============================================
router.post("/mark-all-read", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;

    const result = await prisma.aiInsight.updateMany({
      where: { companyId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });

    res.json({ success: true, data: { updated: result.count } });
  } catch (error) {
    next(error);
  }
});

export default router;
