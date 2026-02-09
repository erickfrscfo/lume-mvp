import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../auth/auth.middleware.js";
import { prisma } from "../../shared/database.js";

const router = Router();

const scenarioSchema = z.object({
  name: z.string().min(1, "Nome é obrigatório"),
  type: z.enum(["PROJECT", "ORGANIZATIONAL_CHANGE", "INVESTMENT", "DIVESTMENT"]),
  description: z.string().optional(),
  adjustments: z.object({
    monthlyRevenue: z.number().optional(),
    monthlyExpense: z.number().optional(),
    oneTimeRevenue: z.number().optional(),
    oneTimeExpense: z.number().optional(),
    startMonth: z.string().optional(),
    endMonth: z.string().optional(),
    notes: z.string().optional(),
  }),
  isActive: z.boolean().default(true),
});

// GET /api/scenarios
router.get("/", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const scenarios = await prisma.scenario.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: scenarios });
  } catch (error) {
    next(error);
  }
});

// POST /api/scenarios
router.post("/", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = scenarioSchema.parse(req.body);
    const companyId = (req as any).companyId;

    const scenario = await prisma.scenario.create({
      data: { ...data, companyId },
    });

    res.status(201).json({ success: true, data: scenario });
  } catch (error) {
    next(error);
  }
});

// PUT /api/scenarios/:id
router.put("/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = scenarioSchema.partial().parse(req.body);
    const companyId = (req as any).companyId;

    const scenario = await prisma.scenario.updateMany({
      where: { id: req.params.id, companyId },
      data,
    });

    res.json({ success: true, data: scenario });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/scenarios/:id/toggle
router.patch("/:id/toggle", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const existing = await prisma.scenario.findFirst({
      where: { id: req.params.id, companyId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: "Cenário não encontrado" });
    }

    const scenario = await prisma.scenario.update({
      where: { id: req.params.id },
      data: { isActive: !existing.isActive },
    });

    res.json({ success: true, data: scenario });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/scenarios/:id
router.delete("/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    await prisma.scenario.deleteMany({
      where: { id: req.params.id, companyId },
    });
    res.json({ success: true, message: "Cenário removido" });
  } catch (error) {
    next(error);
  }
});

export default router;
