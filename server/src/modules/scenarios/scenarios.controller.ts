import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../auth/auth.middleware.js";
import { prisma } from "../../shared/database.js";
import * as aiService from "../ai/ai.service.js";

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

// ============================================
// POST /api/scenarios/ai-chat
// Chat inteligente para criação de cenários com follow-up
// ============================================
const aiChatSchema = z.object({
  message: z.string().min(1, "Mensagem é obrigatória"),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })).default([]),
});

router.post("/ai-chat", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { message, history } = aiChatSchema.parse(req.body);
    const userId = (req as any).userId;
    const companyId = (req as any).companyId;

    // Buscar contexto financeiro enriquecido da empresa
    const financialContext = await getScenarioFinancialContext(companyId);

    const result = await aiService.scenarioChat(userId, message, financialContext, history);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ============================================
// Contexto financeiro simplificado para cenários
// (não precisa de transações individuais, mas precisa de resumo)
// ============================================
async function getScenarioFinancialContext(companyId: string): Promise<string> {
  const now = new Date();
  const company = await prisma.company.findUnique({ where: { id: companyId } });

  const allTransactions = await prisma.transaction.findMany({
    where: { companyId },
    include: { category: true },
    orderBy: { date: "asc" },
  });

  if (allTransactions.length === 0) {
    return "Nenhuma transação financeira registrada ainda. A empresa ainda não tem histórico financeiro.";
  }

  // Agrupamento mês a mês
  const monthlyData: Record<string, { income: number; expense: number }> = {};
  allTransactions.forEach((t) => {
    const mk = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`;
    if (!monthlyData[mk]) monthlyData[mk] = { income: 0, expense: 0 };
    const amt = Number(t.amount);
    if (t.tipo_transacao === "INCOME") monthlyData[mk].income += amt;
    else monthlyData[mk].expense += amt;
  });

  const totalIncome = allTransactions.filter(t => t.tipo_transacao === "INCOME").reduce((s, t) => s + Number(t.amount), 0);
  const totalExpense = allTransactions.filter(t => t.tipo_transacao === "EXPENSE").reduce((s, t) => s + Number(t.amount), 0);
  const balance = totalIncome - totalExpense;
  const monthCount = Object.keys(monthlyData).length || 1;
  const avgMonthlyIncome = totalIncome / monthCount;
  const avgMonthlyExpense = totalExpense / monthCount;

  // Despesas por categoria (top 10)
  const expenseByCategory: Record<string, number> = {};
  allTransactions.filter(t => t.tipo_transacao === "EXPENSE").forEach(t => {
    const cat = t.category?.name || "Não classificado";
    expenseByCategory[cat] = (expenseByCategory[cat] || 0) + Number(t.amount);
  });
  const topExpenses = Object.entries(expenseByCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, val]) => `  - ${name}: R$ ${(val / monthCount).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}/mês (média)`)
    .join("\n");

  // Receitas por categoria (top 5)
  const incomeByCategory: Record<string, number> = {};
  allTransactions.filter(t => t.tipo_transacao === "INCOME").forEach(t => {
    const cat = t.category?.name || "Não classificado";
    incomeByCategory[cat] = (incomeByCategory[cat] || 0) + Number(t.amount);
  });
  const topIncomes = Object.entries(incomeByCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, val]) => `  - ${name}: R$ ${(val / monthCount).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}/mês (média)`)
    .join("\n");

  // Folha de pagamento atual (para inferir encargos)
  const payrollCategories = ["Salários e Pró-Labore", "Encargos Trabalhistas", "Benefícios", "Prestadores PJ"];
  const monthlyPayroll = allTransactions
    .filter(t => t.tipo_transacao === "EXPENSE" && payrollCategories.includes(t.category?.name || ""))
    .reduce((s, t) => s + Number(t.amount), 0) / monthCount;

  // Cenários ativos
  const activeScenarios = await prisma.scenario.findMany({
    where: { companyId, isActive: true },
  });
  const scenarioText = activeScenarios.length > 0
    ? activeScenarios.map(s => {
        const adj = s.adjustments as any;
        return `  - ${s.name}: ${adj?.monthlyRevenue ? `+R$ ${Math.abs(adj.monthlyRevenue).toLocaleString("pt-BR")}/mês receita` : ""} ${adj?.monthlyExpense ? `R$ ${Math.abs(adj.monthlyExpense).toLocaleString("pt-BR")}/mês despesa` : ""}`;
      }).join("\n")
    : "  Nenhum cenário ativo.";

  const fmt = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return `=== EMPRESA ===
Nome: ${company?.name || "Não informado"}
Setor: ${company?.sector || "Não informado"}

=== RESUMO FINANCEIRO (${monthCount} meses de dados) ===
- Faturamento médio mensal: R$ ${fmt(avgMonthlyIncome)}
- Despesa média mensal: R$ ${fmt(avgMonthlyExpense)}
- Resultado médio mensal: R$ ${fmt(avgMonthlyIncome - avgMonthlyExpense)}
- Saldo acumulado: R$ ${fmt(balance)}
- Folha de pagamento média: R$ ${fmt(monthlyPayroll)}/mês

=== PRINCIPAIS FONTES DE RECEITA ===
${topIncomes}

=== PRINCIPAIS DESPESAS ===
${topExpenses}

=== CENÁRIOS JÁ CRIADOS ===
${scenarioText}`;
}

export default router;
