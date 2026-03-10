import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../auth/auth.middleware.js";
import { prisma } from "../../shared/database.js";
import { getDREProfile, AVAILABLE_SECTORS } from "../../shared/dre-profiles.js";
import { generateAlerts } from "../alerts/alerts.controller.js";
import { z } from "zod";

const router = Router();

// GET /api/financial/dashboard
router.get("/dashboard", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1);

    // ============================================
    // SALDO DE CAIXA: usar TODAS as transações (sem filtro de data)
    // para refletir o saldo real acumulado da empresa
    // ============================================
    const allTransactions = await prisma.transaction.findMany({
      where: { companyId },
    });

    const totalIncome = allTransactions.filter((t) => t.tipo_transacao === "INCOME").reduce((s, t) => s + Number(t.amount), 0);
    const totalExpense = allTransactions.filter((t) => t.tipo_transacao === "EXPENSE").reduce((s, t) => s + Number(t.amount), 0);
    const cashBalance = totalIncome - totalExpense;

    // Transações dos últimos 6 meses (para burn rate e variação mensal)
    const transactions = allTransactions.filter((t) => t.date >= sixMonthsAgo);

    // ============================================
    // BURN RATE CORRIGIDO
    // Calcula a média mensal de (Despesas - Receitas) usando TODOS os meses com dados,
    // não apenas o mês atual. Isso garante que funciona mesmo quando o mês atual
    // ainda não tem transações.
    // ============================================

    // Agrupar transações por mês
    const monthlyData: Record<string, { income: number; expense: number }> = {};
    transactions.forEach((t) => {
      const monthKey = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyData[monthKey]) monthlyData[monthKey] = { income: 0, expense: 0 };
      if (t.tipo_transacao === "INCOME") {
        monthlyData[monthKey].income += Number(t.amount);
      } else {
        monthlyData[monthKey].expense += Number(t.amount);
      }
    });

    const monthKeys = Object.keys(monthlyData).sort();
    const numMonths = monthKeys.length;

    // Net Burn Rate = média mensal de (despesas - receitas)
    // Se positivo → empresa queima caixa
    // Se zero ou negativo → empresa gera caixa
    let avgNetBurn = 0;
    if (numMonths > 0) {
      const totalNetBurn = monthKeys.reduce((sum, mk) => {
        return sum + (monthlyData[mk].expense - monthlyData[mk].income);
      }, 0);
      avgNetBurn = totalNetBurn / numMonths;
    }

    const burnRate = avgNetBurn > 0 ? avgNetBurn : 0;

    // ============================================
    // RUNWAY CORRIGIDO
    // Runway = Saldo Total em Caixa / Net Burn Rate Mensal
    // Se saldo <= 0 → runway = 0 (sem caixa)
    // Se burn rate <= 0 → runway = 99 (empresa lucrativa, "infinito")
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

    // Variação do saldo: comparar saldo total com saldo sem o último mês
    const lastMonthKey = monthKeys.length > 0 ? monthKeys[monthKeys.length - 1] : null;
    let cashBalanceChange = 0;
    if (lastMonthKey && monthlyData[lastMonthKey]) {
      const lastMonthNet = monthlyData[lastMonthKey].income - monthlyData[lastMonthKey].expense;
      const previousBalance = cashBalance - lastMonthNet;
      if (previousBalance !== 0) {
        cashBalanceChange = ((cashBalance - previousBalance) / Math.abs(previousBalance)) * 100;
      }
    }

    // Crescimento de receita (último mês com dados vs penúltimo)
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

    res.json({
      success: true,
      data: {
        cashBalance: { value: cashBalance, change: cashBalanceChange },
        burnRate: { value: burnRate, change: 0 },
        runway: { value: runway, change: 0 },
        growth: { value: growth, change: 0 },
        transactionCount: transactions.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/financial/cashflow
router.get("/cashflow", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const months = parseInt(req.query.months as string) || 12;
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    const transactions = await prisma.transaction.findMany({
      where: { companyId, date: { gte: startDate } },
      orderBy: { date: "asc" },
    });

    // Agrupar por mês
    const monthlyMap: Record<string, { income: number; expense: number }> = {};
    transactions.forEach((t) => {
      const monthKey = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyMap[monthKey]) monthlyMap[monthKey] = { income: 0, expense: 0 };
      if (t.tipo_transacao === "INCOME") {
        monthlyMap[monthKey].income += Number(t.amount);
      } else {
        monthlyMap[monthKey].expense += Number(t.amount);
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

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// GET /api/financial/dre
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
      where: { companyId, date: { gte: startDate } },
      include: { category: true },
      orderBy: { date: "asc" },
    });

    // Agrupar por mês e categoria
    const dreData: Record<string, Record<string, number>> = {};
    transactions.forEach((t) => {
      const monthKey = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`;
      const catCode = t.category?.code || "0.0";
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

// GET /api/financial/transactions
router.get("/transactions", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = (req as any).companyId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const type = req.query.type as string;
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const costType = req.query.costType as string; // NOVO: filtro por tipo de custo

    const where: any = { companyId };
    if (type === "INCOME" || type === "EXPENSE") where.tipo_transacao = type;

    // NOVO: Filtro por tipo de custo
    if (costType === "FIXO" || costType === "VARIAVEL") {
      where.tipo_custo = costType;
    } else if (costType === "PENDING") {
      where.tipo_custo = null;
      where.tipo_transacao = "EXPENSE"; // Apenas despesas podem ter tipo de custo pendente
    }

    // Filtro de data (usar horário local, não UTC, para evitar problemas de fuso)
    if (startDate || endDate) {
      where.date = {};
      if (startDate) {
        // Início do dia no fuso GMT-3 = 03:00 UTC
        where.date.gte = new Date(startDate + "T03:00:00.000Z");
      }
      if (endDate) {
        // Fim do dia no fuso GMT-3 = próximo dia 02:59:59 UTC
        where.date.lte = new Date(endDate + "T02:59:59.999Z");
        // Adicionar 1 dia para cobrir o dia inteiro
        const endDateObj = new Date(endDate + "T03:00:00.000Z");
        endDateObj.setDate(endDateObj.getDate() + 1);
        endDateObj.setMilliseconds(endDateObj.getMilliseconds() - 1);
        where.date.lte = endDateObj;
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
        category: t.category ? { code: t.category.code, name: t.category.name } : null,
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
        date: new Date(date),
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
        dueDate: dueDate ? new Date(dueDate) : null,
        paymentDate: paymentDate ? new Date(paymentDate) : null,
        receiptDate: receiptDate ? new Date(receiptDate) : null,
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
      date, description, amount, notes, counterpartyId,
      // Campos do detail
      dueDate, paymentDate, receiptDate,
      amountPaid, amountReceived, discount, interest,
      documentNumber, bankReference, reconciliationNotes,
    } = req.body;

    // Atualizar campos da transação principal
    const txUpdateData: any = {};
    if (date !== undefined) txUpdateData.date = new Date(date);
    if (description !== undefined) txUpdateData.description = description;
    if (amount !== undefined) txUpdateData.amount = Math.abs(parseFloat(amount));
    if (notes !== undefined) txUpdateData.notes = notes;
    if (counterpartyId !== undefined) txUpdateData.counterpartyId = counterpartyId || null;

    // Status derivado: se paymentDate/receiptDate preenchido = COMPLETED, senão = PENDING
    if (paymentDate !== undefined || receiptDate !== undefined) {
      const tipo = transaction.tipo_transacao;
      const hasPaid = paymentDate !== undefined ? !!paymentDate : false;
      const hasReceived = receiptDate !== undefined ? !!receiptDate : false;

      if ((tipo === "EXPENSE" && hasPaid) || (tipo === "INCOME" && hasReceived)) {
        txUpdateData.status = "COMPLETED";
      } else {
        // Se removeu a data de pagamento/recebimento, volta para PENDING
        txUpdateData.status = "PENDING";
      }
    }

    if (Object.keys(txUpdateData).length > 0) {
      await prisma.transaction.update({
        where: { id },
        data: txUpdateData,
      });
    }

    // Atualizar ou criar detail se algum campo de detail foi enviado
    const hasDetailFields = dueDate !== undefined || paymentDate !== undefined || receiptDate !== undefined ||
      amountPaid !== undefined || amountReceived !== undefined || discount !== undefined ||
      interest !== undefined || documentNumber !== undefined || bankReference !== undefined ||
      reconciliationNotes !== undefined;

    if (hasDetailFields) {
      const detailData: any = {};
      if (dueDate !== undefined) detailData.dueDate = dueDate ? new Date(dueDate) : null;
      if (paymentDate !== undefined) detailData.paymentDate = paymentDate ? new Date(paymentDate) : null;
      if (receiptDate !== undefined) detailData.receiptDate = receiptDate ? new Date(receiptDate) : null;
      if (amountPaid !== undefined) detailData.amountPaid = amountPaid ? parseFloat(amountPaid) : null;
      if (amountReceived !== undefined) detailData.amountReceived = amountReceived ? parseFloat(amountReceived) : null;
      if (discount !== undefined) detailData.discount = discount ? parseFloat(discount) : null;
      if (interest !== undefined) detailData.interest = interest ? parseFloat(interest) : null;
      if (documentNumber !== undefined) detailData.documentNumber = documentNumber || null;
      if (bankReference !== undefined) detailData.bankReference = bankReference || null;
      if (reconciliationNotes !== undefined) detailData.notes = reconciliationNotes || null;

      // Atualizar reconciliationStatus
      if (paymentDate || receiptDate) {
        detailData.reconciliationStatus = "RECONCILED";
      }

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

    // Retornar transação atualizada com todos os includes
    const updated = await prisma.transaction.findUnique({
      where: { id },
      include: {
        category: true,
        counterparty: { select: { id: true, name: true, document: true, type: true } },
        detail: true,
      },
    });

    // Regenerar alertas em background
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
// NOVO ENDPOINT: GET /api/financial/cost-breakdown
// Retorna breakdown de custos fixos vs variáveis
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
        date: { gte: startDate },
      },
      select: {
        amount: true,
        tipo_custo: true,
        date: true,
      },
    });

    // Agrupar por mês e tipo de custo
    const monthlyBreakdown: Record<string, {
      fixo: number;
      variavel: number;
      pendente: number;
    }> = {};

    expenses.forEach((e) => {
      const monthKey = `${e.date.getFullYear()}-${String(e.date.getMonth() + 1).padStart(2, "0")}`;
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

export default router;
