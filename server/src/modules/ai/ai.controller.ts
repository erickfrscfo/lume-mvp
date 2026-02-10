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

// POST /api/ai/explain — "Explica pra Mim" com contexto financeiro completo
const explainSchema = z.object({
  metric: z.string().min(1),
  value: z.string().min(1),
  context: z.string().optional(),
});

router.post("/explain", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { metric, value, context: extraContext } = explainSchema.parse(req.body);
    const userId = (req as any).userId;
    const companyId = (req as any).companyId;

    const fullContext = await getEnrichedFinancialContext(companyId, extraContext);
    const result = await aiService.explainMetric(userId, metric, value, fullContext);
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

// ============================================
// CONTEXTO FINANCEIRO ENRIQUECIDO (para "Explica pra Mim")
// Inclui: dados da empresa, DRE mês a mês, evolução, comparação mês anterior,
// categorias detalhadas, cenários ativos, e contexto extra do frontend
// ============================================
async function getEnrichedFinancialContext(companyId: string, extraContext?: string): Promise<string> {
  const now = new Date();
  const sevenMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 7, 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const company = await prisma.company.findUnique({ where: { id: companyId } });

  const transactions = await prisma.transaction.findMany({
    where: { companyId, date: { gte: sevenMonthsAgo } },
    include: { category: true },
    orderBy: { date: "asc" },
  });

  const activeScenarios = await prisma.scenario.findMany({
    where: { companyId, isActive: true },
  });

  if (transactions.length === 0) {
    return "Nenhuma transação financeira registrada ainda.";
  }

  // Agrupamento mês a mês
  const monthlyData: Record<string, { income: number; expense: number; byCategory: Record<string, number> }> = {};
  transactions.forEach((t) => {
    const mk = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`;
    if (!monthlyData[mk]) monthlyData[mk] = { income: 0, expense: 0, byCategory: {} };
    const amt = Number(t.amount);
    if (t.type === "INCOME") monthlyData[mk].income += amt;
    else monthlyData[mk].expense += amt;
    const catName = t.category?.name || "Não classificado";
    monthlyData[mk].byCategory[catName] = (monthlyData[mk].byCategory[catName] || 0) + amt;
  });

  const totalIncome = transactions.filter((t) => t.type === "INCOME").reduce((s, t) => s + Number(t.amount), 0);
  const totalExpense = transactions.filter((t) => t.type === "EXPENSE").reduce((s, t) => s + Number(t.amount), 0);
  const balance = totalIncome - totalExpense;
  const monthCount = Object.keys(monthlyData).length || 1;
  const avgMonthlyIncome = totalIncome / monthCount;
  const avgMonthlyExpense = totalExpense / monthCount;
  const burnRate = avgMonthlyExpense - avgMonthlyIncome;
  const runway = burnRate > 0 ? balance / burnRate : Infinity;

  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const lastMonthKey = `${lastMonthStart.getFullYear()}-${String(lastMonthStart.getMonth() + 1).padStart(2, "0")}`;
  const currentMonth = monthlyData[currentMonthKey] || { income: 0, expense: 0, byCategory: {} };
  const lastMonth = monthlyData[lastMonthKey] || { income: 0, expense: 0, byCategory: {} };

  const currentGrossProfit = currentMonth.income - currentMonth.expense;
  const lastGrossProfit = lastMonth.income - lastMonth.expense;
  const grossProfitChange = lastGrossProfit !== 0 ? ((currentGrossProfit - lastGrossProfit) / Math.abs(lastGrossProfit) * 100) : 0;
  const currentMargin = currentMonth.income > 0 ? (currentGrossProfit / currentMonth.income * 100) : 0;
  const lastMargin = lastMonth.income > 0 ? (lastGrossProfit / lastMonth.income * 100) : 0;

  // Categorias detalhadas
  const allCategories: Record<string, { total: number; type: string }> = {};
  transactions.forEach((t) => {
    const catName = t.category?.name || "Não classificado";
    if (!allCategories[catName]) allCategories[catName] = { total: 0, type: t.type };
    allCategories[catName].total += Number(t.amount);
  });
  const topCategories = Object.entries(allCategories)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 15)
    .map(([name, data]) => `  - ${name} (${data.type === "INCOME" ? "Receita" : "Despesa"}): R$ ${data.total.toLocaleString("pt-BR")}`)
    .join("\n");

  // Evolução mensal
  const monthKeys = Object.keys(monthlyData).sort();
  const monthlyEvolution = monthKeys.map((mk) => {
    const d = monthlyData[mk];
    return `  ${mk}: Receita R$ ${d.income.toLocaleString("pt-BR")} | Despesa R$ ${d.expense.toLocaleString("pt-BR")} | Líquido R$ ${(d.income - d.expense).toLocaleString("pt-BR")}`;
  }).join("\n");

  // Maiores variações
  let biggestChanges = "";
  if (currentMonth && lastMonth) {
    const changes: { name: string; change: number; pct: number }[] = [];
    const allCatNames = new Set([...Object.keys(currentMonth.byCategory), ...Object.keys(lastMonth.byCategory)]);
    allCatNames.forEach((name) => {
      const curr = currentMonth.byCategory[name] || 0;
      const prev = lastMonth.byCategory[name] || 0;
      if (prev > 0) {
        const pct = ((curr - prev) / prev) * 100;
        if (Math.abs(pct) > 10) changes.push({ name, change: curr - prev, pct });
      }
    });
    changes.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    biggestChanges = changes.slice(0, 5).map((c) =>
      `  - ${c.name}: ${c.pct > 0 ? "+" : ""}${c.pct.toFixed(1)}% (${c.change > 0 ? "+" : ""}R$ ${c.change.toLocaleString("pt-BR")})`
    ).join("\n");
  }

  // Cenários ativos
  const scenarioText = activeScenarios.length > 0
    ? activeScenarios.map((s) => {
        const adj = s.adjustments as any;
        return `  - ${s.name} (${s.type}): ${adj?.monthlyRevenue ? `+R$ ${adj.monthlyRevenue}/mês receita` : ""} ${adj?.monthlyExpense ? `R$ ${adj.monthlyExpense}/mês despesa` : ""} ${adj?.startMonth ? `de ${adj.startMonth}` : ""} ${adj?.endMonth ? `até ${adj.endMonth}` : ""}`;
      }).join("\n")
    : "  Nenhum cenário ativo.";

  let context = `=== DADOS DA EMPRESA ===\nNome: ${company?.name || "Não informado"}\nCNPJ: ${company?.cnpj || "Não informado"}\nSetor: ${company?.sector || "Não informado"}\n\n=== RESUMO FINANCEIRO (últimos ${monthCount} meses) ===\n- Total de Receitas: R$ ${totalIncome.toLocaleString("pt-BR")}\n- Total de Despesas: R$ ${totalExpense.toLocaleString("pt-BR")}\n- Saldo Acumulado: R$ ${balance.toLocaleString("pt-BR")}\n- Receita Média Mensal: R$ ${avgMonthlyIncome.toLocaleString("pt-BR")}\n- Despesa Média Mensal: R$ ${avgMonthlyExpense.toLocaleString("pt-BR")}\n- Taxa de Queima (Burn Rate): R$ ${burnRate > 0 ? burnRate.toLocaleString("pt-BR") : "0"}/mês\n- Runway Estimado: ${runway === Infinity ? "Indefinido (caixa positivo)" : `${runway.toFixed(1)} meses`}\n- Total de Transações: ${transactions.length}\n\n=== MÊS ATUAL (${currentMonthKey}) vs MÊS ANTERIOR (${lastMonthKey}) ===\n- Receita Atual: R$ ${currentMonth.income.toLocaleString("pt-BR")} | Anterior: R$ ${lastMonth.income.toLocaleString("pt-BR")}\n- Despesa Atual: R$ ${currentMonth.expense.toLocaleString("pt-BR")} | Anterior: R$ ${lastMonth.expense.toLocaleString("pt-BR")}\n- Lucro Bruto Atual: R$ ${currentGrossProfit.toLocaleString("pt-BR")} | Anterior: R$ ${lastGrossProfit.toLocaleString("pt-BR")}\n- Variação do Lucro Bruto: ${grossProfitChange > 0 ? "+" : ""}${grossProfitChange.toFixed(1)}%\n- Margem Atual: ${currentMargin.toFixed(1)}% | Margem Anterior: ${lastMargin.toFixed(1)}%\n\n=== EVOLUÇÃO MENSAL ===\n${monthlyEvolution}\n\n=== MAIORES VARIAÇÕES (mês atual vs anterior, >10%) ===\n${biggestChanges || "  Sem variações significativas."}\n\n=== TOP CATEGORIAS (acumulado) ===\n${topCategories}\n\n=== CENÁRIOS FINANCEIROS ATIVOS ===\n${scenarioText}`;

  if (extraContext) {
    context += `\n\n=== CONTEXTO ADICIONAL (dados da tela) ===\n${extraContext}`;
  }

  return context;
}

export default router;
