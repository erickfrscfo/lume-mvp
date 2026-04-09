/**
 * indicators.ts
 * 
 * Registry de todos os indicadores padrão disponíveis para o relatório dinâmico.
 * Cada indicador tem: id, nome, categoria, texto explicativo, unidade e tipo de cálculo.
 * 
 * Caminho no projeto: server/modules/report/indicators.ts
 */

// ============================================
// TIPOS
// ============================================

export type IndicatorUnit = "BRL" | "PERCENT" | "DAYS" | "COUNT" | "TEXT";

export type IndicatorCategory =
  | "RENTABILIDADE"
  | "CUSTOS"
  | "FLUXO_CAIXA"
  | "FORNECEDORES_CLIENTES"
  | "OPERACAO";

export interface StandardIndicator {
  id: string;
  name: string;
  category: IndicatorCategory;
  description: string; // texto explicativo em linguagem acessível
  unit: IndicatorUnit;
  /** Chave usada pelo report.service.ts para saber qual cálculo executar */
  calculationKey: string;
}

// ============================================
// CATEGORIAS (para exibição no frontend)
// ============================================

export const INDICATOR_CATEGORIES: Record<IndicatorCategory, { label: string; description: string }> = {
  RENTABILIDADE: {
    label: "Rentabilidade",
    description: "Indicadores de margem, lucro e retorno do negócio",
  },
  CUSTOS: {
    label: "Estrutura de Custos",
    description: "Composição e evolução dos gastos da empresa",
  },
  FLUXO_CAIXA: {
    label: "Fluxo de Caixa",
    description: "Entradas, saídas, saldo e projeções de caixa",
  },
  FORNECEDORES_CLIENTES: {
    label: "Fornecedores e Clientes",
    description: "Prazos, concentração e relacionamento com contrapartes",
  },
  OPERACAO: {
    label: "Operação e Tendência",
    description: "Volume de transações, tickets médios e alertas",
  },
};

// ============================================
// INDICADORES PADRÃO (41 total)
// ============================================

export const STANDARD_INDICATORS: StandardIndicator[] = [
  // ── RENTABILIDADE (7 indicadores) ──
  {
    id: "ind_margem_bruta",
    name: "Margem Bruta",
    category: "RENTABILIDADE",
    description: "Percentual da receita que sobra após pagar os custos diretamente ligados ao serviço ou produto.",
    unit: "PERCENT",
    calculationKey: "margem_bruta",
  },
  {
    id: "ind_margem_liquida",
    name: "Margem Líquida",
    category: "RENTABILIDADE",
    description: "Percentual da receita que sobra após pagar absolutamente todas as despesas.",
    unit: "PERCENT",
    calculationKey: "margem_liquida",
  },
  {
    id: "ind_lucro_bruto",
    name: "Lucro Bruto",
    category: "RENTABILIDADE",
    description: "É o que sobra da receita após pagar os custos diretamente ligados ao serviço ou produto.",
    unit: "BRL",
    calculationKey: "lucro_bruto",
  },
  {
    id: "ind_lucro_liquido",
    name: "Lucro Líquido",
    category: "RENTABILIDADE",
    description: "É o resultado final do mês: o que sobrou depois de pagar absolutamente tudo.",
    unit: "BRL",
    calculationKey: "lucro_liquido",
  },
  {
    id: "ind_ebitda",
    name: "EBITDA Aproximado",
    category: "RENTABILIDADE",
    description: "Mostra o resultado operacional antes de juros e impostos — útil para comparar com outras empresas.",
    unit: "BRL",
    calculationKey: "ebitda",
  },
  {
    id: "ind_ponto_equilibrio",
    name: "Ponto de Equilíbrio",
    category: "RENTABILIDADE",
    description: "É o faturamento mínimo que a empresa precisa para cobrir todos os custos e não ter prejuízo.",
    unit: "BRL",
    calculationKey: "ponto_equilibrio",
  },
  {
    id: "ind_taxa_crescimento",
    name: "Taxa de Crescimento da Receita",
    category: "RENTABILIDADE",
    description: "Quanto a receita cresceu (ou caiu) em relação ao mês anterior.",
    unit: "PERCENT",
    calculationKey: "taxa_crescimento",
  },

  // ── ESTRUTURA DE CUSTOS (10 indicadores) ──
  {
    id: "ind_custos_totais",
    name: "Custos e Despesas Totais",
    category: "CUSTOS",
    description: "Soma de todos os gastos pagos no mês.",
    unit: "BRL",
    calculationKey: "custos_totais",
  },
  {
    id: "ind_variacao_custos",
    name: "Variação de Custos",
    category: "CUSTOS",
    description: "Quanto os custos aumentaram ou diminuíram em relação ao mês anterior.",
    unit: "PERCENT",
    calculationKey: "variacao_custos",
  },
  {
    id: "ind_pct_fixos",
    name: "% Custos Fixos",
    category: "CUSTOS",
    description: "Quanto dos seus gastos são fixos — aqueles que existem mesmo sem faturar.",
    unit: "PERCENT",
    calculationKey: "pct_fixos",
  },
  {
    id: "ind_pct_variaveis",
    name: "% Custos Variáveis",
    category: "CUSTOS",
    description: "Quanto dos seus gastos variam conforme o volume de vendas ou serviços.",
    unit: "PERCENT",
    calculationKey: "pct_variaveis",
  },
  {
    id: "ind_maior_despesa",
    name: "Maior Despesa do Mês",
    category: "CUSTOS",
    description: "O maior gasto individual do mês — vale verificar se era esperado.",
    unit: "TEXT",
    calculationKey: "maior_despesa",
  },
  {
    id: "ind_top5_categorias",
    name: "Top 5 Categorias de Despesa",
    category: "CUSTOS",
    description: "As 5 categorias que mais consumiram recursos no mês.",
    unit: "TEXT",
    calculationKey: "top5_categorias",
  },
  {
    id: "ind_impostos_totais",
    name: "Impostos Totais",
    category: "CUSTOS",
    description: "Total pago em impostos no mês.",
    unit: "BRL",
    calculationKey: "impostos_totais",
  },
  {
    id: "ind_pct_impostos",
    name: "% Impostos sobre Receita",
    category: "CUSTOS",
    description: "Quanto da receita foi consumido por impostos — a carga tributária efetiva.",
    unit: "PERCENT",
    calculationKey: "pct_impostos",
  },
  {
    id: "ind_custo_pessoal",
    name: "Custo com Pessoal",
    category: "CUSTOS",
    description: "Total gasto com folha de pagamento, encargos e benefícios.",
    unit: "BRL",
    calculationKey: "custo_pessoal",
  },
  {
    id: "ind_pct_pessoal",
    name: "% Pessoal sobre Receita",
    category: "CUSTOS",
    description: "Quanto da receita é comprometido com a equipe — um dos maiores custos para serviços.",
    unit: "PERCENT",
    calculationKey: "pct_pessoal",
  },

  // ── FLUXO DE CAIXA E LIQUIDEZ (8 indicadores) ──
  {
    id: "ind_receitas_totais",
    name: "Receitas Totais",
    category: "FLUXO_CAIXA",
    description: "Soma de todas as receitas recebidas no mês.",
    unit: "BRL",
    calculationKey: "receitas_totais",
  },
  {
    id: "ind_saldo_acumulado",
    name: "Saldo Acumulado",
    category: "FLUXO_CAIXA",
    description: "Saldo total acumulado desde o início das operações até o mês de referência.",
    unit: "BRL",
    calculationKey: "saldo_acumulado",
  },
  {
    id: "ind_fluxo_caixa_liquido",
    name: "Fluxo de Caixa Líquido do Mês",
    category: "FLUXO_CAIXA",
    description: "O resultado de caixa do mês: quanto entrou menos quanto saiu.",
    unit: "BRL",
    calculationKey: "fluxo_caixa_liquido",
  },
  {
    id: "ind_cobertura_caixa",
    name: "Cobertura de Caixa (meses)",
    category: "FLUXO_CAIXA",
    description: "Por quantos meses a empresa consegue operar com o caixa atual, sem nenhuma receita nova.",
    unit: "COUNT",
    calculationKey: "cobertura_caixa",
  },
  {
    id: "ind_comprometimento_futuro",
    name: "Comprometimento Futuro",
    category: "FLUXO_CAIXA",
    description: "Total de despesas já lançadas que ainda não foram pagas — compromissos futuros.",
    unit: "BRL",
    calculationKey: "comprometimento_futuro",
  },
  {
    id: "ind_recebiveis_futuros",
    name: "Recebíveis Futuros",
    category: "FLUXO_CAIXA",
    description: "Total de receitas já lançadas que ainda não foram recebidas.",
    unit: "BRL",
    calculationKey: "recebiveis_futuros",
  },
  {
    id: "ind_receitas_inadimplentes",
    name: "Receitas Inadimplentes",
    category: "FLUXO_CAIXA",
    description: "Total de receitas que já venceram e ainda não foram recebidas.",
    unit: "BRL",
    calculationKey: "receitas_inadimplentes",
  },
  {
    id: "ind_pagamentos_atraso",
    name: "Pagamentos em Atraso",
    category: "FLUXO_CAIXA",
    description: "Total de despesas que já venceram e ainda não foram pagas.",
    unit: "BRL",
    calculationKey: "pagamentos_atraso",
  },

  // ── FORNECEDORES E CLIENTES (8 indicadores) ──
  {
    id: "ind_ciclo_caixa",
    name: "Ciclo de Caixa",
    category: "FORNECEDORES_CLIENTES",
    description: "Diferença entre o prazo médio de recebimento e o prazo médio de pagamento. Quanto menor, melhor.",
    unit: "DAYS",
    calculationKey: "ciclo_caixa",
  },
  {
    id: "ind_pmr",
    name: "Prazo Médio de Recebimento",
    category: "FORNECEDORES_CLIENTES",
    description: "Em média, quantos dias seus clientes levam para pagar.",
    unit: "DAYS",
    calculationKey: "pmr",
  },
  {
    id: "ind_pmp",
    name: "Prazo Médio de Pagamento",
    category: "FORNECEDORES_CLIENTES",
    description: "Em média, quantos dias você leva para pagar seus fornecedores.",
    unit: "DAYS",
    calculationKey: "pmp",
  },
  {
    id: "ind_maior_fornecedor",
    name: "Maior Fornecedor",
    category: "FORNECEDORES_CLIENTES",
    description: "O fornecedor que mais recebeu pagamentos no mês.",
    unit: "TEXT",
    calculationKey: "maior_fornecedor",
  },
  {
    id: "ind_maior_cliente",
    name: "Maior Cliente",
    category: "FORNECEDORES_CLIENTES",
    description: "O cliente que mais gerou receita no mês.",
    unit: "TEXT",
    calculationKey: "maior_cliente",
  },
  {
    id: "ind_concentracao_clientes",
    name: "Concentração de Clientes",
    category: "FORNECEDORES_CLIENTES",
    description: "Quanto da receita depende do maior cliente — acima de 30% é risco de concentração.",
    unit: "PERCENT",
    calculationKey: "concentracao_clientes",
  },
  {
    id: "ind_fornecedores_atraso",
    name: "Fornecedores com Atraso",
    category: "FORNECEDORES_CLIENTES",
    description: "Quantos fornecedores tiveram pagamentos atrasados.",
    unit: "COUNT",
    calculationKey: "fornecedores_atraso",
  },
  {
    id: "ind_contrapartes_ativas",
    name: "Total de Contrapartes Ativas",
    category: "FORNECEDORES_CLIENTES",
    description: "Quantos fornecedores e clientes ativos a empresa possui.",
    unit: "COUNT",
    calculationKey: "contrapartes_ativas",
  },

  // ── OPERAÇÃO E TENDÊNCIA (7 indicadores) ──
  {
    id: "ind_ticket_medio_receita",
    name: "Ticket Médio de Receita",
    category: "OPERACAO",
    description: "Valor médio de cada entrada de receita no mês.",
    unit: "BRL",
    calculationKey: "ticket_medio_receita",
  },
  {
    id: "ind_ticket_medio_despesa",
    name: "Ticket Médio de Despesa",
    category: "OPERACAO",
    description: "Valor médio de cada saída no mês.",
    unit: "BRL",
    calculationKey: "ticket_medio_despesa",
  },
  {
    id: "ind_qtd_transacoes",
    name: "Quantidade de Transações",
    category: "OPERACAO",
    description: "Volume total de movimentações financeiras no mês.",
    unit: "COUNT",
    calculationKey: "qtd_transacoes",
  },
  {
    id: "ind_juros_pagos",
    name: "Juros Pagos",
    category: "OPERACAO",
    description: "Total de juros pagos no mês em transações com atraso ou financiamentos.",
    unit: "BRL",
    calculationKey: "juros_pagos",
  },
  {
    id: "ind_descontos_concedidos",
    name: "Descontos Concedidos",
    category: "OPERACAO",
    description: "Total de descontos dados a clientes no mês.",
    unit: "BRL",
    calculationKey: "descontos_concedidos",
  },
  {
    id: "ind_descontos_obtidos",
    name: "Descontos Obtidos",
    category: "OPERACAO",
    description: "Total de descontos obtidos de fornecedores no mês.",
    unit: "BRL",
    calculationKey: "descontos_obtidos",
  },
  {
    id: "ind_alertas_ativos",
    name: "Alertas Ativos",
    category: "OPERACAO",
    description: "Quantidade de alertas financeiros que ainda não foram lidos.",
    unit: "COUNT",
    calculationKey: "alertas_ativos",
  },
];

// ============================================
// HELPERS
// ============================================

/** Retorna todos os indicadores de uma categoria */
export function getIndicatorsByCategory(category: IndicatorCategory): StandardIndicator[] {
  return STANDARD_INDICATORS.filter((ind) => ind.category === category);
}

/** Retorna um indicador pelo ID */
export function getIndicatorById(id: string): StandardIndicator | undefined {
  return STANDARD_INDICATORS.find((ind) => ind.id === id);
}

/** Retorna todas as categorias com seus indicadores */
export function getAllCategoriesWithIndicators() {
  return Object.entries(INDICATOR_CATEGORIES).map(([key, meta]) => ({
    key: key as IndicatorCategory,
    label: meta.label,
    description: meta.description,
    indicators: getIndicatorsByCategory(key as IndicatorCategory),
  }));
}
