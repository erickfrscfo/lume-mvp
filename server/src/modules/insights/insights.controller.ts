import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../../shared/database.js";
import { authMiddleware } from "../auth/auth.middleware.js";

const router = Router();
router.use(authMiddleware);

// ============================================
// GET /api/insights — Listar insights/alertas inteligentes
// Reutiliza a tabela Alert existente, mapeando campos para o formato de Insight
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

    // Filtro de severidade
    if (req.query.severity) {
      where.severity = req.query.severity;
    }

    // Filtro de dispensados
    if (req.query.isDismissed !== undefined) {
      where.isDismissed = req.query.isDismissed === "true";
    }

    const alerts = await prisma.alert.findMany({
      where,
      orderBy: [
        { isDismissed: "asc" },
        { createdAt: "desc" },
      ],
    });

    // Mapear Alert → Insight format esperado pelo frontend
    const insights = alerts.map((alert) => {
      // Extrair dados do rawData se disponível
      const rawData = (alert.rawData as any) || {};

      return {
        id: alert.id,
        severity: alert.severity,
        title: alert.title,
        description: alert.humanizedText || alert.templateText || "",
        recommendation: rawData.recommendation || rawData.recomendacao || "",
        potentialImpact: rawData.potentialImpact || rawData.impacto || 0,
        potentialSavings: alert.potentialSavings || 0,
        insightType: mapAlertTypeToInsightType(alert.type),
        category: alert.category || "GENERAL",
        read: alert.isRead,
        dismissed: alert.isDismissed,
        readAt: null, // Alert não tem readAt, mas o frontend espera
        createdAt: alert.createdAt.toISOString(),
      };
    });

    return res.json({ success: true, data: insights });
  } catch (error) {
    next(error);
  }
});

// ============================================
// PATCH /api/insights/:id/read — Marcar como lido
// ============================================
router.patch("/:id/read", async (req: Request, res: Response, next: NextFunction) => {
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

    const alert = await prisma.alert.findFirst({
      where: { id, companyId: user.companyId },
    });

    if (!alert) {
      return res.status(404).json({ success: false, error: "Insight não encontrado" });
    }

    await prisma.alert.update({
      where: { id },
      data: { isRead: true },
    });

    return res.json({ success: true, message: "Marcado como lido" });
  } catch (error) {
    next(error);
  }
});

// ============================================
// PATCH /api/insights/:id/dismiss — Dispensar insight
// ============================================
router.patch("/:id/dismiss", async (req: Request, res: Response, next: NextFunction) => {
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

    const alert = await prisma.alert.findFirst({
      where: { id, companyId: user.companyId },
    });

    if (!alert) {
      return res.status(404).json({ success: false, error: "Insight não encontrado" });
    }

    await prisma.alert.update({
      where: { id },
      data: { isDismissed: true },
    });

    return res.json({ success: true, message: "Insight dispensado" });
  } catch (error) {
    next(error);
  }
});

// ============================================
// HELPER: Mapear tipo de alerta para tipo de insight
// ============================================
function mapAlertTypeToInsightType(alertType: string): string {
  const mapping: Record<string, string> = {
    REVENUE_DROP: "ANOMALY",
    EXPENSE_SPIKE: "ANOMALY",
    MARGIN_EROSION: "FORECAST",
    CASH_FLOW_RISK: "FORECAST",
    CATEGORY_ANOMALY: "ANOMALY",
    COST_OPTIMIZATION: "SAVING",
    TAX_OPTIMIZATION: "SAVING",
    COMPLIANCE_RISK: "COMPLIANCE",
    SUPPLIER_ANOMALY: "ANOMALY",
    CONSUMPTION_SPIKE: "ANOMALY",
  };

  return mapping[alertType] || "GENERAL";
}

export default router;
