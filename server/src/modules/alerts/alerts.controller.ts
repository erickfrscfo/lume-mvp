/**
 * ALERTAS INTELIGENTES — Controller
 * 
 * Endpoints:
 * - GET  /api/alerts          → Lista alertas ativos da empresa
 * - PATCH /api/alerts/:id/read → Marca alerta como lido
 * - PATCH /api/alerts/:id/dismiss → Descarta alerta
 * - POST /api/alerts/generate  → Gera alertas manualmente (debug)
 * 
 * Orquestrador:
 * - generateAlerts(companyId, userId) → Executa as 3 camadas e salva no banco
 */

import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../auth/auth.middleware.js";
import { prisma } from "../../shared/database.js";
import crypto from "crypto";
import { detectAllAlerts, RawAlert } from "./alerts.detector.js";
import { applyTemplate } from "./alerts.templates.js";
import { humanizeAlerts } from "./alerts.humanizer.js";

const router = Router();

// ============================================
// ORQUESTRADOR PRINCIPAL
// Executa as 3 camadas e salva alertas no banco
// ============================================
export async function generateAlerts(companyId: string, userId: string): Promise<void> {
  try {
    console.log(`[Alerts] Iniciando geração de alertas para empresa ${companyId}`);

    // CAMADA 1 — Detecção (sem IA)
    const rawAlerts = await detectAllAlerts(companyId);
    console.log(`[Alerts] Camada 1: ${rawAlerts.length} alertas detectados`);

    if (rawAlerts.length === 0) {
      console.log("[Alerts] Nenhum alerta detectado, finalizando");
      return;
    }

    // CAMADA 2 — Templates (sem IA)
    const alertsWithTemplates = rawAlerts.map((alert) => ({
      ...alert,
      templateText: applyTemplate(alert),
    }));
    console.log(`[Alerts] Camada 2: Templates aplicados`);

    // Gerar hash dos dados para cache
    const dataHash = crypto.createHash("md5")
      .update(JSON.stringify(rawAlerts.map((a) => a.data)))
      .digest("hex");

    // Verificar se já existem alertas com mesmo hash (cache)
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const existingWithSameHash = await prisma.alert.findFirst({
      where: {
        companyId,
        dataHash,
        createdAt: { gte: oneDayAgo },
      },
    });

    if (existingWithSameHash) {
      console.log(`[Alerts] Cache hit — alertas já existem com hash ${dataHash.slice(0, 8)}`);
      return;
    }

    // Marcar alertas antigos como expirados (soft delete via dismiss)
    await prisma.alert.updateMany({
      where: {
        companyId,
        isDismissed: false,
      },
      data: {
        isDismissed: true,
      },
    });

    // CAMADA 3 — Humanização por LLM (1 chamada batch)
    let humanizedTexts: string[];
    try {
      humanizedTexts = await humanizeAlerts(userId, companyId, alertsWithTemplates);
      console.log(`[Alerts] Camada 3: Humanização concluída`);
    } catch (error) {
      console.error("[Alerts] Erro na Camada 3, usando templates:", error);
      humanizedTexts = alertsWithTemplates.map((a) => a.templateText);
    }

    // Salvar alertas no banco
    for (let i = 0; i < alertsWithTemplates.length; i++) {
      const alert = alertsWithTemplates[i];
      await prisma.alert.create({
        data: {
          companyId,
          type: alert.type as any,
          severity: alert.severity as any,
          title: alert.title,
          rawData: alert.data,
          templateText: alert.templateText,
          humanizedText: humanizedTexts[i] || alert.templateText,
          category: alert.category || null,
          potentialSavings: alert.potentialSavings || null,
          dataHash,
          isRead: false,
          isDismissed: false,
        },
      });
    }

    console.log(`[Alerts] ${alertsWithTemplates.length} alertas salvos no banco`);
  } catch (error) {
    console.error("[Alerts] Erro na geração de alertas:", error);
    // Não propagar erro — alertas são best-effort, não devem quebrar o upload
  }
}

// ============================================
// ENDPOINTS
// ============================================

// GET /api/alerts — Lista alertas ativos (não descartados)
router.get("/", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;

    const alerts = await prisma.alert.findMany({
      where: {
        companyId,
        isDismissed: false,
      },
      orderBy: [
        { severity: "desc" }, // CRITICAL primeiro
        { createdAt: "desc" },
      ],
    });

    // Calcular economia potencial total
    const totalSavings = alerts.reduce((sum, a) => sum + (a.potentialSavings || 0), 0);
    const unreadCount = alerts.filter((a) => !a.isRead).length;

    res.json({
      success: true,
      data: {
        alerts: alerts.map((a) => ({
          id: a.id,
          type: a.type,
          severity: a.severity,
          title: a.title,
          text: a.humanizedText || a.templateText,
          templateText: a.templateText,
          category: a.category,
          potentialSavings: a.potentialSavings,
          isRead: a.isRead,
          rawData: a.rawData,
          createdAt: a.createdAt,
        })),
        summary: {
          total: alerts.length,
          unread: unreadCount,
          totalSavings,
          bySeverity: {
            critical: alerts.filter((a) => a.severity === "CRITICAL").length,
            high: alerts.filter((a) => a.severity === "HIGH").length,
            medium: alerts.filter((a) => a.severity === "MEDIUM").length,
            low: alerts.filter((a) => a.severity === "LOW").length,
          },
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/alerts/:id/read — Marca como lido
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

    await prisma.alert.update({
      where: { id },
      data: { isRead: true },
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/alerts/:id/dismiss — Descarta alerta
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

    await prisma.alert.update({
      where: { id },
      data: { isDismissed: true },
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// POST /api/alerts/generate — Gera alertas manualmente (para debug/teste)
router.post("/generate", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const userId = (req as any).userId;

    await generateAlerts(companyId, userId);

    // Retornar alertas gerados
    const alerts = await prisma.alert.findMany({
      where: { companyId, isDismissed: false },
      orderBy: { createdAt: "desc" },
    });

    res.json({
      success: true,
      data: {
        generated: alerts.length,
        alerts: alerts.map((a) => ({
          id: a.id,
          type: a.type,
          severity: a.severity,
          title: a.title,
          text: a.humanizedText || a.templateText,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
