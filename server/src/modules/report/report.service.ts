/**
 * report.service.ts
 * 
 * Serviço de cálculo de indicadores financeiros para o relatório dinâmico.
 * Cada indicador tem uma função de cálculo que faz queries Prisma e retorna
 * o valor formatado + texto explicativo interpolado.
 * 
 * REGIME DE CAIXA: Todas as queries usam data efetiva (paymentDate/receiptDate)
 * para alinhar com o Dashboard (financial.controller.ts).
 * 
 * Caminho no projeto: server/modules/report/report.service.ts
 */

import { prisma } from "../../shared/database.js";
import { getDREProfile, isDirectCost as isDirectCostFn, isTax as isTaxFn } from "../../shared/dre-profiles.js";
import { callAi, chatWithTools } from "../ai/ai.service.js";
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

/** Converte Prisma Decimal | number | null para number nativo */
function n(val: any): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  return typeof val.toNumber === 'function' ? val.toNumber() : Number(val);
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
// REGIME DE CAIXA — DATA EFETIVA
// Alinhado com financial.controller.ts (Dashboard)
// ============================================

/**
 * Retorna a data efetiva de uma transação (regime de caixa).
 * Para EXPENSE: paymentDate (fallback: transaction.date)
 * Para INCOME: receiptDate (fallback: transaction.date)
 */
function getEffectiveDate(tx: any): Date {
  if (tx.tipo_transacao === "EXPENSE") {
    return tx.detail?.paymentDate ? new Date(tx.detail.paymentDate) : new Date(tx.date);
  } else {
    return tx.detail?.receiptDate ? new Date(tx.detail.receiptDate) : new Date(tx.date);
  }
}

function getActualSettlementDate(tx: any): Date | null {
  if (tx.tipo_transacao === "EXPENSE") {
    return tx.detail?.paymentDate ? new Date(tx.detail.paymentDate) : null;
  }
  return tx.detail?.receiptDate ? new Date(tx.detail.receiptDate) : null;
}

function daysBetween(start: Date, end: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.max(0, Math.round((endUtc - startUtc) / msPerDay));
}

function getCounterpartyId(tx: any): string | null {
  return tx.counterparty?.id || tx.counterpartyId || tx.detail?.counterpartyId || null;
}

async function getAverageSettlementDays(
  companyId: string,
  month: string,
  transactionType: "INCOME" | "EXPENSE",
) {
  const range = parseMonth(month);
  const transactions = await getCompletedTransactionsEffective(companyId, range);
  const samples = transactions
    .filter((tx) => tx.tipo_transacao === transactionType)
    .map((tx) => {
      const settlementDate = getActualSettlementDate(tx);
      if (!settlementDate) return null;
      return daysBetween(new Date(tx.date), settlementDate);
    })
    .filter((value): value is number => value !== null);

  if (samples.length === 0) {
    return { average: null, count: 0 };
  }

  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return { average, count: samples.length };
}

// ============================================
// QUERIES BASE (reutilizadas por vários indicadores)
// Todas usam data efetiva para regime de caixa.
// ============================================

/**
 * Busca transações COMPLETED da empresa e filtra por data efetiva dentro do
 * range do mês. A query considera paymentDate/receiptDate diretamente para
 * não perder transações pagas/recebidas muito depois da data original.
 */
async function getCompletedTransactionsEffective(companyId: string, range: MonthRange) {
  const allTx = await prisma.transaction.findMany({
    where: {
      companyId,
      status: "COMPLETED",
      OR: [
        {
          tipo_transacao: "EXPENSE",
          detail: { paymentDate: { gte: range.start, lt: range.end } },
        },
        {
          tipo_transacao: "INCOME",
          detail: { receiptDate: { gte: range.start, lt: range.end } },
        },
        {
          date: { gte: range.start, lt: range.end },
        },
      ],
    },
    include: { category: true, detail: true, counterparty: true },
  });

  return allTx.filter((tx) => {
    const effectiveDate = getEffectiveDate(tx);
    return effectiveDate >= range.start && effectiveDate < range.end;
  });
}

/**
 * Busca todas as transações COMPLETED até o final do range (para saldo acumulado).
 * Filtra por data efetiva < range.end.
 */
async function getAllCompletedTransactionsUntil(companyId: string, untilDate: Date) {
  const allTx = await prisma.transaction.findMany({
    where: {
      companyId,
      status: "COMPLETED",
    },
    include: { detail: true },
  });

  return allTx.filter((tx) => {
    const effectiveDate = getEffectiveDate(tx);
    return effectiveDate < untilDate;
  });
}

// Alias para compatibilidade
async function getCompletedTransactions(companyId: string, range: MonthRange) {
  return getCompletedTransactionsEffective(companyId, range);
}

async function getRevenueTotal(companyId: string, range: MonthRange): Promise<number> {
  const transactions = await getCompletedTransactionsEffective(companyId, range);
  return transactions
    .filter((tx) => tx.tipo_transacao === "INCOME")
    .reduce((sum, tx) => sum + n(tx.amount), 0);
}

async function getExpenseTotal(companyId: string, range: MonthRange): Promise<number> {
  const transactions = await getCompletedTransactionsEffective(companyId, range);
  return transactions
    .filter((tx) => tx.tipo_transacao === "EXPENSE")
    .reduce((sum, tx) => sum + n(tx.amount), 0);
}

async function getDirectCosts(companyId: string, range: MonthRange): Promise<number> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { sector: true },
  });
  if (!company) return 0;

  const dreProfile = getDREProfile(company.sector);
  if (!dreProfile) return 0;

  const transactions = await getCompletedTransactionsEffective(companyId, range);

  return transactions
    .filter((tx) => tx.tipo_transacao === "EXPENSE" && tx.category && isDirectCostFn(tx.category.code, dreProfile))
    .reduce((sum, tx) => sum + n(tx.amount), 0);
}

/**
 * Busca o total de deduções da receita do mês, conforme perfil DRE.
 * Ex.: Simples/DAS, ISS, ICMS, PIS/COFINS.
 */
async function getTaxes(companyId: string, range: MonthRange): Promise<number> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { sector: true },
  });
  if (!company) return 0;

  const dreProfile = getDREProfile(company.sector);
  if (!dreProfile) return 0;

  const transactions = await getCompletedTransactionsEffective(companyId, range);

  return transactions
    .filter((tx) => tx.tipo_transacao === "EXPENSE" && tx.category && isTaxFn(tx.category.code, dreProfile))
    .reduce((sum, tx) => sum + n(tx.amount), 0);
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
    const deducoes = await getTaxes(companyId, range);
    const receitaLiquida = receita - deducoes;
    const lucroBruto = receitaLiquida - csp;
    const margem = (lucroBruto / receita) * 100;
    return result(ind, margem, `A margem bruta foi de ${formatPercent(margem)} — de cada R$ 100 de receita bruta, R$ ${margem.toFixed(2).replace('.', ',')} sobraram após deduções da receita e custos diretos.`);
  },

  async margem_liquida(companyId, month) {
    const ind = getIndicatorById("ind_margem_liquida")!;
    const range = parseMonth(month);
    const receita = await getRevenueTotal(companyId, range);
    if (receita === 0) return unavailable(ind, "Sem receita no mês para calcular a margem líquida.");
    const despesa = await getExpenseTotal(companyId, range);
    const margem = ((receita - despesa) / receita) * 100;
    return result(ind, margem, `A margem líquida foi de ${formatPercent(margem)} — de cada R$ 100 de receita, R$ ${margem.toFixed(2).replace('.', ',')} sobraram após pagar todas as despesas.`);
  },

  async lucro_bruto(companyId, month) {
    const ind = getIndicatorById("ind_lucro_bruto")!;
    const range = parseMonth(month);
    const receita = await getRevenueTotal(companyId, range);
    const csp = await getDirectCosts(companyId, range);
    const deducoes = await getTaxes(companyId, range);
    const receitaLiquida = receita - deducoes;
    const lucro = receitaLiquida - csp;
    return result(ind, lucro, `O lucro bruto foi de ${formatBRL(lucro)} — receita bruta de ${formatBRL(receita)} menos deduções da receita (${formatBRL(deducoes)}) e custos diretos (${formatBRL(csp)}).`);
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
    const transactions = await getCompletedTransactionsEffective(companyId, range);

    const receita = transactions
      .filter((tx) => tx.tipo_transacao === "INCOME")
      .reduce((sum, tx) => sum + n(tx.amount), 0);
    const despesa = transactions
      .filter((tx) => tx.tipo_transacao === "EXPENSE")
      .reduce((sum, tx) => sum + n(tx.amount), 0);
    const lucroLiquido = receita - despesa;

    // Somar juros pagos (do detail das transações do mês efetivo)
    const juros = transactions
      .filter((tx) => tx.tipo_transacao === "EXPENSE" && tx.detail?.interest)
      .reduce((sum, tx) => sum + n(tx.detail!.interest), 0);

    // Somar impostos (categorias 8.*)
    const totalImpostos = transactions
      .filter((tx) => tx.tipo_transacao === "EXPENSE" && tx.category?.code?.startsWith("8."))
      .reduce((sum, tx) => sum + n(tx.amount), 0);

    const ebitda = lucroLiquido + juros + totalImpostos;
    return result(ind, ebitda, `O EBITDA aproximado foi de ${formatBRL(ebitda)} — lucro líquido (${formatBRL(lucroLiquido)}) + juros (${formatBRL(juros)}) + impostos (${formatBRL(totalImpostos)}).`);
  },

  async ponto_equilibrio(companyId, month) {
    const ind = getIndicatorById("ind_ponto_equilibrio")!;
    const range = parseMonth(month);
    const transactions = await getCompletedTransactionsEffective(companyId, range);

    const receita = transactions
      .filter((tx) => tx.tipo_transacao === "INCOME")
      .reduce((sum, tx) => sum + n(tx.amount), 0);

    const custosFixos = transactions
      .filter((tx) => tx.tipo_transacao === "EXPENSE" && (tx as any).tipo_custo === "FIXO")
      .reduce((sum, tx) => sum + n(tx.amount), 0);

    const custosVariaveis = transactions
      .filter((tx) => tx.tipo_transacao === "EXPENSE" && (tx as any).tipo_custo === "VARIAVEL")
      .reduce((sum, tx) => sum + n(tx.amount), 0);

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
    const transactions = await getCompletedTransactionsEffective(companyId, range);

    const totalDespesas = transactions
      .filter((tx) => tx.tipo_transacao === "EXPENSE")
      .reduce((sum, tx) => sum + n(tx.amount), 0);
    if (totalDespesas === 0) return unavailable(ind, "Sem despesas no mês.");

    const fixVal = transactions
      .filter((tx) => tx.tipo_transacao === "EXPENSE" && (tx as any).tipo_custo === "FIXO")
      .reduce((sum, tx) => sum + n(tx.amount), 0);
    const pct = (fixVal / totalDespesas) * 100;
    return result(ind, pct, `${formatPercent(pct)} dos gastos do mês são custos fixos (${formatBRL(fixVal)} de ${formatBRL(totalDespesas)}).`);
  },

  async pct_variaveis(companyId, month) {
    const ind = getIndicatorById("ind_pct_variaveis")!;
    const range = parseMonth(month);
    const transactions = await getCompletedTransactionsEffective(companyId, range);

    const totalDespesas = transactions
      .filter((tx) => tx.tipo_transacao === "EXPENSE")
      .reduce((sum, tx) => sum + n(tx.amount), 0);
    if (totalDespesas === 0) return unavailable(ind, "Sem despesas no mês.");

    const varVal = transactions
      .filter((tx) => tx.tipo_transacao === "EXPENSE" && (tx as any).tipo_custo === "VARIAVEL")
      .reduce((sum, tx) => sum + n(tx.amount), 0);
    const pct = (varVal / totalDespesas) * 100;
    return result(ind, pct, `${formatPercent(pct)} dos gastos do mês são custos variáveis (${formatBRL(varVal)} de ${formatBRL(totalDespesas)}).`);
  },

  async maior_despesa(companyId, month) {
    const ind = getIndicatorById("ind_maior_despesa")!;
    const range = parseMonth(month);
    const transactions = await getCompletedTransactionsEffective(companyId, range);

    const despesas = transactions
      .filter((tx) => tx.tipo_transacao === "EXPENSE")
      .sort((a, b) => n(b.amount) - n(a.amount));

    if (despesas.length === 0) return unavailable(ind, "Sem despesas no mês.");
    const tx = despesas[0];
    const txAmount = n(tx.amount);
    return textResult(ind, `${formatBRL(txAmount)} — ${tx.description}`, `A maior despesa do mês foi "${tx.description}" no valor de ${formatBRL(txAmount)}${tx.category ? ` (categoria: ${tx.category.name})` : ""}.`);
  },

  async top5_categorias(companyId, month) {
    const ind = getIndicatorById("ind_top5_categorias")!;
    const range = parseMonth(month);
    const transactions = await getCompletedTransactionsEffective(companyId, range);

    const despesas = transactions.filter((tx) => tx.tipo_transacao === "EXPENSE" && tx.category);
    if (despesas.length === 0) return unavailable(ind, "Sem despesas categorizadas no mês.");

    // Agrupar por categoria
    const catMap = new Map<string, { name: string; total: number }>();
    despesas.forEach((tx) => {
      const catId = tx.category!.id;
      const existing = catMap.get(catId);
      if (existing) {
        existing.total += n(tx.amount);
      } else {
        catMap.set(catId, { name: tx.category!.name, total: n(tx.amount) });
      }
    });

    const sorted = Array.from(catMap.values()).sort((a, b) => b.total - a.total).slice(0, 5);
    const lines = sorted.map((c, i) => `${i + 1}. ${c.name}: ${formatBRL(c.total)}`);

    return textResult(ind, lines.join("\n"), `As 5 categorias que mais consumiram recursos:\n${lines.join("\n")}`);
  },

  async impostos_totais(companyId, month) {
    const ind = getIndicatorById("ind_impostos_totais")!;
    const range = parseMonth(month);
    const transactions = await getCompletedTransactionsEffective(companyId, range);

    const total = transactions
      .filter((tx) => tx.tipo_transacao === "EXPENSE" && tx.category?.code?.startsWith("8."))
      .reduce((sum, tx) => sum + n(tx.amount), 0);
    return result(ind, total, `O total pago em impostos no mês foi de ${formatBRL(total)}.`);
  },

  async pct_impostos(companyId, month) {
    const ind = getIndicatorById("ind_pct_impostos")!;
    const range = parseMonth(month);
    const receita = await getRevenueTotal(companyId, range);
    if (receita === 0) return unavailable(ind, "Sem receita no mês.");

    const transactions = await getCompletedTransactionsEffective(companyId, range);
    const impVal = transactions
      .filter((tx) => tx.tipo_transacao === "EXPENSE" && tx.category?.code?.startsWith("8."))
      .reduce((sum, tx) => sum + n(tx.amount), 0);
    const pct = (impVal / receita) * 100;
    return result(ind, pct, `${formatPercent(pct)} da receita foi consumido por impostos (${formatBRL(impVal)} de ${formatBRL(receita)}).`);
  },

  async custo_pessoal(companyId, month) {
    const ind = getIndicatorById("ind_custo_pessoal")!;
    const range = parseMonth(month);
    const transactions = await getCompletedTransactionsEffective(companyId, range);

    const total = transactions
      .filter((tx) => tx.tipo_transacao === "EXPENSE" && tx.category?.code?.startsWith("4."))
      .reduce((sum, tx) => sum + n(tx.amount), 0);
    return result(ind, total, `O total gasto com pessoal (salários, encargos e benefícios) foi de ${formatBRL(total)}.`);
  },

  async pct_pessoal(companyId, month) {
    const ind = getIndicatorById("ind_pct_pessoal")!;
    const range = parseMonth(month);
    const receita = await getRevenueTotal(companyId, range);
    if (receita === 0) return unavailable(ind, "Sem receita no mês.");

    const transactions = await getCompletedTransactionsEffective(companyId, range);
    const pesVal = transactions
      .filter((tx) => tx.tipo_transacao === "EXPENSE" && tx.category?.code?.startsWith("4."))
      .reduce((sum, tx) => sum + n(tx.amount), 0);
    const pct = (pesVal / receita) * 100;
    return result(ind, pct, `${formatPercent(pct)} da receita é comprometido com pessoal (${formatBRL(pesVal)} de ${formatBRL(receita)}).`);
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

    const allTx = await getAllCompletedTransactionsUntil(companyId, range.end);
    const receitas = allTx
      .filter((tx) => tx.tipo_transacao === "INCOME")
      .reduce((sum, tx) => sum + n(tx.amount), 0);
    const despesas = allTx
      .filter((tx) => tx.tipo_transacao === "EXPENSE")
      .reduce((sum, tx) => sum + n(tx.amount), 0);
    const saldo = receitas - despesas;
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

    // Saldo acumulado usando data efetiva
    const allTx = await getAllCompletedTransactionsUntil(companyId, range.end);
    const receitas = allTx
      .filter((tx) => tx.tipo_transacao === "INCOME")
      .reduce((sum, tx) => sum + n(tx.amount), 0);
    const despesasAcum = allTx
      .filter((tx) => tx.tipo_transacao === "EXPENSE")
      .reduce((sum, tx) => sum + n(tx.amount), 0);
    const saldo = receitas - despesasAcum;

    // Média de despesas dos últimos 3 meses usando data efetiva
    const threeMonthsAgo = new Date(range.start);
    threeMonthsAgo.setUTCMonth(threeMonthsAgo.getUTCMonth() - 3);
    const range3m: MonthRange = { start: threeMonthsAgo, end: range.end };
    const tx3m = await getCompletedTransactionsEffective(companyId, range3m);
    const despesas3m = tx3m
      .filter((tx) => tx.tipo_transacao === "EXPENSE")
      .reduce((sum, tx) => sum + n(tx.amount), 0);
    const mediaDespesas = despesas3m / 3;

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
    const total = n(result_._sum.amount);
    return result(ind, total, `O total de despesas pendentes (já lançadas mas não pagas) é de ${formatBRL(total)}.`);
  },

  async recebiveis_futuros(companyId, _month) {
    const ind = getIndicatorById("ind_recebiveis_futuros")!;
    const result_ = await prisma.transaction.aggregate({
      where: { companyId, tipo_transacao: "INCOME", status: "PENDING" },
      _sum: { amount: true },
    });
    const total = n(result_._sum.amount);
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
    const total = n(result_._sum.amount);
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
    const total = n(result_._sum.amount);
    return result(ind, total, `O total de pagamentos em atraso (vencidos e não pagos) é de ${formatBRL(total)}.`);
  },

  // ── FORNECEDORES E CLIENTES ──

  async ciclo_caixa(companyId, month) {
    const ind = getIndicatorById("ind_ciclo_caixa")!;
    const [recebimentos, pagamentos] = await Promise.all([
      getAverageSettlementDays(companyId, month, "INCOME"),
      getAverageSettlementDays(companyId, month, "EXPENSE"),
    ]);
    if (recebimentos.average === null || pagamentos.average === null) {
      return unavailable(ind, "Sem recebimentos e pagamentos concluídos com data real no mês para calcular o ciclo de caixa.");
    }
    const pmr = recebimentos.average;
    const pmp = pagamentos.average;
    const ciclo = pmr - pmp;
    return result(ind, ciclo, `O ciclo de caixa é de ${Math.round(ciclo)} dias (recebe em ${Math.round(pmr)} dias e paga em ${Math.round(pmp)} dias, considerando ${recebimentos.count} recebimento(s) e ${pagamentos.count} pagamento(s) concluído(s) no mês). ${ciclo > 0 ? "A empresa paga antes de receber, o que pressiona o caixa." : "A empresa recebe antes de pagar, o que é positivo para o caixa."}`);
  },

  async pmr(companyId, month) {
    const ind = getIndicatorById("ind_pmr")!;
    const recebimentos = await getAverageSettlementDays(companyId, month, "INCOME");
    if (recebimentos.average === null) {
      return unavailable(ind, "Sem recebimentos concluídos com data real no mês para calcular o PMR.");
    }
    const pmr = recebimentos.average;
    return result(ind, pmr, `Em média, seus clientes levam ${Math.round(pmr)} dias para pagar, considerando ${recebimentos.count} recebimento(s) concluído(s) no mês.`);
  },

  async pmp(companyId, month) {
    const ind = getIndicatorById("ind_pmp")!;
    const pagamentos = await getAverageSettlementDays(companyId, month, "EXPENSE");
    if (pagamentos.average === null) {
      return unavailable(ind, "Sem pagamentos concluídos com data real no mês para calcular o PMP.");
    }
    const pmp = pagamentos.average;
    return result(ind, pmp, `Em média, você leva ${Math.round(pmp)} dias para pagar seus fornecedores, considerando ${pagamentos.count} pagamento(s) concluído(s) no mês.`);
  },

  async maior_fornecedor(companyId, month) {
    const ind = getIndicatorById("ind_maior_fornecedor")!;
    const range = parseMonth(month);
    const transactions = await getCompletedTransactionsEffective(companyId, range);

    const despesas = transactions.filter((tx) => tx.tipo_transacao === "EXPENSE" && tx.counterparty);
    if (despesas.length === 0) return unavailable(ind, "Sem despesas com fornecedores identificados no mês.");

    // Agrupar por counterparty
    const cpMap = new Map<string, { name: string; total: number }>();
    despesas.forEach((tx) => {
      const cpId = tx.counterparty!.id;
      const existing = cpMap.get(cpId);
      if (existing) {
        existing.total += n(tx.amount);
      } else {
        cpMap.set(cpId, { name: tx.counterparty!.name, total: n(tx.amount) });
      }
    });

    const sorted = Array.from(cpMap.values()).sort((a, b) => b.total - a.total);
    const maior = sorted[0];
    return textResult(ind, `${maior.name}: ${formatBRL(maior.total)}`, `O fornecedor que mais recebeu pagamentos no mês foi ${maior.name}, com ${formatBRL(maior.total)}.`);
  },

  async maior_cliente(companyId, month) {
    const ind = getIndicatorById("ind_maior_cliente")!;
    const range = parseMonth(month);
    const transactions = await getCompletedTransactionsEffective(companyId, range);

    const receitas = transactions.filter((tx) => tx.tipo_transacao === "INCOME" && tx.counterparty);
    if (receitas.length === 0) return unavailable(ind, "Sem receitas com clientes identificados no mês.");

    // Agrupar por counterparty
    const cpMap = new Map<string, { name: string; total: number }>();
    receitas.forEach((tx) => {
      const cpId = tx.counterparty!.id;
      const existing = cpMap.get(cpId);
      if (existing) {
        existing.total += n(tx.amount);
      } else {
        cpMap.set(cpId, { name: tx.counterparty!.name, total: n(tx.amount) });
      }
    });

    const sorted = Array.from(cpMap.values()).sort((a, b) => b.total - a.total);
    const maior = sorted[0];
    return textResult(ind, `${maior.name}: ${formatBRL(maior.total)}`, `O cliente que mais gerou receita no mês foi ${maior.name}, com ${formatBRL(maior.total)}.`);
  },

  async concentracao_clientes(companyId, month) {
    const ind = getIndicatorById("ind_concentracao_clientes")!;
    const range = parseMonth(month);
    const transactions = await getCompletedTransactionsEffective(companyId, range);

    const receitaTotal = transactions
      .filter((tx) => tx.tipo_transacao === "INCOME")
      .reduce((sum, tx) => sum + n(tx.amount), 0);
    if (receitaTotal === 0) return unavailable(ind, "Sem receita no mês.");

    const receitas = transactions.filter((tx) => tx.tipo_transacao === "INCOME" && tx.counterparty);
    if (receitas.length === 0) return unavailable(ind, "Sem receitas com clientes identificados.");

    // Agrupar por counterparty
    const cpMap = new Map<string, number>();
    receitas.forEach((tx) => {
      const cpId = tx.counterparty!.id;
      cpMap.set(cpId, (cpMap.get(cpId) || 0) + n(tx.amount));
    });

    const maiorCliente = Math.max(...Array.from(cpMap.values()));
    const pct = (maiorCliente / receitaTotal) * 100;
    const alerta = pct > 30 ? " ⚠️ Acima de 30% indica risco de concentração." : "";
    return result(ind, pct, `O maior cliente representa ${formatPercent(pct)} da receita total.${alerta}`);
  },

  async fornecedores_atraso(companyId, month) {
    const ind = getIndicatorById("ind_fornecedores_atraso")!;
    const range = parseMonth(month);
    const completedTransactions = await getCompletedTransactionsEffective(companyId, range);
    const lateSupplierIds = new Set<string>();

    completedTransactions
      .filter((tx) => tx.tipo_transacao === "EXPENSE" && tx.detail?.dueDate && tx.detail?.paymentDate)
      .forEach((tx) => {
        const supplierId = getCounterpartyId(tx);
        if (!supplierId) return;
        const dueDate = new Date(tx.detail!.dueDate!);
        const paymentDate = new Date(tx.detail!.paymentDate!);
        if (paymentDate > dueDate) lateSupplierIds.add(supplierId);
      });

    const openLateTransactions = await prisma.transaction.findMany({
      where: {
        companyId,
        tipo_transacao: "EXPENSE",
        status: { in: ["PENDING", "OVERDUE"] },
        detail: { dueDate: { lt: range.end }, paymentDate: null },
      },
      include: { detail: true, counterparty: true },
    });

    openLateTransactions.forEach((tx) => {
      const supplierId = getCounterpartyId(tx);
      if (supplierId) lateSupplierIds.add(supplierId);
    });

    const count = lateSupplierIds.size;
    return result(ind, count, `${count} fornecedor(es) tiveram pagamentos atrasados ou vencidos em aberto até o fim do mês de referência.`);
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
    const transactions = await getCompletedTransactionsEffective(companyId, range);

    const receitas = transactions.filter((tx) => tx.tipo_transacao === "INCOME");
    if (receitas.length === 0) return unavailable(ind, "Sem receitas no mês.");
    const total = receitas.reduce((sum, tx) => sum + n(tx.amount), 0);
    const avg = total / receitas.length;
    return result(ind, avg, `O valor médio de cada receita no mês foi de ${formatBRL(avg)} (${receitas.length} transações).`);
  },

  async ticket_medio_despesa(companyId, month) {
    const ind = getIndicatorById("ind_ticket_medio_despesa")!;
    const range = parseMonth(month);
    const transactions = await getCompletedTransactionsEffective(companyId, range);

    const despesas = transactions.filter((tx) => tx.tipo_transacao === "EXPENSE");
    if (despesas.length === 0) return unavailable(ind, "Sem despesas no mês.");
    const total = despesas.reduce((sum, tx) => sum + n(tx.amount), 0);
    const avg = total / despesas.length;
    return result(ind, avg, `O valor médio de cada despesa no mês foi de ${formatBRL(avg)} (${despesas.length} transações).`);
  },

  async qtd_transacoes(companyId, month) {
    const ind = getIndicatorById("ind_qtd_transacoes")!;
    const range = parseMonth(month);
    const transactions = await getCompletedTransactionsEffective(companyId, range);
    const count = transactions.length;
    return result(ind, count, `Foram registradas ${count} transações concluídas no mês.`);
  },

  async juros_pagos(companyId, month) {
    const ind = getIndicatorById("ind_juros_pagos")!;
    const range = parseMonth(month);
    const transactions = await getCompletedTransactionsEffective(companyId, range);

    const total = transactions
      .filter((tx) => tx.detail?.interest)
      .reduce((sum, tx) => sum + n(tx.detail!.interest), 0);
    return result(ind, total, `O total de juros pagos no mês foi de ${formatBRL(total)}.`);
  },

  async descontos_concedidos(companyId, month) {
    const ind = getIndicatorById("ind_descontos_concedidos")!;
    const range = parseMonth(month);
    const transactions = await getCompletedTransactionsEffective(companyId, range);

    const total = transactions
      .filter((tx) => tx.tipo_transacao === "INCOME" && tx.detail?.discount)
      .reduce((sum, tx) => sum + n(tx.detail!.discount), 0);
    return result(ind, total, `O total de descontos concedidos a clientes no mês foi de ${formatBRL(total)}.`);
  },

  async descontos_obtidos(companyId, month) {
    const ind = getIndicatorById("ind_descontos_obtidos")!;
    const range = parseMonth(month);
    const transactions = await getCompletedTransactionsEffective(companyId, range);

    const total = transactions
      .filter((tx) => tx.tipo_transacao === "EXPENSE" && tx.detail?.discount)
      .reduce((sum, tx) => sum + n(tx.detail!.discount), 0);
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
// CÁLCULO DE INDICADORES CUSTOMIZADOS VIA IA
// ============================================

/**
 * Gera um resumo financeiro do mês para enviar à IA.
 * Inclui receitas, despesas por categoria, margens, etc.
 */
async function buildFinancialSummary(companyId: string, month: string): Promise<string> {
  const range = parseMonth(month);
  const transactions = await getCompletedTransactionsEffective(companyId, range);

  const receitas = transactions.filter((tx) => tx.tipo_transacao === "INCOME");
  const despesas = transactions.filter((tx) => tx.tipo_transacao === "EXPENSE");

  const totalReceita = receitas.reduce((sum, tx) => sum + n(tx.amount), 0);
  const totalDespesa = despesas.reduce((sum, tx) => sum + n(tx.amount), 0);
  const lucroLiquido = totalReceita - totalDespesa;

  // Agrupar despesas por categoria
  const catMap = new Map<string, { name: string; code: string; total: number }>();
  despesas.forEach((tx) => {
    if (tx.category) {
      const key = tx.category.code;
      const existing = catMap.get(key);
      if (existing) {
        existing.total += n(tx.amount);
      } else {
        catMap.set(key, { name: tx.category.name, code: tx.category.code, total: n(tx.amount) });
      }
    }
  });
  const despesasPorCategoria = Array.from(catMap.values())
    .sort((a, b) => b.total - a.total)
    .map((c) => `  - ${c.code} ${c.name}: ${formatBRL(c.total)}`)
    .join("\n");

  // Agrupar receitas por contraparte
  const clienteMap = new Map<string, { name: string; total: number }>();
  receitas.forEach((tx) => {
    if (tx.counterparty) {
      const key = tx.counterparty.id;
      const existing = clienteMap.get(key);
      if (existing) {
        existing.total += n(tx.amount);
      } else {
        clienteMap.set(key, { name: tx.counterparty.name, total: n(tx.amount) });
      }
    }
  });
  const receitasPorCliente = Array.from(clienteMap.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)
    .map((c) => `  - ${c.name}: ${formatBRL(c.total)}`)
    .join("\n");

  // Agrupar despesas por contraparte (fornecedores)
  const fornecedorMap = new Map<string, { name: string; total: number }>();
  despesas.forEach((tx) => {
    if (tx.counterparty) {
      const key = tx.counterparty.id;
      const existing = fornecedorMap.get(key);
      if (existing) {
        existing.total += n(tx.amount);
      } else {
        fornecedorMap.set(key, { name: tx.counterparty.name, total: n(tx.amount) });
      }
    }
  });
  const despesasPorFornecedor = Array.from(fornecedorMap.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)
    .map((c) => `  - ${c.name}: ${formatBRL(c.total)}`)
    .join("\n");

  // ── Pagamentos pendentes e atrasados ──
  const now = new Date();
  const pendingTransactions = await prisma.transaction.findMany({
    where: {
      companyId,
      status: "PENDING",
      tipo_transacao: "EXPENSE",
    },
    include: { category: true, counterparty: true, detail: true },
  });

  const atrasados = pendingTransactions.filter((tx) => {
    const dueDate = tx.detail?.dueDate || tx.date;
    return new Date(dueDate) < now;
  });
  const totalAtrasado = atrasados.reduce((sum, tx) => sum + n(tx.amount), 0);
  const atrasadosDetail = atrasados
    .sort((a, b) => n(b.amount) - n(a.amount))
    .slice(0, 15)
    .map((tx) => {
      const dueDate = tx.detail?.dueDate || tx.date;
      const dueDateStr = new Date(dueDate).toLocaleDateString("pt-BR");
      const contraparte = tx.counterparty?.name || "Sem contraparte";
      const categoria = tx.category?.name || "Sem categoria";
      return `  - ${tx.description} | ${formatBRL(n(tx.amount))} | Vencimento: ${dueDateStr} | ${contraparte} | ${categoria}`;
    })
    .join("\n");

  const pendentesNaoAtrasados = pendingTransactions.filter((tx) => {
    const dueDate = tx.detail?.dueDate || tx.date;
    return new Date(dueDate) >= now;
  });
  const totalPendente = pendentesNaoAtrasados.reduce((sum, tx) => sum + n(tx.amount), 0);
  const pendentesDetail = pendentesNaoAtrasados
    .sort((a, b) => {
      const dateA = a.detail?.dueDate || a.date;
      const dateB = b.detail?.dueDate || b.date;
      return new Date(dateA).getTime() - new Date(dateB).getTime();
    })
    .slice(0, 15)
    .map((tx) => {
      const dueDate = tx.detail?.dueDate || tx.date;
      const dueDateStr = new Date(dueDate).toLocaleDateString("pt-BR");
      const contraparte = tx.counterparty?.name || "Sem contraparte";
      const categoria = tx.category?.name || "Sem categoria";
      return `  - ${tx.description} | ${formatBRL(n(tx.amount))} | Vencimento: ${dueDateStr} | ${contraparte} | ${categoria}`;
    })
    .join("\n");

  // ── Receitas pendentes (a receber) ──
  const pendingIncome = await prisma.transaction.findMany({
    where: {
      companyId,
      status: "PENDING",
      tipo_transacao: "INCOME",
    },
    include: { counterparty: true, detail: true },
  });

  const recebiveisAtrasados = pendingIncome.filter((tx) => {
    const dueDate = tx.detail?.dueDate || tx.date;
    return new Date(dueDate) < now;
  });
  const totalRecebiveisAtrasados = recebiveisAtrasados.reduce((sum, tx) => sum + n(tx.amount), 0);
  const recebiveisAtrasadosDetail = recebiveisAtrasados
    .sort((a, b) => n(b.amount) - n(a.amount))
    .slice(0, 10)
    .map((tx) => {
      const dueDate = tx.detail?.dueDate || tx.date;
      const dueDateStr = new Date(dueDate).toLocaleDateString("pt-BR");
      const contraparte = tx.counterparty?.name || "Sem contraparte";
      return `  - ${tx.description} | ${formatBRL(n(tx.amount))} | Vencimento: ${dueDateStr} | ${contraparte}`;
    })
    .join("\n");

  const [year, m] = month.split("-");
  const monthNames = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
  const monthLabel = `${monthNames[parseInt(m) - 1]} de ${year}`;

  return `=== RESUMO FINANCEIRO — ${monthLabel} ===

Receita Total: ${formatBRL(totalReceita)} (${receitas.length} transações)
Despesa Total: ${formatBRL(totalDespesa)} (${despesas.length} transações)
Lucro Líquido: ${formatBRL(lucroLiquido)}
Margem Líquida: ${totalReceita > 0 ? formatPercent((lucroLiquido / totalReceita) * 100) : "N/A"}

--- Despesas por Categoria ---
${despesasPorCategoria || "  (sem dados)"}

--- Top 10 Clientes (Receita) ---
${receitasPorCliente || "  (sem dados)"}

--- Top 10 Fornecedores (Despesa) ---
${despesasPorFornecedor || "  (sem dados)"}

--- Pagamentos ATRASADOS (vencidos e não pagos) ---
Total atrasado: ${formatBRL(totalAtrasado)} (${atrasados.length} transações)
${atrasadosDetail || "  (nenhum pagamento atrasado)"}

--- Pagamentos PENDENTES (a vencer) ---
Total pendente: ${formatBRL(totalPendente)} (${pendentesNaoAtrasados.length} transações)
${pendentesDetail || "  (nenhum pagamento pendente)"}

--- Recebíveis ATRASADOS (clientes que não pagaram) ---
Total a receber atrasado: ${formatBRL(totalRecebiveisAtrasados)} (${recebiveisAtrasados.length} transações)
${recebiveisAtrasadosDetail || "  (nenhum recebível atrasado)"}`;
}

/**
 * Calcula um indicador customizado usando a IA.
 * Envia o resumo financeiro + a fórmula do indicador para a IA interpretar.
 */
async function calculateCustomIndicator(
  companyId: string,
  month: string,
  customIndicator: { id: string; name: string; description: string; formula: string; createdByUserId: string }
): Promise<CalculatedIndicator> {
  try {
    // Buscar contexto da empresa para o chatWithTools
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { sector: true, activity: true },
    });

    // Montar o resumo básico como baseContext para o chatWithTools
    const summary = await buildFinancialSummary(companyId, month);

    const [year, m] = month.split("-");
    const monthNames = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
    const monthLabel = `${monthNames[parseInt(m) - 1]} de ${year}`;

    // Usar chatWithTools para que a IA tenha acesso às tools (buscar_transacoes, obter_contas_pendentes, etc.)
    const userMessage = `Preciso que você calcule o seguinte indicador personalizado.
O relatório é referente a ${monthLabel}, mas ATENÇÃO às regras abaixo.

INDICADOR: ${customIndicator.name}
DESCRIÇÃO: ${customIndicator.description}
FÓRMULA: ${customIndicator.formula}

REGRAS IMPORTANTES:
- Use as ferramentas disponíveis para buscar os dados reais necessários. NÃO invente dados.
- Para indicadores de ATRASO, PENDÊNCIA, INADIMPLÊNCIA ou similares: considere TODOS os registros pendentes/atrasados ACUMULADOS até a data atual, independente do mês de vencimento. Exemplo: "Custos Atrasados" deve somar TODAS as despesas pendentes com vencimento no passado (janeiro, fevereiro, março, etc.), não apenas as do mês do relatório.
- Para indicadores de FLUXO (receita, despesa, margem, etc.): use apenas os dados do mês de referência (${monthLabel}).
- O resumo financeiro abaixo já contém a seção "Pagamentos ATRASADOS" com o total acumulado — use esses dados.

Após calcular, retorne APENAS um JSON com este formato exato:
{
  "value": "valor formatado para exibição (ex: R$ 12.345,67 ou 23,5% ou 15 dias)",
  "rawValue": 12345.67,
  "description": "Texto explicativo curto em linguagem simples com os valores reais encontrados",
  "unit": "BRL" ou "PERCENT" ou "DAYS" ou "COUNT" ou "TEXT",
  "available": true ou false,
  "unavailableReason": "Se não disponível, explique por quê"
}

Se os dados não forem suficientes para calcular o indicador, retorne available: false com uma explicação clara.`;

    const response = await chatWithTools(
      customIndicator.createdByUserId,
      userMessage,
      companyId,
      summary, // baseContext com resumo financeiro
      [],      // sem histórico de chat
      company ? { sector: company.sector, activity: company.activity } : undefined
    );

    // Extrair JSON da resposta
    const jsonMatch = response.message.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Se não retornou JSON, tentar usar a resposta como texto
      return {
        id: customIndicator.id,
        name: customIndicator.name,
        value: response.message.slice(0, 100),
        rawValue: null,
        description: response.message,
        unit: "TEXT",
        available: true,
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      id: customIndicator.id,
      name: customIndicator.name,
      value: parsed.available !== false ? String(parsed.value) : "Dado indisponível",
      rawValue: parsed.rawValue ?? null,
      description: parsed.description || customIndicator.description,
      unit: parsed.unit || "TEXT",
      available: parsed.available !== false,
      unavailableReason: parsed.available === false ? parsed.unavailableReason : undefined,
    };
  } catch (error) {
    console.error(`Erro ao calcular indicador custom ${customIndicator.id}:`, error);
    return {
      id: customIndicator.id,
      name: customIndicator.name,
      value: "Erro ao calcular",
      rawValue: null,
      description: "Ocorreu um erro ao calcular este indicador personalizado.",
      unit: "TEXT",
      available: false,
      unavailableReason: "Erro interno ao calcular indicador personalizado.",
    };
  }
}

// ============================================
// FUNÇÃO PRINCIPAL: Calcular indicadores selecionados
// Suporta tanto indicadores padrão quanto customizados.
// ============================================

export async function calculateIndicators(
  companyId: string,
  month: string,
  indicatorIds: string[]
): Promise<CalculatedIndicator[]> {
  const results: CalculatedIndicator[] = [];

  // Pré-carregar indicadores customizados da empresa para evitar N+1 queries
  const customIndicators = await prisma.customIndicator.findMany({
    where: { companyId, isActive: true },
  });
  const customMap = new Map(customIndicators.map((ci) => [ci.id, ci]));

  for (const id of indicatorIds) {
    // 1. Tentar como indicador padrão
    const indicator = getIndicatorById(id);
    if (indicator) {
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
      continue;
    }

    // 2. Tentar como indicador customizado (do banco)
    const custom = customMap.get(id);
    if (custom) {
      const calculated = await calculateCustomIndicator(companyId, month, {
        id: custom.id,
        name: custom.name,
        description: custom.description,
        formula: custom.formula,
        createdByUserId: custom.createdByUserId,
      });
      results.push(calculated);
      continue;
    }

    // 3. Indicador não encontrado em nenhum lugar
    results.push({
      id,
      name: id,
      value: "Indicador não encontrado",
      rawValue: null,
      description: "Este indicador não existe no sistema.",
      unit: "TEXT",
      available: false,
      unavailableReason: "Indicador não encontrado.",
    });
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
