/**
 * report.service.ts
 * 
 * Serviço de cálculo de indicadores financeiros para o relatório dinâmico.
 * Cada indicador tem uma função de cálculo que faz queries Prisma e retorna
 * o valor formatado + texto explicativo interpolado.
 * 
 * Caminho no projeto: server/modules/report/report.service.ts
 */

import { prisma } from "../../shared/database.js";
import { getDREProfile } from "../../shared/dre-profiles.js";
import {
  STANDARD_INDICATORS,
  getIndicatorById,
  type StandardIndicator,
  type IndicatorUnit,
} from "./indicators.js";

// ============================================
// TIPOS
// ============================================

export interface CalculatedIndicator {
  id: string;
  name: string;
  value: string;        // valor formatado (ex: "R$ 12.345,67" ou "23,5%")
  rawValue: number | null;
  description: string;  // texto explicativo com valor interpolado
  unit: IndicatorUnit;
  available: boolean;   // false se dados insuficientes
  unavailableReason?: string;
}

interface MonthRange {
  start: Date;
  end: Date;
}

// ============================================
// HELPERS
// ============================================

function parseMonth(month: string): MonthRange {
  const [year, m] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, m - 1, 1)),
    end: new Date(Date.UTC(year, m, 1)),
  };
}

function getPreviousMonth(month: string): string {
  const [year, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(year, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatBRL(value: number): string {
  return `R$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatDays(value: number): string {
  return `${Math.round(value)} dias`;
}

function formatCount(value: number): string {
  return value.toLocaleString("pt-BR");
}

function formatValue(value: number, unit: IndicatorUnit): string {
  switch (unit) {
    case "BRL": return formatBRL(value);
    case "PERCENT": return formatPercent(value);
    case "DAYS": return formatDays(value);
    case "COUNT": return formatCount(value);
    case "TEXT": return String(value);
  }
}

function unavailable(indicator: StandardIndicator, reason: string): CalculatedIndicator {
  return {
    id: indicator.id,
    name: indicator.name,
    value: "Dado indisponível",
    rawValue: null,
    description: reason,
    unit: indicator.unit,
    available: false,
    unavailableReason: reason,
  };
}

function result(indicator: StandardIndicator, value: number, descriptionOverride?: string): CalculatedIndicator {
  return {
    id: indicator.id,
    name: indicator.name,
    value: formatValue(value, indicator.unit),
    rawValue: value,
    description: descriptionOverride || indicator.description,
    unit: indicator.unit,
    available: true,
  };
}

function textResult(indicator: StandardIndicator, displayValue: string, description: string): CalculatedIndicator {
  return {
    id: indicator.id,
    name: indicator.name,
    value: displayValue,
    rawValue: null,
    description,
    unit: "TEXT",
    available: true,
  };
}

// ============================================
// QUERIES BASE (reutilizadas por vários indicadores)
// ============================================

async function getCompletedTransactions(companyId: string, range: MonthRange) {
  return prisma.transaction.findMany({
    where: {
      companyId,
      status: "COMPLETED",
      date: { gte: range.start, lt: range.end },
    },
    include: { category: true, detail: true, counterparty: true },
  });
}

async function getRevenueTotal(companyId: string, range: MonthRange): Promise<number> {
  const result = await prisma.transaction.aggregate({
    where: {
      companyId,
      tipo_transacao: "INCOME",
      status: "COMPLETED",
      date: { gte: range.start, lt: range.end },
    },
    _sum: { amount: true },
  });
  return result._sum.amount || 0;
}

async function getExpenseTotal(companyId: string, range: MonthRange): Promise<number> {
  const result = await prisma.transaction.aggregate({
    where: {
      companyId,
      tipo_transacao: "EXPENSE",
      status: "COMPLETED",
      date: { gte: range.start, lt: range.end },
    },
    _sum: { amount: true },
  });
  return result._sum.amount || 0;
}

async function getDirectCosts(companyId: string, range: MonthRange): Promise<number> {
  // Buscar o perfil DRE da empresa para saber quais categorias são custo direto
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { sector: true },
  });
  if (!company) return 0;

  const dreProfile = getDREProfile(company.sector);
  if (!dreProfile) return 0;

  const transactions = await prisma.transaction.findMany({
    where: {
      companyId,
      tipo_transacao: "EXPENSE",
      status: "COMPLETED",
      date: { gte: range.start, lt: range.end },
    },
    include: { category: true },
  });

  return transactions
    .filter((tx) => tx.category && dreProfile.isDirectCost(tx.category.code))
    .reduce((sum, tx) => sum + tx.amount, 0);
}

// ============================================
// CALCULADORES POR INDICADOR
// ============================================

type Calculator = (companyId: string, month: string) => Promise<CalculatedIndicator>;

const calculators: Record<string, Calculator> = {

  // ── RENTABILIDADE ──

  async margem_bruta(companyId, month) {
    const ind = getIndicatorById("ind_margem_bruta")!;
    const range = parseMonth(month);
    const receita = await getRevenueTotal(companyId, range);
    if (receita === 0) return unavailable(ind, "Sem receita no mês para calcular a margem bruta.");
    const csp = await getDirectCosts(companyId, range);
    const margem = ((receita - csp) / receita) * 100;
    return result(ind, margem, `A margem bruta foi de ${formatPercent(margem)} — de cada R$ 100 de receita, ${formatBRL(receita - csp)} ficou após os custos diretos.`);
  },

  async margem_liquida(companyId, month) {
    const ind = getIndicatorById("ind_margem_liquida")!;
    const range = parseMonth(month);
    const receita = await getRevenueTotal(companyId, range);
    if (receita === 0) return unavailable(ind, "Sem receita no mês para calcular a margem líquida.");
    const despesa = await getExpenseTotal(companyId, range);
    const margem = ((receita - despesa) / receita) * 100;
    return result(ind, margem, `A margem líquida foi de ${formatPercent(margem)} — de cada R$ 100 de receita, ${formatBRL(receita - despesa)} sobrou no final.`);
  },

  async lucro_bruto(companyId, month) {
    const ind = getIndicatorById("ind_lucro_bruto")!;
    const range = parseMonth(month);
    const receita = await getRevenueTotal(companyId, range);
    const csp = await getDirectCosts(companyId, range);
    const lucro = receita - csp;
    return result(ind, lucro, `O lucro bruto foi de ${formatBRL(lucro)} — receita de ${formatBRL(receita)} menos custos diretos de ${formatBRL(csp)}.`);
  },

  async lucro_liquido(companyId, month) {
    const ind = getIndicatorById("ind_lucro_liquido")!;
    const range = parseMonth(month);
    const receita = await getRevenueTotal(companyId, range);
    const despesa = await getExpenseTotal(companyId, range);
    const lucro = receita - despesa;
    return result(ind, lucro, `O lucro líquido foi de ${formatBRL(lucro)} — receita de ${formatBRL(receita)} menos despesas totais de ${formatBRL(despesa)}.`);
  },

  async ebitda(companyId, month) {
    const ind = getIndicatorById("ind_ebitda")!;
    const range = parseMonth(month);
    const receita = await getRevenueTotal(companyId, range);
    const despesa = await getExpenseTotal(companyId, range);
    const lucroLiquido = receita - despesa;

    // Somar juros pagos
    const jurosResult = await prisma.transactionDetail.aggregate({
      where: {
        transaction: { companyId, status: "COMPLETED", date: { gte: range.start, lt: range.end } },
        interest: { not: null },
      },
      _sum: { interest: true },
    });
    const juros = jurosResult._sum.interest || 0;

    // Somar impostos (categorias 8.*)
    const impostos = await prisma.transaction.aggregate({
      where: {
        companyId,
        tipo_transacao: "EXPENSE",
        status: "COMPLETED",
        date: { gte: range.start, lt: range.end },
        category: { code: { startsWith: "8." } },
      },
      _sum: { amount: true },
    });
    const totalImpostos = impostos._sum.amount || 0;

    const ebitda = lucroLiquido + juros + totalImpostos;
    return result(ind, ebitda, `O EBITDA aproximado foi de ${formatBRL(ebitda)} — lucro líquido (${formatBRL(lucroLiquido)}) + juros (${formatBRL(juros)}) + impostos (${formatBRL(totalImpostos)}).`);
  },

  async ponto_equilibrio(companyId, month) {
    const ind = getIndicatorById("ind_ponto_equilibrio")!;
    const range = parseMonth(month);
    const receita = await getRevenueTotal(companyId, range);

    const fixos = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "EXPENSE", status: "COMPLETED", tipo_custo: "FIXO", date: { gte: range.start, lt: range.end } },
      _sum: { amount: true },
    });
    const variaveis = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "EXPENSE", status: "COMPLETED", tipo_custo: "VARIAVEL", date: { gte: range.start, lt: range.end } },
      _sum: { amount: true },
    });

    const custosFixos = fixos._sum.amount || 0;
    const custosVariaveis = variaveis._sum.amount || 0;

    if (receita === 0 || receita === custosVariaveis) {
      return unavailable(ind, "Dados insuficientes para calcular o ponto de equilíbrio (receita zero ou igual aos custos variáveis).");
    }

    const pe = custosFixos / (1 - custosVariaveis / receita);
    return result(ind, pe, `O ponto de equilíbrio é de ${formatBRL(pe)} — a empresa precisa faturar pelo menos esse valor para cobrir todos os custos.`);
  },

  async taxa_crescimento(companyId, month) {
    const ind = getIndicatorById("ind_taxa_crescimento")!;
    const range = parseMonth(month);
    const prevMonth = getPreviousMonth(month);
    const prevRange = parseMonth(prevMonth);

    const receitaAtual = await getRevenueTotal(companyId, range);
    const receitaAnterior = await getRevenueTotal(companyId, prevRange);

    if (receitaAnterior === 0) return unavailable(ind, "Sem receita no mês anterior para calcular a taxa de crescimento.");

    const taxa = ((receitaAtual - receitaAnterior) / receitaAnterior) * 100;
    const direcao = taxa >= 0 ? "cresceu" : "caiu";
    return result(ind, taxa, `A receita ${direcao} ${formatPercent(Math.abs(taxa))} em relação ao mês anterior (de ${formatBRL(receitaAnterior)} para ${formatBRL(receitaAtual)}).`);
  },

  // ── ESTRUTURA DE CUSTOS ──

  async custos_totais(companyId, month) {
    const ind = getIndicatorById("ind_custos_totais")!;
    const range = parseMonth(month);
    const total = await getExpenseTotal(companyId, range);
    return result(ind, total, `O total de custos e despesas pagos no mês foi de ${formatBRL(total)}.`);
  },

  async variacao_custos(companyId, month) {
    const ind = getIndicatorById("ind_variacao_custos")!;
    const range = parseMonth(month);
    const prevMonth = getPreviousMonth(month);
    const prevRange = parseMonth(prevMonth);

    const custoAtual = await getExpenseTotal(companyId, range);
    const custoAnterior = await getExpenseTotal(companyId, prevRange);

    if (custoAnterior === 0) return unavailable(ind, "Sem custos no mês anterior para calcular a variação.");

    const variacao = ((custoAtual - custoAnterior) / custoAnterior) * 100;
    const direcao = variacao >= 0 ? "aumentaram" : "diminuíram";
    return result(ind, variacao, `Os custos ${direcao} ${formatPercent(Math.abs(variacao))} em relação ao mês anterior (de ${formatBRL(custoAnterior)} para ${formatBRL(custoAtual)}).`);
  },

  async pct_fixos(companyId, month) {
    const ind = getIndicatorById("ind_pct_fixos")!;
    const range = parseMonth(month);
    const totalDespesas = await getExpenseTotal(companyId, range);
    if (totalDespesas === 0) return unavailable(ind, "Sem despesas no mês.");

    const fixos = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "EXPENSE", status: "COMPLETED", tipo_custo: "FIXO", date: { gte: range.start, lt: range.end } },
      _sum: { amount: true },
    });
    const pct = ((fixos._sum.amount || 0) / totalDespesas) * 100;
    return result(ind, pct, `${formatPercent(pct)} dos gastos do mês são custos fixos (${formatBRL(fixos._sum.amount || 0)} de ${formatBRL(totalDespesas)}).`);
  },

  async pct_variaveis(companyId, month) {
    const ind = getIndicatorById("ind_pct_variaveis")!;
    const range = parseMonth(month);
    const totalDespesas = await getExpenseTotal(companyId, range);
    if (totalDespesas === 0) return unavailable(ind, "Sem despesas no mês.");

    const variaveis = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "EXPENSE", status: "COMPLETED", tipo_custo: "VARIAVEL", date: { gte: range.start, lt: range.end } },
      _sum: { amount: true },
    });
    const pct = ((variaveis._sum.amount || 0) / totalDespesas) * 100;
    return result(ind, pct, `${formatPercent(pct)} dos gastos do mês são custos variáveis (${formatBRL(variaveis._sum.amount || 0)} de ${formatBRL(totalDespesas)}).`);
  },

  async maior_despesa(companyId, month) {
    const ind = getIndicatorById("ind_maior_despesa")!;
    const range = parseMonth(month);
    const tx = await prisma.transaction.findFirst({
      where: { companyId, tipo_transacao: "EXPENSE", status: "COMPLETED", date: { gte: range.start, lt: range.end } },
      orderBy: { amount: "desc" },
      include: { category: true },
    });
    if (!tx) return unavailable(ind, "Sem despesas no mês.");
    return textResult(ind, `${formatBRL(tx.amount)} — ${tx.description}`, `A maior despesa do mês foi "${tx.description}" no valor de ${formatBRL(tx.amount)}${tx.category ? ` (categoria: ${tx.category.name})` : ""}.`);
  },

  async top5_categorias(companyId, month) {
    const ind = getIndicatorById("ind_top5_categorias")!;
    const range = parseMonth(month);
    const grouped = await prisma.transaction.groupBy({
      by: ["categoryId"],
      where: { companyId, tipo_transacao: "EXPENSE", status: "COMPLETED", date: { gte: range.start, lt: range.end }, categoryId: { not: null } },
      _sum: { amount: true },
      orderBy: { _sum: { amount: "desc" } },
      take: 5,
    });
    if (grouped.length === 0) return unavailable(ind, "Sem despesas categorizadas no mês.");

    const categoryIds = grouped.map((g) => g.categoryId).filter(Boolean) as string[];
    const categories = await prisma.category.findMany({ where: { id: { in: categoryIds } } });
    const catMap = new Map(categories.map((c) => [c.id, c.name]));

    const lines = grouped.map((g, i) => {
      const name = catMap.get(g.categoryId!) || "Sem categoria";
      return `${i + 1}. ${name}: ${formatBRL(g._sum.amount || 0)}`;
    });

    return textResult(ind, lines.join("\n"), `As 5 categorias que mais consumiram recursos:\n${lines.join("\n")}`);
  },

  async impostos_totais(companyId, month) {
    const ind = getIndicatorById("ind_impostos_totais")!;
    const range = parseMonth(month);
    const result_ = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "EXPENSE", status: "COMPLETED", date: { gte: range.start, lt: range.end }, category: { code: { startsWith: "8." } } },
      _sum: { amount: true },
    });
    const total = result_._sum.amount || 0;
    return result(ind, total, `O total pago em impostos no mês foi de ${formatBRL(total)}.`);
  },

  async pct_impostos(companyId, month) {
    const ind = getIndicatorById("ind_pct_impostos")!;
    const range = parseMonth(month);
    const receita = await getRevenueTotal(companyId, range);
    if (receita === 0) return unavailable(ind, "Sem receita no mês.");

    const impostos = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "EXPENSE", status: "COMPLETED", date: { gte: range.start, lt: range.end }, category: { code: { startsWith: "8." } } },
      _sum: { amount: true },
    });
    const pct = ((impostos._sum.amount || 0) / receita) * 100;
    return result(ind, pct, `${formatPercent(pct)} da receita foi consumido por impostos (${formatBRL(impostos._sum.amount || 0)} de ${formatBRL(receita)}).`);
  },

  async custo_pessoal(companyId, month) {
    const ind = getIndicatorById("ind_custo_pessoal")!;
    const range = parseMonth(month);
    const result_ = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "EXPENSE", status: "COMPLETED", date: { gte: range.start, lt: range.end }, category: { code: { startsWith: "4." } } },
      _sum: { amount: true },
    });
    const total = result_._sum.amount || 0;
    return result(ind, total, `O total gasto com pessoal (salários, encargos e benefícios) foi de ${formatBRL(total)}.`);
  },

  async pct_pessoal(companyId, month) {
    const ind = getIndicatorById("ind_pct_pessoal")!;
    const range = parseMonth(month);
    const receita = await getRevenueTotal(companyId, range);
    if (receita === 0) return unavailable(ind, "Sem receita no mês.");

    const pessoal = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "EXPENSE", status: "COMPLETED", date: { gte: range.start, lt: range.end }, category: { code: { startsWith: "4." } } },
      _sum: { amount: true },
    });
    const pct = ((pessoal._sum.amount || 0) / receita) * 100;
    return result(ind, pct, `${formatPercent(pct)} da receita é comprometido com pessoal (${formatBRL(pessoal._sum.amount || 0)} de ${formatBRL(receita)}).`);
  },

  // ── FLUXO DE CAIXA ──

  async receitas_totais(companyId, month) {
    const ind = getIndicatorById("ind_receitas_totais")!;
    const range = parseMonth(month);
    const total = await getRevenueTotal(companyId, range);
    return result(ind, total, `O total de receitas recebidas no mês foi de ${formatBRL(total)}.`);
  },

  async saldo_acumulado(companyId, month) {
    const ind = getIndicatorById("ind_saldo_acumulado")!;
    const range = parseMonth(month);

    const receitas = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "INCOME", status: "COMPLETED", date: { lt: range.end } },
      _sum: { amount: true },
    });
    const despesas = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "EXPENSE", status: "COMPLETED", date: { lt: range.end } },
      _sum: { amount: true },
    });
    const saldo = (receitas._sum.amount || 0) - (despesas._sum.amount || 0);
    return result(ind, saldo, `O saldo acumulado até o final do mês é de ${formatBRL(saldo)}.`);
  },

  async fluxo_caixa_liquido(companyId, month) {
    const ind = getIndicatorById("ind_fluxo_caixa_liquido")!;
    const range = parseMonth(month);
    const receita = await getRevenueTotal(companyId, range);
    const despesa = await getExpenseTotal(companyId, range);
    const fluxo = receita - despesa;
    const sinal = fluxo >= 0 ? "positivo" : "negativo";
    return result(ind, fluxo, `O fluxo de caixa do mês foi ${sinal}: ${formatBRL(fluxo)} (receitas ${formatBRL(receita)} - despesas ${formatBRL(despesa)}).`);
  },

  async cobertura_caixa(companyId, month) {
    const ind = getIndicatorById("ind_cobertura_caixa")!;
    const range = parseMonth(month);

    // Saldo acumulado
    const receitasAcum = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "INCOME", status: "COMPLETED", date: { lt: range.end } },
      _sum: { amount: true },
    });
    const despesasAcum = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "EXPENSE", status: "COMPLETED", date: { lt: range.end } },
      _sum: { amount: true },
    });
    const saldo = (receitasAcum._sum.amount || 0) - (despesasAcum._sum.amount || 0);

    // Média de despesas dos últimos 3 meses
    const threeMonthsAgo = new Date(range.start);
    threeMonthsAgo.setUTCMonth(threeMonthsAgo.getUTCMonth() - 3);
    const despesas3m = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "EXPENSE", status: "COMPLETED", date: { gte: threeMonthsAgo, lt: range.end } },
      _sum: { amount: true },
    });
    const mediaDespesas = (despesas3m._sum.amount || 0) / 3;

    if (mediaDespesas === 0) return unavailable(ind, "Sem despesas nos últimos 3 meses para calcular a cobertura.");
    if (saldo <= 0) return result(ind, 0, "O saldo acumulado é negativo — a empresa não tem cobertura de caixa.");

    const meses = saldo / mediaDespesas;
    return result(ind, meses, `Com o caixa atual de ${formatBRL(saldo)}, a empresa consegue operar por aproximadamente ${meses.toFixed(1)} meses sem nenhuma receita nova.`);
  },

  async comprometimento_futuro(companyId, _month) {
    const ind = getIndicatorById("ind_comprometimento_futuro")!;
    const result_ = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "EXPENSE", status: "PENDING" },
      _sum: { amount: true },
    });
    const total = result_._sum.amount || 0;
    return result(ind, total, `O total de despesas pendentes (já lançadas mas não pagas) é de ${formatBRL(total)}.`);
  },

  async recebiveis_futuros(companyId, _month) {
    const ind = getIndicatorById("ind_recebiveis_futuros")!;
    const result_ = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "INCOME", status: "PENDING" },
      _sum: { amount: true },
    });
    const total = result_._sum.amount || 0;
    return result(ind, total, `O total de receitas pendentes (já lançadas mas não recebidas) é de ${formatBRL(total)}.`);
  },

  async receitas_inadimplentes(companyId, _month) {
    const ind = getIndicatorById("ind_receitas_inadimplentes")!;
    const now = new Date();
    const result_ = await prisma.transaction.aggregate({
      where: {
        companyId,
        tipo_transacao: "INCOME",
        status: { in: ["PENDING", "OVERDUE"] },
        detail: { dueDate: { lt: now }, receiptDate: null },
      },
      _sum: { amount: true },
    });
    const total = result_._sum.amount || 0;
    return result(ind, total, `O total de receitas inadimplentes (vencidas e não recebidas) é de ${formatBRL(total)}.`);
  },

  async pagamentos_atraso(companyId, _month) {
    const ind = getIndicatorById("ind_pagamentos_atraso")!;
    const now = new Date();
    const result_ = await prisma.transaction.aggregate({
      where: {
        companyId,
        tipo_transacao: "EXPENSE",
        status: { in: ["PENDING", "OVERDUE"] },
        detail: { dueDate: { lt: now }, paymentDate: null },
      },
      _sum: { amount: true },
    });
    const total = result_._sum.amount || 0;
    return result(ind, total, `O total de pagamentos em atraso (vencidos e não pagos) é de ${formatBRL(total)}.`);
  },

  // ── FORNECEDORES E CLIENTES ──

  async ciclo_caixa(companyId, _month) {
    const ind = getIndicatorById("ind_ciclo_caixa")!;
    const clientes = await prisma.counterparty.aggregate({
      where: { companyId, type: "CLIENT", isActive: true, avgDaysToReceive: { not: null } },
      _avg: { avgDaysToReceive: true },
    });
    const fornecedores = await prisma.counterparty.aggregate({
      where: { companyId, type: "SUPPLIER", isActive: true, avgDaysToPay: { not: null } },
      _avg: { avgDaysToPay: true },
    });
    const pmr = clientes._avg.avgDaysToReceive || 0;
    const pmp = fornecedores._avg.avgDaysToPay || 0;
    const ciclo = pmr - pmp;
    return result(ind, ciclo, `O ciclo de caixa é de ${Math.round(ciclo)} dias (recebe em ${Math.round(pmr)} dias e paga em ${Math.round(pmp)} dias). ${ciclo > 0 ? "A empresa paga antes de receber, o que pressiona o caixa." : "A empresa recebe antes de pagar, o que é positivo para o caixa."}`);
  },

  async pmr(companyId, _month) {
    const ind = getIndicatorById("ind_pmr")!;
    const result_ = await prisma.counterparty.aggregate({
      where: { companyId, type: "CLIENT", isActive: true, avgDaysToReceive: { not: null } },
      _avg: { avgDaysToReceive: true },
    });
    const pmr = result_._avg.avgDaysToReceive || 0;
    return result(ind, pmr, `Em média, seus clientes levam ${Math.round(pmr)} dias para pagar.`);
  },

  async pmp(companyId, _month) {
    const ind = getIndicatorById("ind_pmp")!;
    const result_ = await prisma.counterparty.aggregate({
      where: { companyId, type: "SUPPLIER", isActive: true, avgDaysToPay: { not: null } },
      _avg: { avgDaysToPay: true },
    });
    const pmp = result_._avg.avgDaysToPay || 0;
    return result(ind, pmp, `Em média, você leva ${Math.round(pmp)} dias para pagar seus fornecedores.`);
  },

  async maior_fornecedor(companyId, month) {
    const ind = getIndicatorById("ind_maior_fornecedor")!;
    const range = parseMonth(month);
    const grouped = await prisma.transaction.groupBy({
      by: ["counterpartyId"],
      where: { companyId, tipo_transacao: "EXPENSE", status: "COMPLETED", date: { gte: range.start, lt: range.end }, counterpartyId: { not: null } },
      _sum: { amount: true },
      orderBy: { _sum: { amount: "desc" } },
      take: 1,
    });
    if (grouped.length === 0) return unavailable(ind, "Sem despesas com fornecedores identificados no mês.");
    const cp = await prisma.counterparty.findUnique({ where: { id: grouped[0].counterpartyId! } });
    const nome = cp?.name || "Desconhecido";
    const valor = grouped[0]._sum.amount || 0;
    return textResult(ind, `${nome}: ${formatBRL(valor)}`, `O fornecedor que mais recebeu pagamentos no mês foi ${nome}, com ${formatBRL(valor)}.`);
  },

  async maior_cliente(companyId, month) {
    const ind = getIndicatorById("ind_maior_cliente")!;
    const range = parseMonth(month);
    const grouped = await prisma.transaction.groupBy({
      by: ["counterpartyId"],
      where: { companyId, tipo_transacao: "INCOME", status: "COMPLETED", date: { gte: range.start, lt: range.end }, counterpartyId: { not: null } },
      _sum: { amount: true },
      orderBy: { _sum: { amount: "desc" } },
      take: 1,
    });
    if (grouped.length === 0) return unavailable(ind, "Sem receitas com clientes identificados no mês.");
    const cp = await prisma.counterparty.findUnique({ where: { id: grouped[0].counterpartyId! } });
    const nome = cp?.name || "Desconhecido";
    const valor = grouped[0]._sum.amount || 0;
    return textResult(ind, `${nome}: ${formatBRL(valor)}`, `O cliente que mais gerou receita no mês foi ${nome}, com ${formatBRL(valor)}.`);
  },

  async concentracao_clientes(companyId, month) {
    const ind = getIndicatorById("ind_concentracao_clientes")!;
    const range = parseMonth(month);
    const receitaTotal = await getRevenueTotal(companyId, range);
    if (receitaTotal === 0) return unavailable(ind, "Sem receita no mês.");

    const grouped = await prisma.transaction.groupBy({
      by: ["counterpartyId"],
      where: { companyId, tipo_transacao: "INCOME", status: "COMPLETED", date: { gte: range.start, lt: range.end }, counterpartyId: { not: null } },
      _sum: { amount: true },
      orderBy: { _sum: { amount: "desc" } },
      take: 1,
    });
    if (grouped.length === 0) return unavailable(ind, "Sem receitas com clientes identificados.");
    const maiorCliente = grouped[0]._sum.amount || 0;
    const pct = (maiorCliente / receitaTotal) * 100;
    const alerta = pct > 30 ? " ⚠️ Acima de 30% indica risco de concentração." : "";
    return result(ind, pct, `O maior cliente representa ${formatPercent(pct)} da receita total.${alerta}`);
  },

  async fornecedores_atraso(companyId, _month) {
    const ind = getIndicatorById("ind_fornecedores_atraso")!;
    const count = await prisma.counterparty.count({
      where: { companyId, type: "SUPPLIER", isActive: true, latePaymentCount: { gt: 0 } },
    });
    return result(ind, count, `${count} fornecedor(es) tiveram pagamentos atrasados.`);
  },

  async contrapartes_ativas(companyId, _month) {
    const ind = getIndicatorById("ind_contrapartes_ativas")!;
    const count = await prisma.counterparty.count({
      where: { companyId, isActive: true },
    });
    return result(ind, count, `A empresa possui ${count} fornecedores e clientes ativos.`);
  },

  // ── OPERAÇÃO E TENDÊNCIA ──

  async ticket_medio_receita(companyId, month) {
    const ind = getIndicatorById("ind_ticket_medio_receita")!;
    const range = parseMonth(month);
    const result_ = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "INCOME", status: "COMPLETED", date: { gte: range.start, lt: range.end } },
      _avg: { amount: true },
      _count: true,
    });
    if (result_._count === 0) return unavailable(ind, "Sem receitas no mês.");
    const avg = result_._avg.amount || 0;
    return result(ind, avg, `O valor médio de cada receita no mês foi de ${formatBRL(avg)} (${result_._count} transações).`);
  },

  async ticket_medio_despesa(companyId, month) {
    const ind = getIndicatorById("ind_ticket_medio_despesa")!;
    const range = parseMonth(month);
    const result_ = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "EXPENSE", status: "COMPLETED", date: { gte: range.start, lt: range.end } },
      _avg: { amount: true },
      _count: true,
    });
    if (result_._count === 0) return unavailable(ind, "Sem despesas no mês.");
    const avg = result_._avg.amount || 0;
    return result(ind, avg, `O valor médio de cada despesa no mês foi de ${formatBRL(avg)} (${result_._count} transações).`);
  },

  async qtd_transacoes(companyId, month) {
    const ind = getIndicatorById("ind_qtd_transacoes")!;
    const range = parseMonth(month);
    const count = await prisma.transaction.count({
      where: { companyId, status: "COMPLETED", date: { gte: range.start, lt: range.end } },
    });
    return result(ind, count, `Foram registradas ${count} transações concluídas no mês.`);
  },

  async juros_pagos(companyId, month) {
    const ind = getIndicatorById("ind_juros_pagos")!;
    const range = parseMonth(month);
    const result_ = await prisma.transactionDetail.aggregate({
      where: {
        transaction: { companyId, status: "COMPLETED", date: { gte: range.start, lt: range.end } },
        interest: { not: null },
      },
      _sum: { interest: true },
    });
    const total = result_._sum.interest || 0;
    return result(ind, total, `O total de juros pagos no mês foi de ${formatBRL(total)}.`);
  },

  async descontos_concedidos(companyId, month) {
    const ind = getIndicatorById("ind_descontos_concedidos")!;
    const range = parseMonth(month);
    const result_ = await prisma.transactionDetail.aggregate({
      where: {
        transaction: { companyId, tipo_transacao: "INCOME", status: "COMPLETED", date: { gte: range.start, lt: range.end } },
        discount: { not: null },
      },
      _sum: { discount: true },
    });
    const total = result_._sum.discount || 0;
    return result(ind, total, `O total de descontos concedidos a clientes no mês foi de ${formatBRL(total)}.`);
  },

  async descontos_obtidos(companyId, month) {
    const ind = getIndicatorById("ind_descontos_obtidos")!;
    const range = parseMonth(month);
    const result_ = await prisma.transactionDetail.aggregate({
      where: {
        transaction: { companyId, tipo_transacao: "EXPENSE", status: "COMPLETED", date: { gte: range.start, lt: range.end } },
        discount: { not: null },
      },
      _sum: { discount: true },
    });
    const total = result_._sum.discount || 0;
    return result(ind, total, `O total de descontos obtidos de fornecedores no mês foi de ${formatBRL(total)}.`);
  },

  async alertas_ativos(companyId, _month) {
    const ind = getIndicatorById("ind_alertas_ativos")!;
    const count = await prisma.alert.count({
      where: { companyId, isDismissed: false, isRead: false },
    });
    return result(ind, count, `A empresa possui ${count} alerta(s) financeiro(s) ativo(s) que ainda não foram lidos.`);
  },
};

// ============================================
// FUNÇÃO PRINCIPAL: Calcular indicadores selecionados
// ============================================

export async function calculateIndicators(
  companyId: string,
  month: string,
  indicatorIds: string[]
): Promise<CalculatedIndicator[]> {
  const results: CalculatedIndicator[] = [];

  for (const id of indicatorIds) {
    const indicator = getIndicatorById(id);
    if (!indicator) {
      results.push({
        id,
        name: id,
        value: "Indicador não encontrado",
        rawValue: null,
        description: "Este indicador não existe no registry.",
        unit: "TEXT",
        available: false,
        unavailableReason: "Indicador não encontrado no registry.",
      });
      continue;
    }

    const calculator = calculators[indicator.calculationKey];
    if (!calculator) {
      results.push(unavailable(indicator, "Cálculo não implementado para este indicador."));
      continue;
    }

    try {
      const calculated = await calculator(companyId, month);
      results.push(calculated);
    } catch (error) {
      console.error(`Erro ao calcular indicador ${id}:`, error);
      results.push(unavailable(indicator, "Erro ao calcular este indicador. Tente novamente."));
    }
  }

  return results;
}

// ============================================
// FUNÇÃO: Obter último mês completo
// ============================================

export function getLastCompleteMonth(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
