/**
 * CAMADA 2 — TEMPLATES DE TEXTO (sem IA)
 * 
 * Cada tipo de alerta tem um template pré-escrito com variáveis
 * que são preenchidas automaticamente. Gera texto legível sem IA.
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
    case "EXPENSE_SPIKE":
      return `Seu gasto com ${d.category} foi de ${formatCurrency(d.currentValue)} em ${formatMonth(d.currentMonth)}, ${d.variation}% acima da média dos últimos meses (${formatCurrency(d.average)}). Esse aumento pode indicar reajustes de preço, consumo acima do normal ou cobranças extras. Recomendamos verificar as faturas detalhadas dessa categoria.`;

    case "EXPENSE_DROP":
      return `Boa notícia! Seu gasto com ${d.category} caiu ${Math.abs(d.variation)}% em ${formatMonth(d.currentMonth)}, ficando em ${formatCurrency(d.currentValue)} contra a média de ${formatCurrency(d.average)}. Isso representa uma economia de ${formatCurrency(d.savings)} neste mês. Verifique se essa redução é sustentável ou se foi pontual.`;

    case "NEGOTIATION_OPPORTUNITY":
      return `Você paga ${d.supplier} há ${d.monthsConsecutive} meses consecutivos, com valor médio de ${formatCurrency(d.avgMonthlyValue)}/mês. Com esse volume e recorrência, você tem poder de barganha para negociar um desconto de ${d.discountRange}. Isso representaria uma economia de ${formatCurrency(d.estimatedDiscount.min)} a ${formatCurrency(d.estimatedDiscount.max)} por ano.`;

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
