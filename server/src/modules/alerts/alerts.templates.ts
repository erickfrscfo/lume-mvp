/**
 * CAMADA 2 — TEMPLATES DE TEXTO INTELIGENTES (sem IA)
 * 
 * Cada tipo de alerta tem um template pré-escrito com variáveis
 * que são preenchidas automaticamente. Gera texto legível sem IA.
 * 
 * Templates diferenciados por NATUREZA da conta:
 * - Negociáveis: sugere renegociação
 * - Consumo: sugere economia de consumo
 * - Folha: sugere otimização de estrutura
 * - Perdas: sugere prevenção
 */

import { RawAlert } from "./alerts.detector.js";

const MONTH_NAMES: Record<string, string> = {
  "01": "Janeiro", "02": "Fevereiro", "03": "Março",
  "04": "Abril", "05": "Maio", "06": "Junho",
  "07": "Julho", "08": "Agosto", "09": "Setembro",
  "10": "Outubro", "11": "Novembro", "12": "Dezembro",
};

function formatMonth(monthKey: string): string {
  const [year, month] = monthKey.split("-");
  return `${MONTH_NAMES[month] || month}/${year}`;
}

function formatCurrency(value: number): string {
  return `R$ ${Math.abs(value).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function applyTemplate(alert: RawAlert): string {
  const d = alert.data;

  switch (alert.type) {
    // ---- Picos e quedas de despesa por categoria ----
    case "EXPENSE_SPIKE":
      return `Seu gasto com ${d.category} foi de ${formatCurrency(d.currentValue)} em ${formatMonth(d.currentMonth)}, ${d.variation}% acima da média dos últimos 3 meses (${formatCurrency(d.average)}). Esse aumento pode indicar reajustes de preço, consumo acima do normal ou cobranças extras. Recomendamos verificar as faturas detalhadas dessa categoria.`;

    case "EXPENSE_DROP":
      return `Boa notícia! Seu gasto com ${d.category} caiu ${Math.abs(d.variation)}% em ${formatMonth(d.currentMonth)}, ficando em ${formatCurrency(d.currentValue)} contra a média de ${formatCurrency(d.average)}. Isso representa uma economia de ${formatCurrency(d.savings)} neste mês. Verifique se essa redução é sustentável ou se foi pontual.`;

    // ---- Oportunidades inteligentes por natureza ----
    case "NEGOTIATION_OPPORTUNITY":
      return `Você paga "${d.supplier}" há ${d.monthsConsecutive} meses consecutivos, com valor médio de ${formatCurrency(d.avgMonthlyValue)}/mês. ${d.recommendation || `Com esse volume e recorrência, você tem poder de barganha para negociar um desconto.`}`;

    case "COST_OPTIMIZATION":
      return d.recommendation || `Oportunidade de otimização identificada em "${d.supplier}" com média de ${formatCurrency(d.avgMonthlyValue)}/mês.`;

    // ---- Tendências críticas ----
    case "MARGIN_DECLINE":
      return `Atenção: sua margem de lucro está caindo há 3 meses consecutivos. Era ${d.previousMargin}% e agora está em ${d.currentMargin}% — uma queda de ${d.totalDecline} pontos percentuais. Isso significa que suas despesas estão crescendo mais rápido que sua receita. Revise os custos que mais cresceram e avalie se é possível repassar preços.`;

    case "REVENUE_DECLINE_TREND":
      return `Alerta crítico: sua receita está caindo há 3 meses consecutivos, com queda total de ${Math.abs(d.totalDecline)}%. Receita atual: ${formatCurrency(d.currentRevenue)} vs ${formatCurrency(d.threeMonthsAgoRevenue)} há 3 meses. Investigue as causas: perda de clientes? Sazonalidade? Concorrência? Ação urgente necessária na estratégia comercial.`;

    case "EXPENSE_OUTPACING_REVENUE":
      return `Suas despesas cresceram ${d.expenseChange}% enquanto a receita ${d.revenueChange > 0 ? 'cresceu apenas' : 'caiu'} ${Math.abs(d.revenueChange)}%. Esse desequilíbrio de ${d.gap} pontos percentuais está comprimindo sua margem. Revise os maiores aumentos de custo e avalie quais podem ser cortados ou adiados.`;

    // ---- Fornecedor aumentou preço ----
    case "SUPPLIER_PRICE_INCREASE":
      return `"${d.supplier}" aumentou ${d.variation}% este mês: de ${formatCurrency(d.avgValue)}/mês (média) para ${formatCurrency(d.currentValue)}. Isso representa um aumento de ${formatCurrency(d.increase)}. Verifique se houve reajuste contratual, cobrança extra ou mudança no volume. Considere solicitar cotações de concorrentes.`;

    // ---- Concentração de custos ----
    case "COST_CONCENTRATION":
      return `A categoria "${d.categoryName}" concentra ${d.percentage}% de todas as suas despesas (${formatCurrency(d.categoryValue)} de ${formatCurrency(d.totalExpenses)}). Essa concentração representa um risco: qualquer aumento nessa categoria terá impacto significativo no resultado. Avalie se é possível diversificar fornecedores ou renegociar condições.`;

    // ---- Sazonais (mantidos do original) ----
    case "SEASONAL_ANOMALY":
      if (d.metric === "revenue") {
        const comparison = d.comparisonType === "average"
          ? `da média histórica (${formatCurrency(d.averageValue)})`
          : `do mesmo período do ano passado (${formatCurrency(d.lastYearValue)})`;
        return `Sua receita em ${formatMonth(d.currentMonth)} foi de ${formatCurrency(d.currentValue)}, ${Math.abs(d.variation)}% abaixo ${comparison}. Essa queda pode indicar sazonalidade, perda de clientes ou mudança no mercado. Recomendamos investigar as causas e ajustar a estratégia comercial.`;
      } else {
        const comparison = d.comparisonType === "average"
          ? `da média histórica (${formatCurrency(d.averageValue)})`
          : `do mesmo período do ano passado (${formatCurrency(d.lastYearValue)})`;
        return `Suas despesas em ${formatMonth(d.currentMonth)} foram de ${formatCurrency(d.currentValue)}, ${d.variation}% acima ${comparison}. Verifique se houve gastos extraordinários ou se é uma tendência que precisa de atenção.`;
      }

    case "SEASONAL_OPPORTUNITY":
      return `Ótima notícia! Sua receita em ${formatMonth(d.currentMonth)} foi de ${formatCurrency(d.currentValue)}, ${d.variation}% acima do mesmo período do ano passado (${formatCurrency(d.lastYearValue)}). Isso indica crescimento real do negócio. Aproveite esse momento positivo para reforçar o caixa e considerar investimentos estratégicos.`;

    default:
      return `Alerta identificado: ${alert.title}`;
  }
}
