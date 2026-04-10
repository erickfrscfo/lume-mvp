import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../auth/auth.middleware.js";
import { prisma } from "../../shared/database.js";
import { getDREProfile, isDirectCost, isTax, AVAILABLE_SECTORS } from "../../shared/dre-profiles.js";
import { generateAlerts } from "../alerts/alerts.controller.js";
import { z } from "zod";

const router = Router();

// ============================================
// HELPER: Parsear data sem problema de timezone
// Quando recebe "2025-11-03" (sem hora), adiciona T12:00:00 para
// evitar que new Date() interprete como UTC meia-noite e cause D-1
// ============================================
function parseLocalDate(dateStr: string | Date): Date {
  if (dateStr instanceof Date) return dateStr;
  if (!dateStr) return new Date();
  // Se já tem hora (T ou espaço), não mexe
  if (dateStr.includes('T') || dateStr.includes(' ')) return new Date(dateStr);
  // Se é formato DD/MM/AAAA, converte para Date local
  if (dateStr.includes('/')) {
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]), 12, 0, 0);
    }
  }
  // Formato YYYY-MM-DD: adiciona meio-dia para evitar D-1
  return new Date(dateStr + 'T12:00:00');
}

// ============================================
// HELPER: Obter data efetiva de caixa
// Para EXPENSE: paymentDate (fallback: transaction.date)
// Para INCOME: receiptDate (fallback: transaction.date)
// ============================================
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
// GET /api/financial/dashboard
// REGIME DE CAIXA: apenas transações COMPLETED, agrupadas por data efetiva
// Inclui dados de transações pendentes para indicador de UX
// ============================================
router.get("/dashboard", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const now = new Date();
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1);

    // ============================================
    // SALDO DE CAIXA: apenas transações COMPLETED (pagas/recebidas)
    // ============================================
    const completedTransactions = await prisma.transaction.findMany({
      where: { companyId, status: "COMPLETED" },
      include: { detail: true },
    });

    const totalIncome = completedTransactions
      .filter((t) => t.tipo_transacao === "INCOME")
      .reduce((s, t) => s + Number(t.amount), 0);
    const totalExpense = completedTransactions
      .filter((t) => t.tipo_transacao === "EXPENSE")
      .reduce((s, t) => s + Number(t.amount), 0);
    const cashBalance = totalIncome - totalExpense;

    // Filtrar últimos 6 meses usando data efetiva
    const recentTransactions = completedTransactions.filter((t) => {
      const effectiveDate = getEffectiveDate(t);
      return effectiveDate >= sixMonthsAgo;
    });

    // ============================================
    // BURN RATE: média mensal usando data efetiva de caixa
    // ============================================
    const monthlyData: Record<string, { income: number; expense: number }> = {};
    recentTransactions.forEach((t) => {
      const effectiveDate = getEffectiveDate(t);
      const monthKey = formatMonthKey(effectiveDate);
      if (!monthlyData[monthKey]) monthlyData[monthKey] = { income: 0, expense: 0 };
      if (t.tipo_transacao === "INCOME") {
        monthlyData[monthKey].income += Number(t.amount);
      } else {
        monthlyData[monthKey].expense += Number(t.amount);
      }
    });

    const monthKeys = Object.keys(monthlyData).sort();
    const numMonths = monthKeys.length;

    let avgNetBurn = 0;
    if (numMonths > 0) {
      const totalNetBurn = monthKeys.reduce((sum, mk) => {
        return sum + (monthlyData[mk].expense - monthlyData[mk].income);
      }, 0);
      avgNetBurn = totalNetBurn / numMonths;
    }

    const burnRate = avgNetBurn > 0 ? avgNetBurn : 0;

    // ============================================
    // RUNWAY
    // ============================================
    let runway: number;
    if (cashBalance <= 0) {
      runway = 0;
    } else if (burnRate <= 0) {
      runway = 99;
    } else {
      runway = cashBalance / burnRate;
      if (runway > 99) runway = 99;
    }

    // Variação do saldo
    const lastMonthKey = monthKeys.length > 0 ? monthKeys[monthKeys.length - 1] : null;
    let cashBalanceChange = 0;
    if (lastMonthKey && monthlyData[lastMonthKey]) {
      const lastMonthNet = monthlyData[lastMonthKey].income - monthlyData[lastMonthKey].expense;
      const previousBalance = cashBalance - lastMonthNet;
      if (previousBalance !== 0) {
        cashBalanceChange = ((cashBalance - previousBalance) / Math.abs(previousBalance)) * 100;
      }
    }

    // Crescimento de receita
    let growth = 0;
    if (monthKeys.length >= 2) {
      const lastMk = monthKeys[monthKeys.length - 1];
      const prevMk = monthKeys[monthKeys.length - 2];
      const lastInc = monthlyData[lastMk].income;
      const prevInc = monthlyData[prevMk].income;
      if (prevInc > 0) {
        growth = ((lastInc - prevInc) / prevInc) * 100;
      }
    }

    // ============================================
    // TRANSAÇÕES PENDENTES: indicador de UX
    // Mostra ao usuário quanto ainda não foi contabilizado no caixa
    // ============================================
    const pendingTransactions = await prisma.transaction.findMany({
      where: {
        companyId,
        status: { in: ["PENDING", "OVERDUE"] },
      },
      select: { amount: true, tipo_transacao: true, status: true },
    });

    const pendingExpenses = pendingTransactions
      .filter((t) => t.tipo_transacao === "EXPENSE")
      .reduce((s, t) => s + Number(t.amount), 0);
    const pendingIncomes = pendingTransactions
      .filter((t) => t.tipo_transacao === "INCOME")
      .reduce((s, t) => s + Number(t.amount), 0);
    const overdueCount = pendingTransactions.filter((t) => t.status === "OVERDUE").length;

    res.json({
      success: true,
      data: {
        cashBalance: { value: cashBalance, change: cashBalanceChange },
        burnRate: { value: burnRate, change: 0 },
        runway: { value: runway, change: 0 },
        growth: { value: growth, change: 0 },
        transactionCount: completedTransactions.length,
        // NOVO: dados de transações pendentes
        pending: {
          count: pendingTransactions.length,
          totalExpenses: pendingExpenses,
          totalIncomes: pendingIncomes,
          overdueCount,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET /api/financial/cashflow
// REGIME DE CAIXA: apenas COMPLETED, agrupado por data efetiva
// CORREÇÃO: Retorna initialBalance (saldo das transações anteriores ao período)
// para que o gráfico de saldo acumulado seja consistente com o card de Saldo de Caixa
// ============================================
router.get("/cashflow", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const months = parseInt(req.query.months as string) || 12;
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    const transactions = await prisma.transaction.findMany({
      where: { companyId, status: "COMPLETED" },
      include: { detail: true },
    });

    // CORREÇÃO: Calcular saldo das transações ANTERIORES ao período exibido
    // Antes, essas transações eram simplesmente descartadas com "return",
    // causando divergência entre o saldo do card (que soma tudo) e o gráfico (que partia de 0)
    let initialBalance = 0;
    const monthlyMap: Record<string, { income: number; expense: number }> = {};

    transactions.forEach((t) => {
      const effectiveDate = getEffectiveDate(t);
      const amount = Number(t.amount);

      if (effectiveDate < startDate) {
        // Transação anterior ao período → acumula no saldo inicial
        if (t.tipo_transacao === "INCOME") {
          initialBalance += amount;
        } else {
          initialBalance -= amount;
        }
        return;
      }

      // Transação dentro do período → agrupa por mês normalmente
      const monthKey = formatMonthKey(effectiveDate);
      if (!monthlyMap[monthKey]) monthlyMap[monthKey] = { income: 0, expense: 0 };
      if (t.tipo_transacao === "INCOME") {
        monthlyMap[monthKey].income += amount;
      } else {
        monthlyMap[monthKey].expense += amount;
      }
    });

    const result = Object.entries(monthlyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({
        month,
        income: data.income,
        expense: data.expense,
        net: data.income - data.expense,
      }));

    // CORREÇÃO: Retornar initialBalance junto com os dados mensais
    res.json({ success: true, data: result, initialBalance });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET /api/financial/dre
// REGIME DE CAIXA: apenas COMPLETED, agrupado por data efetiva
// ============================================
router.get("/dre", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const months = parseInt(req.query.months as string) || 7;
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    // Buscar o setor da empresa para determinar o perfil de DRE
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { sector: true },
    });

    const profile = getDREProfile(company?.sector || "MISTO");

    const transactions = await prisma.transaction.findMany({
      where: { companyId, status: "COMPLETED" },
      include: { category: true, detail: true },
    });

    // Agrupar por mês (data efetiva) e categoria
    // CORREÇÃO: Fallback inteligente para transações sem categoria ou com categoria inconsistente
    const dreData: Record<string, Record<string, number>> = {};
    transactions.forEach((t) => {
      const effectiveDate = getEffectiveDate(t);
      if (effectiveDate < startDate) return; // Fora do período

      const monthKey = formatMonthKey(effectiveDate);
      let catCode = t.category?.code || "0.0";
      const catPrefix = catCode.split(".")[0];

      // FALLBACK 1: Transação sem categoria → usar tipo_transacao como fallback
      if (catCode === "0.0") {
        if (t.tipo_transacao === "INCOME") {
          catCode = "2.5"; // Outras Receitas
        } else {
          catCode = "5.0"; // Despesas Operacionais (genérico)
        }
      }

      // FALLBACK 2: Despesa com categoria de receita (1.x ou 2.x) → reclassificar
      if (t.tipo_transacao === "EXPENSE" && (catPrefix === "1" || catPrefix === "2")) {
        catCode = "5.0"; // Despesas Operacionais (genérico)
        console.warn(`[DRE] Inconsistência: despesa "${t.description}" (${t.id}) tem categoria de receita ${t.category?.code}. Usando fallback 5.0.`);
      }

      // FALLBACK 3: Receita com categoria de despesa (3.x a 8.x) → reclassificar
      if (t.tipo_transacao === "INCOME" && parseInt(catPrefix) >= 3) {
        catCode = "2.5"; // Outras Receitas
        console.warn(`[DRE] Inconsistência: receita "${t.description}" (${t.id}) tem categoria de despesa ${t.category?.code}. Usando fallback 2.5.`);
      }

      if (!dreData[monthKey]) dreData[monthKey] = {};
      dreData[monthKey][catCode] = (dreData[monthKey][catCode] || 0) + Number(t.amount);
    });

    res.json({
      success: true,
      data: dreData,
      profile: {
        sectorKey: profile.sectorKey,
        sectorLabel: profile.sectorLabel,
        directCostLabel: profile.directCostLabel,
        grossProfitLabel: profile.grossProfitLabel,
        directCostCodes: profile.directCostCodes,
        excludeFromDirectCost: profile.excludeFromDirectCost,
        taxCodes: profile.taxCodes,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/financial/sectors — Lista de setores disponíveis
router.get("/sectors", authMiddleware, async (_req: Request, res: Response) => {
  res.json({ success: true, data: AVAILABLE_SECTORS });
});

// ============================================
// GET /api/financial/transactions
// Adicionados filtros: status, dueDateStart, dueDateEnd
// ============================================
router.get("/transactions", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const type = req.query.type as string;
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const costType = req.query.costType as string;
    const status = req.query.status as string;
    const dueDateStart = req.query.dueDateStart as string;
    const dueDateEnd = req.query.dueDateEnd as string;

    const where: any = { companyId };
    if (type === "INCOME" || type === "EXPENSE") where.tipo_transacao = type;

    // Filtro por tipo de custo
    if (costType === "FIXO" || costType === "VARIAVEL") {
      where.tipo_custo = costType;
    } else if (costType === "PENDING") {
      where.tipo_custo = null;
      where.tipo_transacao = "EXPENSE";
    }

    // NOVO: Filtro por status
    // CORREÇÃO: Para "OVERDUE", não basta filtrar por status no banco,
    // pois muitas transações vencidas ainda têm status="PENDING" (nunca foram atualizadas).
    // A detecção de vencimento é feita dinamicamente: dueDate < agora E sem pagamento/recebimento.
    if (status === "COMPLETED" || status === "PENDING") {
      where.status = status;
    } else if (status === "OVERDUE") {
      // Buscar transações PENDING ou OVERDUE que têm dueDate no passado e não foram pagas/recebidas
      where.status = { in: ["PENDING", "OVERDUE"] };
      where.detail = {
        ...where.detail,
        dueDate: {
          ...(where.detail?.dueDate || {}),
          lt: new Date(), // dueDate antes de agora = vencida
        },
        paymentDate: null,
        receiptDate: null,
      };
    }

    // Filtro de data de emissão/criação
    // CORREÇÃO TIMEZONE: Usar T00:00:00.000Z (meia-noite UTC) em vez de T03:00:00.000Z.
    // As datas no banco são armazenadas como UTC meia-noite (ex: 2026-04-01T00:00:00.000Z).
    // Com T03:00:00.000Z, o filtro gte para "2026-04-01" virava 01/04 03:00 UTC,
    // excluindo transações de 01/04 00:00 UTC (5 transações sumiam de abril).
    if (startDate || endDate) {
      where.date = {};
      if (startDate) {
        where.date.gte = new Date(startDate + "T00:00:00.000Z");
      }
      if (endDate) {
        const endDateObj = new Date(endDate + "T00:00:00.000Z");
        endDateObj.setDate(endDateObj.getDate() + 1);
        endDateObj.setMilliseconds(endDateObj.getMilliseconds() - 1);
        where.date.lte = endDateObj;
      }
    }

    // NOVO: Filtro por data de vencimento (via TransactionDetail)
    // CORREÇÃO TIMEZONE: Mesma lógica — usar T00:00:00.000Z para consistência com datas UTC.
    // CORREÇÃO: Usar spread para não sobrescrever where.detail já definido pelo filtro OVERDUE.
    if (dueDateStart || dueDateEnd) {
      if (!where.detail) where.detail = {};
      const existingDueDate = where.detail.dueDate || {};
      if (dueDateStart) {
        where.detail.dueDate = { ...existingDueDate, gte: new Date(dueDateStart + "T00:00:00.000Z") };
      }
      if (dueDateEnd) {
        const dueDateEndObj = new Date(dueDateEnd + "T00:00:00.000Z");
        dueDateEndObj.setDate(dueDateEndObj.getDate() + 1);
        dueDateEndObj.setMilliseconds(dueDateEndObj.getMilliseconds() - 1);
        where.detail.dueDate = { ...(where.detail.dueDate || {}), lte: dueDateEndObj };
      }
    }

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: {
          category: true,
          counterparty: { select: { id: true, name: true, document: true, type: true } },
          detail: true,
        },
        orderBy: { date: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.transaction.count({ where }),
    ]);

    res.json({
      success: true,
      data: transactions.map((t) => ({
        id: t.id,
        date: t.date,
        description: t.description,
        amount: Number(t.amount),
        tipo_transacao: t.tipo_transacao,
        tipo_custo: t.tipo_custo,
        costConfidence: t.costConfidence ? Number(t.costConfidence) : null,
        status: t.status,
        source: t.source,
        category: t.category ? { id: t.category.id, code: t.category.code, name: t.category.name } : null,
        counterparty: t.counterparty ? {
          id: t.counterparty.id,
          name: t.counterparty.name,
          document: t.counterparty.document,
          type: t.counterparty.type,
        } : null,
        detail: t.detail ? {
          dueDate: t.detail.dueDate,
          paymentDate: t.detail.paymentDate,
          receiptDate: t.detail.receiptDate,
          amountOriginal: t.detail.amountOriginal ? Number(t.detail.amountOriginal) : null,
          amountPaid: t.detail.amountPaid ? Number(t.detail.amountPaid) : null,
          amountReceived: t.detail.amountReceived ? Number(t.detail.amountReceived) : null,
          discount: t.detail.discount ? Number(t.detail.discount) : null,
          interest: t.detail.interest ? Number(t.detail.interest) : null,
          documentNumber: t.detail.documentNumber,
          bankReference: t.detail.bankReference,
          reconciliationStatus: t.detail.reconciliationStatus,
          notes: t.detail.notes,
        } : null,
        aiClassified: t.aiClassified,
        confidence: t.confidence ? Number(t.confidence) : null,
        notes: t.notes,
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/financial/transactions
router.post("/transactions", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { date, description, amount, type, notes, counterpartyId, dueDate, paymentDate, receiptDate, documentNumber } = req.body;

    if (!date || !description || !amount || !type) {
      return res.status(400).json({ success: false, error: "Campos obrigatórios: date, description, amount, type" });
    }

    const tipo_transacao = (type === "INCOME" || type === "ENTRADA") ? "INCOME" : "EXPENSE";

    // Status derivado de paymentDate/receiptDate
    let status = "PENDING";
    if (tipo_transacao === "EXPENSE" && paymentDate) {
      status = "COMPLETED";
    } else if (tipo_transacao === "INCOME" && receiptDate) {
      status = "COMPLETED";
    }

    const transaction = await prisma.transaction.create({
      data: {
        companyId,
        date: parseLocalDate(date),
        description,
        amount: Math.abs(parseFloat(amount)),
        tipo_transacao,
        status: status as any,
        source: "MANUAL",
        counterpartyId: counterpartyId || null,
        notes: notes || "",
      },
    });

    // Criar TransactionDetail para armazenar datas financeiras
    await prisma.transactionDetail.create({
      data: {
        transactionId: transaction.id,
        counterpartyId: counterpartyId || null,
        dueDate: dueDate ? parseLocalDate(dueDate) : null,
        paymentDate: paymentDate ? parseLocalDate(paymentDate) : null,
        receiptDate: receiptDate ? parseLocalDate(receiptDate) : null,
        documentNumber: documentNumber || null,
        amountOriginal: Math.abs(parseFloat(amount)),
      },
    });

    // Regenerar alertas em background
    const userId = (req as any).userId;
    if (userId) {
      generateAlerts(companyId, userId).catch(err => console.error('[Financial] Erro ao gerar alertas após criação:', err));
    }

    res.json({ success: true, data: transaction });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/financial/transactions/:id
router.delete("/transactions/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;

    const transaction = await prisma.transaction.findFirst({
      where: { id, companyId },
    });

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transação não encontrada" });
    }

    await prisma.transaction.delete({ where: { id } });
    res.json({ success: true, message: "Transação excluída" });
  } catch (error) {
    next(error);
  }
});

// ============================================
// PATCH /api/financial/transactions/:id — Editar transação e detalhes
// ============================================
router.patch("/transactions/:id", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;

    const transaction = await prisma.transaction.findFirst({
      where: { id, companyId },
    });

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transação não encontrada" });
    }

    const {
      date, description, amount, notes, counterpartyId, categoryId,
      dueDate, paymentDate, receiptDate,
      amountPaid, amountReceived, discount, interest,
      documentNumber, bankReference, reconciliationNotes,
    } = req.body;

    // Atualizar campos da transação principal
    const txUpdateData: any = {};
    if (date !== undefined) txUpdateData.date = parseLocalDate(date);
    if (description !== undefined) txUpdateData.description = description;
    if (amount !== undefined) txUpdateData.amount = Math.abs(parseFloat(amount));
    if (notes !== undefined) txUpdateData.notes = notes;
    if (counterpartyId !== undefined) txUpdateData.counterpartyId = counterpartyId || null;
    if (categoryId !== undefined) txUpdateData.categoryId = categoryId || null;

    // Status derivado: se paymentDate/receiptDate preenchido = COMPLETED, senão = PENDING
    if (paymentDate !== undefined || receiptDate !== undefined) {
      const tipo = transaction.tipo_transacao;
      const existingDetail = await prisma.transactionDetail.findUnique({
        where: { transactionId: id },
      });

      const effectivePaymentDate = paymentDate !== undefined ? paymentDate : existingDetail?.paymentDate;
      const effectiveReceiptDate = receiptDate !== undefined ? receiptDate : existingDetail?.receiptDate;

      if ((tipo === "EXPENSE" && effectivePaymentDate) || (tipo === "INCOME" && effectiveReceiptDate)) {
        txUpdateData.status = "COMPLETED";
      } else {
        const effectiveDueDate = dueDate !== undefined ? dueDate : existingDetail?.dueDate;
        if (effectiveDueDate && new Date(effectiveDueDate) < new Date()) {
          txUpdateData.status = "OVERDUE";
        } else {
          txUpdateData.status = "PENDING";
        }
      }
    }

    if (Object.keys(txUpdateData).length > 0) {
      await prisma.transaction.update({
        where: { id },
        data: txUpdateData,
      });
    }

    // Atualizar ou criar detail
    const hasDetailFields = dueDate !== undefined || paymentDate !== undefined || receiptDate !== undefined ||
      amountPaid !== undefined || amountReceived !== undefined || discount !== undefined ||
      interest !== undefined || documentNumber !== undefined || bankReference !== undefined ||
      reconciliationNotes !== undefined;

    if (hasDetailFields) {
      const detailData: any = {};
      if (dueDate !== undefined) detailData.dueDate = dueDate ? parseLocalDate(dueDate) : null;
      if (paymentDate !== undefined) detailData.paymentDate = paymentDate ? parseLocalDate(paymentDate) : null;
      if (receiptDate !== undefined) detailData.receiptDate = receiptDate ? parseLocalDate(receiptDate) : null;
      if (amountPaid !== undefined) detailData.amountPaid = amountPaid ? parseFloat(amountPaid) : null;
      if (amountReceived !== undefined) detailData.amountReceived = amountReceived ? parseFloat(amountReceived) : null;
      if (discount !== undefined) detailData.discount = discount ? parseFloat(discount) : null;
      if (interest !== undefined) detailData.interest = interest ? parseFloat(interest) : null;
      if (documentNumber !== undefined) detailData.documentNumber = documentNumber || null;
      if (bankReference !== undefined) detailData.bankReference = bankReference || null;
      if (reconciliationNotes !== undefined) detailData.notes = reconciliationNotes || null;

      // NÃO setar reconciliationStatus aqui — conciliação é feita apenas
      // via match com extrato bancário (POST /api/reconciliations/batch)

      await prisma.transactionDetail.upsert({
        where: { transactionId: id },
        create: {
          transactionId: id,
          amountOriginal: transaction.amount,
          ...detailData,
        },
        update: detailData,
      });
    }

    const updated = await prisma.transaction.findUnique({
      where: { id },
      include: {
        category: true,
        counterparty: { select: { id: true, name: true, document: true, type: true } },
        detail: true,
      },
    });

    const patchUserId = (req as any).userId;
    if (patchUserId) {
      generateAlerts(companyId, patchUserId).catch(err => console.error('[Financial] Erro ao gerar alertas após edição:', err));
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET /api/financial/cost-breakdown
// REGIME DE CAIXA: apenas COMPLETED, agrupado por paymentDate
// ============================================
router.get("/cost-breakdown", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const months = parseInt(req.query.months as string) || 6;
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    const expenses = await prisma.transaction.findMany({
      where: {
        companyId,
        tipo_transacao: "EXPENSE",
        status: "COMPLETED",
      },
      include: { detail: true },
    });

    // Agrupar por mês (data efetiva de pagamento) e tipo de custo
    const monthlyBreakdown: Record<string, {
      fixo: number;
      variavel: number;
      pendente: number;
    }> = {};

    expenses.forEach((e) => {
      const effectiveDate = e.detail?.paymentDate || e.date;
      if (effectiveDate < startDate) return; // Fora do período

      const monthKey = formatMonthKey(effectiveDate);
      if (!monthlyBreakdown[monthKey]) {
        monthlyBreakdown[monthKey] = { fixo: 0, variavel: 0, pendente: 0 };
      }

      const amount = Number(e.amount);
      if (e.tipo_custo === "FIXO") {
        monthlyBreakdown[monthKey].fixo += amount;
      } else if (e.tipo_custo === "VARIAVEL") {
        monthlyBreakdown[monthKey].variavel += amount;
      } else {
        monthlyBreakdown[monthKey].pendente += amount;
      }
    });

    const result = Object.entries(monthlyBreakdown)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({
        month,
        fixo: data.fixo,
        variavel: data.variavel,
        pendente: data.pendente,
        total: data.fixo + data.variavel + data.pendente,
      }));

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET /api/financial/pending-details
// Retorna transações PENDING e OVERDUE com detalhes para contexto da IA
// Permite que a Reunião Executiva responda sobre transações futuras
// ============================================
router.get("/pending-details", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;

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

    // Separar por tipo e formatar
    const receivables = pendingTransactions
      .filter((t) => t.tipo_transacao === "INCOME")
      .map((t) => ({
        id: t.id,
        description: t.description,
        amount: Number(t.amount),
        date: t.date,
        dueDate: t.detail?.dueDate || t.date,
        status: t.status,
        counterparty: t.counterparty?.name || "Não identificado",
        category: t.category?.name || "Sem categoria",
        documentNumber: t.detail?.documentNumber || null,
      }));

    const payables = pendingTransactions
      .filter((t) => t.tipo_transacao === "EXPENSE")
      .map((t) => ({
        id: t.id,
        description: t.description,
        amount: Number(t.amount),
        date: t.date,
        dueDate: t.detail?.dueDate || t.date,
        status: t.status,
        counterparty: t.counterparty?.name || "Não identificado",
        category: t.category?.name || "Sem categoria",
        documentNumber: t.detail?.documentNumber || null,
      }));

    // Agrupar por mês de vencimento
    const byMonth: Record<string, { receivables: number; payables: number; net: number; count: number }> = {};

    receivables.forEach((t) => {
      const monthKey = formatMonthKey(new Date(t.dueDate));
      if (!byMonth[monthKey]) byMonth[monthKey] = { receivables: 0, payables: 0, net: 0, count: 0 };
      byMonth[monthKey].receivables += t.amount;
      byMonth[monthKey].net += t.amount;
      byMonth[monthKey].count++;
    });

    payables.forEach((t) => {
      const monthKey = formatMonthKey(new Date(t.dueDate));
      if (!byMonth[monthKey]) byMonth[monthKey] = { receivables: 0, payables: 0, net: 0, count: 0 };
      byMonth[monthKey].payables += t.amount;
      byMonth[monthKey].net -= t.amount;
      byMonth[monthKey].count++;
    });

    const monthlyForecast = Object.entries(byMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({ month, ...data }));

    // Totais
    const totalReceivables = receivables.reduce((s, t) => s + t.amount, 0);
    const totalPayables = payables.reduce((s, t) => s + t.amount, 0);
    const overdueReceivables = receivables.filter((t) => t.status === "OVERDUE");
    const overduePayables = payables.filter((t) => t.status === "OVERDUE");

    res.json({
      success: true,
      data: {
        receivables,
        payables,
        monthlyForecast,
        totals: {
          totalReceivables,
          totalPayables,
          netPending: totalReceivables - totalPayables,
          overdueReceivablesCount: overdueReceivables.length,
          overdueReceivablesAmount: overdueReceivables.reduce((s, t) => s + t.amount, 0),
          overduePayablesCount: overduePayables.length,
          overduePayablesAmount: overduePayables.reduce((s, t) => s + t.amount, 0),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
