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

    const financialContext = await getEnrichedFinancialContext(companyId);

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

// ============================================
// NOVO ENDPOINT: POST /api/ai/classify-cost-type
// Classifica transações de despesa como custo fixo ou variável
// ============================================
const classifyCostSchema = z.object({
  transactionIds: z.array(z.string()).optional(), // Se vazio, classifica todas as despesas sem tipo_custo
});

router.post("/classify-cost-type", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { transactionIds } = classifyCostSchema.parse(req.body);
    const userId = (req as any).userId;
    const companyId = (req as any).companyId;

    // Buscar transações de despesa sem classificação de tipo de custo
    const where: any = {
      companyId,
      tipo_transacao: "EXPENSE",
      tipo_custo: null,
    };

    if (transactionIds && transactionIds.length > 0) {
      where.id = { in: transactionIds };
    }

    const unclassifiedExpenses = await prisma.transaction.findMany({
      where,
      include: { category: true },
      orderBy: { date: "desc" },
      take: 100, // Limitar a 100 por vez para não sobrecarregar a IA
    });

    if (unclassifiedExpenses.length === 0) {
      return res.json({
        success: true,
        data: {
          classified: 0,
          message: "Nenhuma despesa pendente de classificação de tipo de custo",
        },
      });
    }

    // Preparar dados para a IA
    const transactionsForAi = unclassifiedExpenses.map((t) => ({
      id: t.id,
      description: t.description,
      amount: Number(t.amount),
      categoryName: t.category?.name,
    }));

    // Chamar IA para classificar
    const classifications = await aiService.classifyCostType(userId, transactionsForAi);

    // Atualizar transações no banco
    let classifiedCount = 0;
    for (const classification of classifications) {
      try {
        await prisma.transaction.update({
          where: { id: classification.id },
          data: {
            tipo_custo: classification.costType,
            costConfidence: classification.confidence,
          },
        });
        classifiedCount++;
      } catch (updateError) {
        console.error(`Erro ao atualizar transação ${classification.id}:`, updateError);
      }
    }

    res.json({
      success: true,
      data: {
        classified: classifiedCount,
        total: unclassifiedExpenses.length,
        message: `${classifiedCount} de ${unclassifiedExpenses.length} despesas classificadas com sucesso`,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// NOVO ENDPOINT: GET /api/ai/pending-cost-classifications
// Retorna transações de despesa que ainda não têm tipo_custo classificado
// ============================================
router.get("/pending-cost-classifications", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;

    const pendingExpenses = await prisma.transaction.findMany({
      where: {
        companyId,
        tipo_transacao: "EXPENSE",
        tipo_custo: null,
      },
      include: { category: true },
      orderBy: { date: "desc" },
      take: 50, // Limitar a 50 para não sobrecarregar o frontend
    });

    const formattedExpenses = pendingExpenses.map((t) => ({
      id: t.id,
      date: t.date,
      description: t.description,
      amount: Number(t.amount),
      category: t.category ? { code: t.category.code, name: t.category.name } : null,
    }));

    res.json({
      success: true,
      data: {
        count: pendingExpenses.length,
        transactions: formattedExpenses,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// NOVO ENDPOINT: PUT /api/ai/update-cost-type/:id
// Permite ao usuário corrigir manualmente a classificação de tipo de custo
// ============================================
const updateCostTypeSchema = z.object({
  costType: z.enum(["FIXO", "VARIAVEL"]),
});

router.put("/update-cost-type/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { costType } = updateCostTypeSchema.parse(req.body);
    const companyId = (req as any).companyId;

    // Verificar se a transação pertence à empresa do usuário
    const transaction = await prisma.transaction.findFirst({
      where: { id, companyId },
    });

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transação não encontrada" });
    }

    // Atualizar tipo de custo (confiança = 1.0 pois foi manual)
    await prisma.transaction.update({
      where: { id },
      data: {
        tipo_custo: costType,
        costConfidence: 1.0, // Confiança máxima para classificação manual
      },
    });

    res.json({
      success: true,
      data: {
        id,
        costType,
        message: "Tipo de custo atualizado com sucesso",
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/ai/suggested-prompts — Perguntas prontas baseadas nos dados da empresa
router.get("/suggested-prompts", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;

    const now = new Date();
    const currentMonthName = now.toLocaleString("pt-BR", { month: "long" });
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthName = lastMonthDate.toLocaleString("pt-BR", { month: "long" });
    const currentYear = now.getFullYear();

    const transactionCount = await prisma.transaction.count({ where: { companyId } });

    const prompts = [
      {
        category: "Margem e Lucratividade",
        questions: [
          `Qual foi a margem de lucro de ${lastMonthName} de ${currentYear}?`,
          `Compare a margem de lucro dos últimos 3 meses. Está melhorando ou piorando?`,
          `Qual mês teve a melhor margem de lucro e por quê?`,
        ],
      },
      {
        category: "Receitas e Despesas",
        questions: [
          `Quais foram as maiores despesas de ${lastMonthName}?`,
          `Como as receitas evoluíram nos últimos 6 meses?`,
          `Quais categorias de despesa mais cresceram no último mês?`,
        ],
      },
      {
        category: "Fluxo de Caixa",
        questions: [
          "Qual é a situação atual do meu fluxo de caixa?",
          "Em quantos meses o caixa vai zerar se continuar nesse ritmo?",
          `Qual foi o saldo líquido de ${lastMonthName}?`,
        ],
      },
      {
        category: "Análise Estratégica",
        questions: [
          "Quais são os 3 maiores riscos financeiros da empresa agora?",
          "O que eu deveria cortar primeiro para melhorar o caixa?",
          "A empresa está crescendo de forma saudável?",
        ],
      },
      {
        category: "Projeções",
        questions: [
          "Se eu aumentar as vendas em 20%, como fica o caixa em 6 meses?",
          "Qual receita mensal mínima eu preciso para cobrir todas as despesas?",
          "Qual é o ponto de equilíbrio (break-even) mensal da empresa?",
        ],
      },
    ];

    res.json({ success: true, data: { prompts, transactionCount } });
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

// ============================================
// CONTEXTO FINANCEIRO ENRIQUECIDO
// Agora inclui: despesas por categoria POR MÊS (não apenas acumulado)
// para que a IA consiga responder perguntas sobre meses específicos
// ============================================
async function getEnrichedFinancialContext(companyId: string, extraContext?: string): Promise<string> {
  const now = new Date();

  const company = await prisma.company.findUnique({ where: { id: companyId } });

  // Buscar TODAS as transações da empresa
  const allTransactions = await prisma.transaction.findMany({
    where: { companyId },
    include: { category: true },
    orderBy: { date: "asc" },
  });

  const activeScenarios = await prisma.scenario.findMany({
    where: { companyId, isActive: true },
  });

  if (allTransactions.length === 0) {
    return "Nenhuma transação financeira registrada ainda.";
  }

  // Agrupamento mês a mês com categorias detalhadas POR MÊS
  const monthlyData: Record<string, {
    income: number;
    expense: number;
    incomeByCategory: Record<string, number>;
    expenseByCategory: Record<string, number>;
  }> = {};

  allTransactions.forEach((t) => {
    const mk = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`;
    if (!monthlyData[mk]) {
      monthlyData[mk] = { income: 0, expense: 0, incomeByCategory: {}, expenseByCategory: {} };
    }
    const amt = Number(t.amount);
    const catName = t.category?.name || "Não classificado";

    if (t.tipo_transacao === "INCOME") {
      monthlyData[mk].income += amt;
      monthlyData[mk].incomeByCategory[catName] = (monthlyData[mk].incomeByCategory[catName] || 0) + amt;
    } else {
      monthlyData[mk].expense += amt;
      monthlyData[mk].expenseByCategory[catName] = (monthlyData[mk].expenseByCategory[catName] || 0) + amt;
    }
  });

  const totalIncome = allTransactions.filter((t) => t.tipo_transacao === "INCOME").reduce((s, t) => s + Number(t.amount), 0);
  const totalExpense = allTransactions.filter((t) => t.tipo_transacao === "EXPENSE").reduce((s, t) => s + Number(t.amount), 0);
  const balance = totalIncome - totalExpense;
  const monthCount = Object.keys(monthlyData).length || 1;
  const avgMonthlyIncome = totalIncome / monthCount;
  const avgMonthlyExpense = totalExpense / monthCount;
  const burnRate = avgMonthlyExpense - avgMonthlyIncome;
  const runway = burnRate > 0 ? balance / burnRate : Infinity;

  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthKey = `${lastMonthStart.getFullYear()}-${String(lastMonthStart.getMonth() + 1).padStart(2, "0")}`;
  const currentMonth = monthlyData[currentMonthKey] || { income: 0, expense: 0, incomeByCategory: {}, expenseByCategory: {} };
  const lastMonth = monthlyData[lastMonthKey] || { income: 0, expense: 0, incomeByCategory: {}, expenseByCategory: {} };

  const currentGrossProfit = currentMonth.income - currentMonth.expense;
  const lastGrossProfit = lastMonth.income - lastMonth.expense;
  const grossProfitChange = lastGrossProfit !== 0 ? ((currentGrossProfit - lastGrossProfit) / Math.abs(lastGrossProfit) * 100) : 0;
  const currentMargin = currentMonth.income > 0 ? (currentGrossProfit / currentMonth.income * 100) : 0;
  const lastMargin = lastMonth.income > 0 ? (lastGrossProfit / lastMonth.income * 100) : 0;

  // Evolução mensal COM MARGEM DE LUCRO E CATEGORIAS DETALHADAS
  const monthKeys = Object.keys(monthlyData).sort();

  const monthlyEvolution = monthKeys.map((mk) => {
    const d = monthlyData[mk];
    const net = d.income - d.expense;
    const margin = d.income > 0 ? ((net / d.income) * 100).toFixed(1) : "0.0";

    // Top 5 despesas do mês
    const topExpenses = Object.entries(d.expenseByCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, val]) => `      - ${name}: R$ ${val.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
      .join("\n");

    // Top 5 receitas do mês
    const topIncomes = Object.entries(d.incomeByCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, val]) => `      - ${name}: R$ ${val.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
      .join("\n");

    let detail = `  ${mk}:`;
    detail += `\n    Receita Total: R$ ${d.income.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    detail += `\n    Despesa Total: R$ ${d.expense.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    detail += `\n    Líquido: R$ ${net.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    detail += `\n    Margem de Lucro: ${margin}%`;
    if (topIncomes) {
      detail += `\n    Receitas por categoria:`;
      detail += `\n${topIncomes}`;
    }
    if (topExpenses) {
      detail += `\n    Despesas por categoria:`;
      detail += `\n${topExpenses}`;
    }
    return detail;
  }).join("\n\n");

  // Maiores variações mês atual vs anterior
  let biggestChanges = "";
  if (currentMonth && lastMonth) {
    const changes: { name: string; change: number; pct: number; type: string }[] = [];
    const allExpCats = new Set([...Object.keys(currentMonth.expenseByCategory), ...Object.keys(lastMonth.expenseByCategory)]);
    allExpCats.forEach((name) => {
      const curr = currentMonth.expenseByCategory[name] || 0;
      const prev = lastMonth.expenseByCategory[name] || 0;
      if (prev > 0) {
        const pct = ((curr - prev) / prev) * 100;
        if (Math.abs(pct) > 10) changes.push({ name, change: curr - prev, pct, type: "Despesa" });
      }
    });
    const allIncCats = new Set([...Object.keys(currentMonth.incomeByCategory), ...Object.keys(lastMonth.incomeByCategory)]);
    allIncCats.forEach((name) => {
      const curr = currentMonth.incomeByCategory[name] || 0;
      const prev = lastMonth.incomeByCategory[name] || 0;
      if (prev > 0) {
        const pct = ((curr - prev) / prev) * 100;
        if (Math.abs(pct) > 10) changes.push({ name, change: curr - prev, pct, type: "Receita" });
      }
    });
    changes.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    biggestChanges = changes.slice(0, 8).map((c) =>
      `  - ${c.name} (${c.type}): ${c.pct > 0 ? "+" : ""}${c.pct.toFixed(1)}% (${c.change > 0 ? "+" : ""}R$ ${c.change.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`
    ).join("\n");
  }

  // Cenários ativos
  const scenarioText = activeScenarios.length > 0
    ? activeScenarios.map((s) => {
        const adj = s.adjustments as any;
        return `  - ${s.name} (${s.type}): ${adj?.monthlyRevenue ? `+R$ ${adj.monthlyRevenue}/mês receita` : ""} ${adj?.monthlyExpense ? `R$ ${adj.monthlyExpense}/mês despesa` : ""} ${adj?.startMonth ? `de ${adj.startMonth}` : ""} ${adj?.endMonth ? `até ${adj.endMonth}` : ""}`;
      }).join("\n")
    : "  Nenhum cenário ativo.";

  let context = `=== DADOS DA EMPRESA ===
Nome: ${company?.name || "Não informado"}
CNPJ: ${company?.cnpj || "Não informado"}
Setor: ${company?.sector || "Não informado"}

=== RESUMO FINANCEIRO (todos os ${monthCount} meses com dados) ===
- Total de Receitas: R$ ${totalIncome.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Total de Despesas: R$ ${totalExpense.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Saldo Acumulado: R$ ${balance.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Receita Média Mensal: R$ ${avgMonthlyIncome.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Despesa Média Mensal: R$ ${avgMonthlyExpense.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Taxa de Queima (Burn Rate): R$ ${burnRate > 0 ? burnRate.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0,00"}/mês
- Runway Estimado: ${runway === Infinity ? "Indefinido (caixa positivo)" : `${runway.toFixed(1)} meses`}
- Total de Transações: ${allTransactions.length}

=== MÊS ATUAL (${currentMonthKey}) vs MÊS ANTERIOR (${lastMonthKey}) ===
- Receita Atual: R$ ${currentMonth.income.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | Anterior: R$ ${lastMonth.income.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Despesa Atual: R$ ${currentMonth.expense.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | Anterior: R$ ${lastMonth.expense.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Lucro Bruto Atual: R$ ${currentGrossProfit.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | Anterior: R$ ${lastGrossProfit.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Variação do Lucro Bruto: ${grossProfitChange > 0 ? "+" : ""}${grossProfitChange.toFixed(1)}%
- Margem Atual: ${currentMargin.toFixed(1)}% | Margem Anterior: ${lastMargin.toFixed(1)}%

=== EVOLUÇÃO MENSAL DETALHADA (com categorias por mês) ===
IMPORTANTE: Os valores abaixo são POR MÊS. Quando o usuário perguntar sobre um mês específico, use APENAS os dados daquele mês. NÃO some valores de meses diferentes.

${monthlyEvolution}

=== MAIORES VARIAÇÕES (${currentMonthKey} vs ${lastMonthKey}, >10%) ===
${biggestChanges || "  Sem variações significativas."}

=== CENÁRIOS FINANCEIROS ATIVOS ===
${scenarioText}`;

  // ============================================
  // TRANSAÇÕES INDIVIDUAIS RECENTES
  // Permite à IA responder sobre transações específicas por descrição
  // ============================================
  const recentTransactions = allTransactions
    .slice(-200) // Últimas 200 transações (já ordenadas por date ASC)
    .reverse();  // Mais recentes primeiro

  if (recentTransactions.length > 0) {
    const txLines = recentTransactions.map((t) => {
      const dateStr = `${String(t.date.getDate()).padStart(2, "0")}/${String(t.date.getMonth() + 1).padStart(2, "0")}/${t.date.getFullYear()}`;
      const tipo = t.tipo_transacao === "INCOME" ? "Receita" : "Despesa";
      const catName = t.category?.name || "Não classificado";
      const tipoCusto = t.tipo_custo ? ` | ${t.tipo_custo === "FIXO" ? "Custo Fixo" : "Custo Variável"}` : "";
      return `  - ${dateStr} | ${tipo} | ${catName} | "${t.description}" | R$ ${Number(t.amount).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${tipoCusto}`;
    }).join("\n");

    context += `\n\n=== TRANSAÇÕES INDIVIDUAIS (últimas ${recentTransactions.length} transações) ===
IMPORTANTE: Use estes dados para responder perguntas sobre transações específicas.
Quando o usuário perguntar sobre uma despesa específica (ex: "conta de energia", "aluguel", "internet"),
filtre por DESCRIÇÃO da transação (não apenas por categoria).
Uma mesma categoria pode conter transações de naturezas diferentes.
Por exemplo, a categoria "Energia e Água" pode incluir tanto "Conta de energia unidade matriz" quanto "Conta de internet corporativa" — são despesas distintas.
Sempre liste as transações individuais com data, descrição e valor quando o usuário pedir detalhes.

Formato: Data | Tipo | Categoria | Descrição | Valor | Classificação de Custo
${txLines}`;
  }

  if (extraContext) {
    context += `\n\n=== CONTEXTO ADICIONAL (dados da tela) ===\n${extraContext}`;
  }

  return context;
}

export default router;
