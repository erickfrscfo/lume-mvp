import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../auth/auth.middleware.js";
import * as aiService from "./ai.service.js";
import { prisma } from "../../shared/database.js";

const router = Router();

// POST /api/ai/chat
const chatSchema = z.object({
  message: z.string().min(1, "Mensagem é obrigatória"),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })).default([]),
});

router.post("/chat", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { message, history } = chatSchema.parse(req.body);
    const userId = (req as any).userId;
    const companyId = (req as any).companyId;

    // Buscar contexto financeiro da empresa
    const financialContext = await getFinancialContext(companyId);

    const result = await aiService.chat(userId, message, financialContext, history);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// POST /api/ai/explain
const explainSchema = z.object({
  metric: z.string().min(1),
  value: z.string().min(1),
});

router.post("/explain", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { metric, value } = explainSchema.parse(req.body);
    const userId = (req as any).userId;
    const companyId = (req as any).companyId;

    const financialContext = await getFinancialContext(companyId);
    const result = await aiService.explainMetric(userId, metric, value, financialContext);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// GET /api/ai/chat/history
router.get("/chat/history", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).userId;
    const interactions = await prisma.aiInteraction.findMany({
      where: { userId, type: "CHAT" },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        promptSent: true,
        responseReceived: true,
        tokenUsage: true,
        createdAt: true,
      },
    });
    res.json({ success: true, data: interactions });
  } catch (error) {
    next(error);
  }
});

// Função auxiliar para montar contexto financeiro
async function getFinancialContext(companyId: string): Promise<string> {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1);

  const transactions = await prisma.transaction.findMany({
    where: {
      companyId,
      date: { gte: sixMonthsAgo },
    },
    include: { category: true },
    orderBy: { date: "desc" },
  });

  if (transactions.length === 0) {
    return "Nenhuma transação financeira registrada ainda.";
  }

  const totalIncome = transactions
    .filter((t) => t.type === "INCOME")
    .reduce((sum, t) => sum + Number(t.amount), 0);

  const totalExpense = transactions
    .filter((t) => t.type === "EXPENSE")
    .reduce((sum, t) => sum + Number(t.amount), 0);

  const balance = totalIncome - totalExpense;
  const months = 6;
  const avgMonthlyIncome = totalIncome / months;
  const avgMonthlyExpense = totalExpense / months;
  const burnRate = avgMonthlyExpense - avgMonthlyIncome;
  const runway = burnRate > 0 ? balance / burnRate : Infinity;

  // Agrupar por categoria
  const byCategory: Record<string, number> = {};
  transactions.forEach((t) => {
    const cat = t.category?.name || "Não classificado";
    byCategory[cat] = (byCategory[cat] || 0) + Number(t.amount);
  });

  const categoryBreakdown = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, total]) => `  - ${name}: R$ ${total.toLocaleString("pt-BR")}`)
    .join("\n");

  return `RESUMO FINANCEIRO (últimos 6 meses):
- Total de Receitas: R$ ${totalIncome.toLocaleString("pt-BR")}
- Total de Despesas: R$ ${totalExpense.toLocaleString("pt-BR")}
- Saldo: R$ ${balance.toLocaleString("pt-BR")}
- Receita Média Mensal: R$ ${avgMonthlyIncome.toLocaleString("pt-BR")}
- Despesa Média Mensal: R$ ${avgMonthlyExpense.toLocaleString("pt-BR")}
- Taxa de Queima: R$ ${burnRate > 0 ? burnRate.toLocaleString("pt-BR") : "0"}/mês
- Runway Estimado: ${runway === Infinity ? "Indefinido (caixa positivo)" : `${runway.toFixed(1)} meses`}
- Total de Transações: ${transactions.length}

MAIORES CATEGORIAS:
${categoryBreakdown}`;
}

export default router;
