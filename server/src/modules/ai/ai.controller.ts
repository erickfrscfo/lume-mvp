import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../auth/auth.middleware.js";
import * as aiService from "./ai.service.js";
import { prisma } from "../../shared/database.js";
import { getDREProfile } from "../../shared/dre-profiles.js";

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

    // Nova arquitetura: contexto base leve + function calling
    const baseContext = await getBaseContext(companyId);
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { sector: true, activity: true },
    });

    const result = await aiService.chatWithTools(
      userId,
      message,
      companyId,
      baseContext,
      history,
      company ? { sector: company.sector, activity: company.activity } : undefined
    );
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
// HELPERS: Mesma lógica do financial.controller.ts
// para garantir consistência entre Dashboard e IA
// ============================================

/**
 * Obter data efetiva de caixa (regime de caixa)
 * Para EXPENSE: paymentDate (fallback: transaction.date)
 * Para INCOME: receiptDate (fallback: transaction.date)
 * 
 * IMPORTANTE: Deve ser idêntica à função no financial.controller.ts
 */
function getEffectiveDate(tx: any): Date {
  if (tx.tipo_transacao === "EXPENSE") {
    return tx.detail?.paymentDate || tx.date;
  } else {
    return tx.detail?.receiptDate || tx.date;
  }
}

function formatMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ============================================
// CONTEXTO BASE LEVE (para function calling)
// Só informações básicas da empresa + cenários ativos.
// Os dados financeiros são buscados via tools sob demanda.
// ============================================
async function getBaseContext(companyId: string): Promise<string> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });

  // Cenários ativos (são poucos, vale incluir no contexto base)
  const activeScenarios = await prisma.scenario.findMany({
    where: { companyId, isActive: true },
  });

  const scenarioText = activeScenarios.length > 0
    ? activeScenarios.map((s) => {
        const adj = s.adjustments as any;
        return `  - ${s.name} (${s.type}): ${adj?.monthlyRevenue ? `+R$ ${adj.monthlyRevenue}/mês receita` : ""} ${adj?.monthlyExpense ? `R$ ${adj.monthlyExpense}/mês despesa` : ""} ${adj?.startMonth ? `de ${adj.startMonth}` : ""} ${adj?.endMonth ? `até ${adj.endMonth}` : ""}`;
      }).join("\n")
    : "  Nenhum cenário ativo.";

  // Contar transações para dar contexto de volume
  const txCount = await prisma.transaction.count({ where: { companyId } });
  const pendingCount = await prisma.transaction.count({
    where: { companyId, status: { in: ["PENDING", "OVERDUE"] } },
  });

  return `EMPRESA: ${company?.name || "Não informado"}
CNPJ: ${company?.cnpj || "Não informado"}
SETOR: ${company?.sector || "Não informado"}
ATIVIDADE: ${company?.activity || "Não informada"}
TOTAL DE TRANSAÇÕES: ${txCount}
TRANSAÇÕES PENDENTES: ${pendingCount}

CENÁRIOS FINANCEIROS ATIVOS:
${scenarioText}

NOTA: Use as tools disponíveis para buscar dados financeiros detalhados. Não invente números.`;
}

// ============================================
// CONTEXTO FINANCEIRO ENRIQUECIDO (LEGADO)
// Mantido para uso pelo /explain e /scenario-chat
// 
// CORREÇÃO CRÍTICA (v2):
// - Agora usa APENAS transações COMPLETED (igual ao Dashboard)
// - Agrupa por DATA EFETIVA (paymentDate/receiptDate), não por date
// - Inclui saldo acumulado mês a mês
// - Garante consistência com os dados exibidos na tela
// ============================================
async function getEnrichedFinancialContext(companyId: string, extraContext?: string): Promise<string> {
  const now = new Date();

  const company = await prisma.company.findUnique({ where: { id: companyId } });

  // ============================================
  // CORREÇÃO 1: Buscar APENAS transações COMPLETED
  // Antes: buscava TODAS (incluindo PENDING/OVERDUE)
  // Agora: filtra por status COMPLETED, igual ao financial.controller.ts
  // ============================================
  const allTransactions = await prisma.transaction.findMany({
    where: { companyId, status: "COMPLETED" },
    include: { category: true, detail: true },
    orderBy: { date: "asc" },
  });

  const activeScenarios = await prisma.scenario.findMany({
    where: { companyId, isActive: true },
  });

  if (allTransactions.length === 0) {
    return "Nenhuma transação financeira registrada ainda.";
  }

  // ============================================
  // CORREÇÃO 2: Agrupar por DATA EFETIVA (regime de caixa)
  // Antes: usava t.date (data de emissão)
  // Agora: usa getEffectiveDate() (paymentDate/receiptDate), igual ao Dashboard
  // ============================================
  // CORREÇÃO 3: Buscar dreProfile para calcular margens corretamente
  // Margem Bruta = (Receita - Custos Diretos) / Receita
  // Margem Líquida = (Receita - Custos Diretos - Opex) / Receita
  // ============================================
  const dreProfile = getDREProfile(company?.sector || "MISTO");
  const directCostCodes = dreProfile.directCostCodes || ["3."];
  const excludeFromDirectCost = dreProfile.excludeFromDirectCost || [];

  // Helper: verifica se um código de categoria é custo direto (mesma lógica do frontend)
  const isDirectCost = (code: string): boolean => {
    const isDirect = directCostCodes.some((prefix: string) => code.startsWith(prefix));
    const isExcluded = excludeFromDirectCost.some((prefix: string) => code.startsWith(prefix));
    return isDirect && !isExcluded;
  };

  const monthlyData: Record<string, {
    income: number;
    expense: number;
    incomeByCategory: Record<string, number>;
    expenseByCategory: Record<string, number>;
    // DRE: agrupamento por código para calcular margens
    byCatCode: Record<string, number>;
  }> = {};

  allTransactions.forEach((t) => {
    // USAR DATA EFETIVA, não t.date
    const effectiveDate = getEffectiveDate(t);
    const mk = formatMonthKey(effectiveDate);

    if (!monthlyData[mk]) {
      monthlyData[mk] = { income: 0, expense: 0, incomeByCategory: {}, expenseByCategory: {}, byCatCode: {} };
    }
    const amt = Number(t.amount);
    const catName = t.category?.name || "Não classificado";

    // Determinar código de categoria com fallbacks (mesma lógica do DRE)
    let catCode = t.category?.code || "0.0";
    const catPrefix = catCode.split(".")[0];
    if (catCode === "0.0") {
      catCode = t.tipo_transacao === "INCOME" ? "2.5" : "5.0";
    } else if (t.tipo_transacao === "EXPENSE" && (catPrefix === "1" || catPrefix === "2")) {
      catCode = "5.0";
    } else if (t.tipo_transacao === "INCOME" && parseInt(catPrefix) >= 3) {
      catCode = "2.5";
    }

    // Agrupar por código de categoria (para DRE/margens)
    monthlyData[mk].byCatCode[catCode] = (monthlyData[mk].byCatCode[catCode] || 0) + amt;

    if (t.tipo_transacao === "INCOME") {
      monthlyData[mk].income += amt;
      monthlyData[mk].incomeByCategory[catName] = (monthlyData[mk].incomeByCategory[catName] || 0) + amt;
    } else {
      monthlyData[mk].expense += amt;
      monthlyData[mk].expenseByCategory[catName] = (monthlyData[mk].expenseByCategory[catName] || 0) + amt;
    }
  });

  // ============================================
  // Helper: Calcular margens DRE de um mês (mesma lógica do frontend)
  // ============================================
  // Helper: verifica se um código é imposto/tributo (deduzido da receita bruta)
  const taxCodes = dreProfile.taxCodes || ["8."];
  const isTaxCode = (code: string): boolean => {
    return taxCodes.some((prefix: string) => code.startsWith(prefix));
  };

  function calcDREMargins(monthData: { byCatCode: Record<string, number> }) {
    const codes = monthData.byCatCode;
    // Receita Bruta = códigos 1.x + 2.x
    const receita = Object.entries(codes)
      .filter(([k]) => k.startsWith("1.") || k.startsWith("2."))
      .reduce((sum, [, v]) => sum + v, 0);
    // Custos Diretos (CMV/CSP/CPV conforme setor)
    const cmv = Object.entries(codes)
      .filter(([k]) => isDirectCost(k))
      .reduce((sum, [, v]) => sum + v, 0);
    // Impostos e Tributos (8.x — deduzidos da receita bruta)
    const impostos = Object.entries(codes)
      .filter(([k]) => isTaxCode(k))
      .reduce((sum, [, v]) => sum + v, 0);
    // Despesas Operacionais = 3.x a 9.x que NÃO são custo direto E NÃO são impostos
    const opex = Object.entries(codes)
      .filter(([k]) => {
        const prefix = k.split(".")[0];
        if (!["3", "4", "5", "6", "7", "8", "9"].includes(prefix)) return false;
        return !isDirectCost(k) && !isTaxCode(k);
      })
      .reduce((sum, [, v]) => sum + v, 0);
    // NOVA ESTRUTURA DRE:
    // Receita Bruta - Custos Diretos - Impostos = Lucro Bruto
    // Lucro Bruto - Opex = Resultado Líquido
    const lucroBruto = receita - cmv - impostos;
    const lucroLiquido = receita - cmv - impostos - opex;
    return {
      receita,
      cmv,
      impostos,
      opex,
      lucroBruto,
      lucroLiquido,
      margemBruta: receita > 0 ? (lucroBruto / receita) * 100 : 0,
      margemLiquida: receita > 0 ? (lucroLiquido / receita) * 100 : 0,
    };
  }

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
  const currentMonth = monthlyData[currentMonthKey] || { income: 0, expense: 0, incomeByCategory: {}, expenseByCategory: {}, byCatCode: {} };
  const lastMonth = monthlyData[lastMonthKey] || { income: 0, expense: 0, incomeByCategory: {}, expenseByCategory: {}, byCatCode: {} };

  // Margens calculadas via DRE (mesma lógica do frontend)
  const currentDRE = calcDREMargins(currentMonth);
  const lastDRE = calcDREMargins(lastMonth);

  // Compat: manter variáveis usadas no contexto abaixo
  const currentGrossProfit = currentDRE.lucroBruto;
  const lastGrossProfit = lastDRE.lucroBruto;
  const grossProfitChange = lastGrossProfit !== 0 ? ((currentGrossProfit - lastGrossProfit) / Math.abs(lastGrossProfit) * 100) : 0;

  // Evolução mensal COM MARGEM DE LUCRO, CATEGORIAS DETALHADAS E SALDO ACUMULADO
  const monthKeys = Object.keys(monthlyData).sort();
  
  // Calcular saldo acumulado mês a mês
  let runningBalance = 0;
  const monthlyBalances: Record<string, number> = {};
  monthKeys.forEach((mk) => {
    const d = monthlyData[mk];
    runningBalance += d.income - d.expense;
    monthlyBalances[mk] = runningBalance;
  });

  const monthlyEvolution = monthKeys.map((mk) => {
    const d = monthlyData[mk];
    const net = d.income - d.expense;
    const dreMes = calcDREMargins(d);
    const margemBrutaMes = dreMes.margemBruta.toFixed(1);
    const margemLiquidaMes = dreMes.margemLiquida.toFixed(1);
    const accumulatedBalance = monthlyBalances[mk];

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
    detail += `\n    Saldo Acumulado: R$ ${accumulatedBalance.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    detail += `\n    Margem Bruta: ${margemBrutaMes}% (Receita DRE: R$ ${dreMes.receita.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} - ${dreProfile.directCostLabel}: R$ ${dreMes.cmv.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} - Impostos: R$ ${dreMes.impostos.toLocaleString("pt-BR", { minimumFractionDigits: 2 })})`;
    detail += `\n    Margem Líquida: ${margemLiquidaMes}% (Lucro Bruto - Opex: R$ ${dreMes.opex.toLocaleString("pt-BR", { minimumFractionDigits: 2 })})`;
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

  // ============================================
  // CONTEXTO: Informar a IA sobre o regime de caixa
  // ============================================
  let context = `=== DADOS DA EMPRESA ===
Nome: ${company?.name || "Não informado"}
CNPJ: ${company?.cnpj || "Não informado"}
Setor: ${company?.sector || "Não informado"}

=== REGIME DE CAIXA ===
IMPORTANTE: Todos os dados abaixo seguem o REGIME DE CAIXA.
- Receitas são contabilizadas na data de RECEBIMENTO (não na data de emissão)
- Despesas são contabilizadas na data de PAGAMENTO (não na data de emissão)
- Apenas transações EFETIVAMENTE PAGAS/RECEBIDAS estão incluídas
- Transações pendentes ou em atraso NÃO estão nos números abaixo

=== RESUMO FINANCEIRO (todos os ${monthCount} meses com dados) ===
- Total de Receitas: R$ ${totalIncome.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Total de Despesas: R$ ${totalExpense.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Saldo de Caixa (acumulado total): R$ ${balance.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
- ${dreProfile.directCostLabel} Atual: R$ ${currentDRE.cmv.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | Anterior: R$ ${lastDRE.cmv.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Impostos e Tributos Atual: R$ ${currentDRE.impostos.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | Anterior: R$ ${lastDRE.impostos.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Despesas Operacionais Atual: R$ ${currentDRE.opex.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | Anterior: R$ ${lastDRE.opex.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Margem Bruta Atual: ${currentDRE.margemBruta.toFixed(1)}% | Margem Bruta Anterior: ${lastDRE.margemBruta.toFixed(1)}%
- Margem Líquida Atual: ${currentDRE.margemLiquida.toFixed(1)}% | Margem Líquida Anterior: ${lastDRE.margemLiquida.toFixed(1)}%
- IMPORTANTE: Margem Bruta = (Receita Bruta - ${dreProfile.directCostLabel} - Impostos) / Receita. Margem Líquida = (Lucro Bruto - Opex) / Receita. NÃO confunda as duas.
- Saldo Acumulado Atual: R$ ${(monthlyBalances[currentMonthKey] || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | Saldo Acumulado Anterior: R$ ${(monthlyBalances[lastMonthKey] || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}

=== EVOLUÇÃO MENSAL DETALHADA (regime de caixa, com categorias e saldo acumulado) ===
IMPORTANTE: Os valores abaixo são POR MÊS, no regime de caixa (data de pagamento/recebimento).
Quando o usuário perguntar sobre um mês específico, use APENAS os dados daquele mês. NÃO some valores de meses diferentes.
O "Saldo Acumulado" é o saldo total desde o início (soma cumulativa de todos os meses até aquele mês).
Para comparar saldo entre dois meses, use o Saldo Acumulado de cada mês.
Exemplo: Se o saldo acumulado de fevereiro é R$ 62.000 e o de março é R$ 101.000, a variação é R$ 39.000 (63%).

${monthlyEvolution}

=== MAIORES VARIAÇÕES (${currentMonthKey} vs ${lastMonthKey}, >10%) ===
${biggestChanges || "  Sem variações significativas."}

=== CENÁRIOS FINANCEIROS ATIVOS ===
${scenarioText}`;

  // ============================================
  // TRANSAÇÕES INDIVIDUAIS RECENTES
  // Permite à IA responder sobre transações específicas por descrição
  // NOTA: Usa data efetiva para exibição
  // ============================================
  const recentTransactions = allTransactions
    .slice(-200) // Últimas 200 transações (já ordenadas por date ASC)
    .reverse();  // Mais recentes primeiro

  if (recentTransactions.length > 0) {
    const txLines = recentTransactions.map((t) => {
      // Usar data efetiva para exibição (consistente com Dashboard)
      const effectiveDate = getEffectiveDate(t);
      const dateStr = `${String(effectiveDate.getDate()).padStart(2, "0")}/${String(effectiveDate.getMonth() + 1).padStart(2, "0")}/${effectiveDate.getFullYear()}`;
      const tipo = t.tipo_transacao === "INCOME" ? "Receita" : "Despesa";
      const catName = t.category?.name || "Não classificado";
      const tipoCusto = t.tipo_custo ? ` | ${t.tipo_custo === "FIXO" ? "Custo Fixo" : "Custo Variável"}` : "";
      return `  - ${dateStr} | ${tipo} | ${catName} | "${t.description}" | R$ ${Number(t.amount).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${tipoCusto}`;
    }).join("\n");

    context += `\n\n=== TRANSAÇÕES INDIVIDUAIS (últimas ${recentTransactions.length} transações, regime de caixa) ===
IMPORTANTE: Use estes dados para responder perguntas sobre transações específicas.
As datas abaixo são DATAS EFETIVAS (pagamento/recebimento), não datas de emissão.
Quando o usuário perguntar sobre uma despesa específica (ex: "conta de energia", "aluguel", "internet"),
filtre por DESCRIÇÃO da transação (não apenas por categoria).
Uma mesma categoria pode conter transações de naturezas diferentes.
Por exemplo, a categoria "Energia e Água" pode incluir tanto "Conta de energia unidade matriz" quanto "Conta de internet corporativa" — são despesas distintas.
Sempre liste as transações individuais com data, descrição e valor quando o usuário pedir detalhes.

Formato: Data Efetiva | Tipo | Categoria | Descrição | Valor | Classificação de Custo
${txLines}`;
  }

  // ============================================
  // TRANSAÇÕES FUTURAS: PENDING e OVERDUE
  // Permite à IA responder sobre contas a pagar/receber,
  // vencimentos futuros, inadimplência, etc.
  // ============================================
  const pendingTransactions = await prisma.transaction.findMany({
    where: {
      companyId,
      status: { in: ["PENDING", "OVERDUE"] },
    },
    include: {
      category: { select: { name: true, code: true } },
      counterparty: { select: { name: true, type: true } },
      detail: { select: { dueDate: true, documentNumber: true } },
    },
    orderBy: { date: "asc" },
  });

  if (pendingTransactions.length > 0) {
    const now = new Date();
    const receivables = pendingTransactions.filter((t) => t.tipo_transacao === "INCOME");
    const payables = pendingTransactions.filter((t) => t.tipo_transacao === "EXPENSE");
    // Detectar atraso DINAMICAMENTE: dueDate < hoje (não depende do status OVERDUE)
    const isOverdue = (t: any): boolean => {
      const dueDate = t.detail?.dueDate ? new Date(t.detail.dueDate) : null;
      return dueDate !== null && dueDate < now;
    };
    const overdueReceivables = receivables.filter(isOverdue);
    const overduePayables = payables.filter(isOverdue);

    const totalReceivables = receivables.reduce((s, t) => s + Number(t.amount), 0);
    const totalPayables = payables.reduce((s, t) => s + Number(t.amount), 0);
    const totalOverdueReceivables = overdueReceivables.reduce((s, t) => s + Number(t.amount), 0);
    const totalOverduePayables = overduePayables.reduce((s, t) => s + Number(t.amount), 0);

    // Agrupar por mês de vencimento
    const pendingByMonth: Record<string, { receivables: number; payables: number; count: number }> = {};
    pendingTransactions.forEach((t) => {
      const dueDate = t.detail?.dueDate || t.date;
      const mk = formatMonthKey(new Date(dueDate));
      if (!pendingByMonth[mk]) pendingByMonth[mk] = { receivables: 0, payables: 0, count: 0 };
      if (t.tipo_transacao === "INCOME") {
        pendingByMonth[mk].receivables += Number(t.amount);
      } else {
        pendingByMonth[mk].payables += Number(t.amount);
      }
      pendingByMonth[mk].count++;
    });

    const monthlyPendingText = Object.entries(pendingByMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mk, d]) => {
        const net = d.receivables - d.payables;
        return `  ${mk}: A receber R$ ${d.receivables.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} | A pagar R$ ${d.payables.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} | Líquido R$ ${net.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} (${d.count} transações)`;
      }).join("\n");

    // Detalhamento das receitas a receber (top 30)
    const receivableLines = receivables
      .sort((a, b) => Number(b.amount) - Number(a.amount))
      .slice(0, 30)
      .map((t) => {
        const dueDate = t.detail?.dueDate || t.date;
        const dateStr = `${String(new Date(dueDate).getDate()).padStart(2, "0")}/${String(new Date(dueDate).getMonth() + 1).padStart(2, "0")}/${new Date(dueDate).getFullYear()}`;
        const statusLabel = isOverdue(t) ? " [EM ATRASO]" : "";
        const counterpartyName = t.counterparty?.name || "Não identificado";
        const catName = t.category?.name || "Sem categoria";
        return `  - ${dateStr} | ${catName} | "${t.description}" | R$ ${Number(t.amount).toLocaleString("pt-BR", { minimumFractionDigits: 2 })} | ${counterpartyName}${statusLabel}`;
      }).join("\n");

    // Detalhamento das despesas a pagar (top 30)
    const payableLines = payables
      .sort((a, b) => Number(b.amount) - Number(a.amount))
      .slice(0, 30)
      .map((t) => {
        const dueDate = t.detail?.dueDate || t.date;
        const dateStr = `${String(new Date(dueDate).getDate()).padStart(2, "0")}/${String(new Date(dueDate).getMonth() + 1).padStart(2, "0")}/${new Date(dueDate).getFullYear()}`;
        const statusLabel = isOverdue(t) ? " [EM ATRASO]" : "";
        const counterpartyName = t.counterparty?.name || "Não identificado";
        const catName = t.category?.name || "Sem categoria";
        return `  - ${dateStr} | ${catName} | "${t.description}" | R$ ${Number(t.amount).toLocaleString("pt-BR", { minimumFractionDigits: 2 })} | ${counterpartyName}${statusLabel}`;
      }).join("\n");

    context += `\n\n=== TRANSAÇÕES FUTURAS E PENDENTES ===
IMPORTANTE: Os dados abaixo são transações que AINDA NÃO FORAM PAGAS/RECEBIDAS.
São compromissos financeiros já registrados no sistema com vencimento futuro ou em atraso.
Use estes dados para responder perguntas sobre receitas previstas, contas a pagar, inadimplência e fluxo futuro.

RESUMO PENDENTE:
- Total a Receber: R$ ${totalReceivables.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} (${receivables.length} transações)
- Total a Pagar: R$ ${totalPayables.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} (${payables.length} transações)
- Saldo Líquido Pendente: R$ ${(totalReceivables - totalPayables).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;

    if (overdueReceivables.length > 0) {
      context += `\n- INADIMPLÊNCIA: ${overdueReceivables.length} receitas em atraso totalizando R$ ${totalOverdueReceivables.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
    }
    if (overduePayables.length > 0) {
      context += `\n- PAGAMENTOS EM ATRASO: ${overduePayables.length} despesas em atraso totalizando R$ ${totalOverduePayables.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
    }

    context += `\n\nPREVISÃO POR MÊS (baseada em transações já lançadas):\n${monthlyPendingText}`;

    if (receivableLines) {
      context += `\n\nRECEITAS PREVISTAS (a receber) — top ${Math.min(receivables.length, 30)}:\nFormato: Vencimento | Categoria | Descrição | Valor | Contraparte\n${receivableLines}`;
      if (receivables.length > 30) {
        context += `\n  ... e mais ${receivables.length - 30} receitas pendentes`;
      }
    }

    if (payableLines) {
      context += `\n\nDESPESAS PREVISTAS (a pagar) — top ${Math.min(payables.length, 30)}:\nFormato: Vencimento | Categoria | Descrição | Valor | Contraparte\n${payableLines}`;
      if (payables.length > 30) {
        context += `\n  ... e mais ${payables.length - 30} despesas pendentes`;
      }
    }
  }

  if (extraContext) {
    context += `\n\n=== CONTEXTO ADICIONAL (dados da tela do usuário) ===\n${extraContext}`;
  }

  return context;
}

export default router;
