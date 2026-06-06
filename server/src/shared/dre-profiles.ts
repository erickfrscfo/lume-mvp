// ============================================
// DRE PROFILES — Perfis de DRE por Setor
// Define quais categorias compõem o "Custo Direto",
// quais são deduções da receita,
// quais são impostos sobre o resultado,
// e qual nomenclatura usar na interface.
//
// ESTRUTURA DO DRE:
//   Receita Bruta (1.x + 2.x)
//   (-) Deduções da Receita / Impostos sobre Faturamento
//   = Receita Líquida
//   (-) Custos Diretos / CSP / CMV / CPV (conforme directCostCodes)
//   = Lucro Bruto
//   (-) Despesas Operacionais (4.x + 5.x + 6.x + 7.x + 9.x, exceto directCost)
//   = Resultado Operacional
//   (-) IRPJ/CSLL e outros tributos sobre resultado
//   = Resultado Líquido
// ============================================

export interface DREProfile {
  sectorKey: string;
  sectorLabel: string;

  // Nomenclatura
  directCostLabel: string;   // "CMV", "CSP", "CPV", "Custo de Receita"
  grossProfitLabel: string;  // "Lucro Bruto"

  // Quais prefixos de código de categoria compõem o Custo Direto
  directCostCodes: string[];

  // Quais prefixos excluir do custo direto (mesmo se match em directCostCodes)
  excludeFromDirectCost: string[];

  // Quais prefixos de código são deduções da receita (impostos sobre faturamento)
  taxCodes: string[];

  // Quais prefixos de código são impostos sobre resultado, deduzidos após resultado operacional
  incomeTaxCodes: string[];
}

const REVENUE_DEDUCTION_TAX_CODES = ["8.1", "8.2", "8.3", "8.4"];
const INCOME_TAX_CODES = ["8.5", "8.7"];

export const DRE_PROFILES: Record<string, DREProfile> = {
  // ============================================
  // VAREJO / COMÉRCIO
  // CMV = Mercadoria para Revenda, Frete, Embalagens, etc.
  // ============================================
  VAREJO: {
    sectorKey: "VAREJO",
    sectorLabel: "Varejo / Comércio",
    directCostLabel: "CMV (Custo da Mercadoria Vendida)",
    grossProfitLabel: "Lucro Bruto",
    directCostCodes: ["3."],
    excludeFromDirectCost: [],
    taxCodes: REVENUE_DEDUCTION_TAX_CODES,
    incomeTaxCodes: INCOME_TAX_CODES,
  },

  // ============================================
  // SERVIÇOS / CONSULTORIA
  // CSP = Mão de obra direta, freelancers, PJ alocados em projetos
  // ============================================
  SERVICOS: {
    sectorKey: "SERVICOS",
    sectorLabel: "Serviços / Consultoria",
    directCostLabel: "CSP (Custo dos Serviços Prestados)",
    grossProfitLabel: "Lucro Bruto",
    directCostCodes: [
      "3.3",  // Mão de Obra Direta (consultores, técnicos)
      "3.6",  // Serviços de Terceiros (freelancers, subcontratados)
      "4.1",  // Salários (equipe técnica alocada em projetos)
      "4.4",  // Prestadores PJ (freelancers)
    ],
    excludeFromDirectCost: [],
    taxCodes: REVENUE_DEDUCTION_TAX_CODES,
    incomeTaxCodes: INCOME_TAX_CODES,
  },

  // ============================================
  // INDÚSTRIA / MANUFATURA
  // CPV = Matéria-prima, mão de obra direta, custos indiretos de fabricação
  // ============================================
  INDUSTRIA: {
    sectorKey: "INDUSTRIA",
    sectorLabel: "Indústria / Manufatura",
    directCostLabel: "CPV (Custo dos Produtos Vendidos)",
    grossProfitLabel: "Lucro Bruto",
    directCostCodes: ["3."],
    excludeFromDirectCost: [],
    taxCodes: REVENUE_DEDUCTION_TAX_CODES,
    incomeTaxCodes: INCOME_TAX_CODES,
  },

  // ============================================
  // SaaS / TECNOLOGIA
  // Custo de Receita = Devs, suporte, infra cloud, APIs
  // ============================================
  SAAS: {
    sectorKey: "SAAS",
    sectorLabel: "SaaS / Tecnologia",
    directCostLabel: "Custo de Receita",
    grossProfitLabel: "Lucro Bruto",
    directCostCodes: [
      "3.3",  // Mão de Obra Direta (devs, suporte)
      "3.6",  // Serviços de Terceiros (cloud, APIs)
      "5.4",  // Software e Assinaturas (infra: AWS, Azure, etc.)
    ],
    excludeFromDirectCost: [],
    taxCodes: REVENUE_DEDUCTION_TAX_CODES,
    incomeTaxCodes: INCOME_TAX_CODES,
  },

  // ============================================
  // E-COMMERCE (FRENTE 2: novo setor)
  // CMV = Mercadoria + Frete + Embalagens + Taxas de Marketplace
  // ============================================
  ECOMMERCE: {
    sectorKey: "ECOMMERCE",
    sectorLabel: "E-commerce",
    directCostLabel: "CMV (Custo da Mercadoria Vendida)",
    grossProfitLabel: "Lucro Bruto",
    directCostCodes: [
      "3.",   // Todos os custos diretos (matéria-prima, mercadoria, frete, embalagens)
      "7.3",  // Taxas de Cartão/Maquininha (marketplace fees)
    ],
    excludeFromDirectCost: [],
    taxCodes: REVENUE_DEDUCTION_TAX_CODES,
    incomeTaxCodes: INCOME_TAX_CODES,
  },

  // ============================================
  // MISTO / OUTROS (DEFAULT)
  // Usa todos os custos diretos 3.x
  // ============================================
  MISTO: {
    sectorKey: "MISTO",
    sectorLabel: "Misto / Outros",
    directCostLabel: "Custos Diretos",
    grossProfitLabel: "Lucro Bruto",
    directCostCodes: ["3."],
    excludeFromDirectCost: [],
    taxCodes: REVENUE_DEDUCTION_TAX_CODES,
    incomeTaxCodes: INCOME_TAX_CODES,
  },
};

/**
 * Retorna o perfil de DRE para o setor da empresa.
 * Se o setor não for reconhecido, retorna MISTO.
 */
export function getDREProfile(sector: string): DREProfile {
  return DRE_PROFILES[sector] || DRE_PROFILES.MISTO;
}

/**
 * Verifica se um código de categoria é "custo direto" para o perfil dado.
 */
export function isDirectCost(code: string, profile: DREProfile): boolean {
  // Verificar exclusões primeiro
  if (profile.excludeFromDirectCost.some((exc) => code.startsWith(exc))) {
    return false;
  }
  // Verificar inclusões
  return profile.directCostCodes.some((prefix) => code.startsWith(prefix));
}

/**
 * Verifica se um código de categoria é dedução da receita para o perfil dado.
 * Exemplos: Simples/DAS, ISS, ICMS e PIS/COFINS.
 */
export function isTax(code: string, profile: DREProfile): boolean {
  return profile.taxCodes.some((prefix) => code.startsWith(prefix));
}

/**
 * Verifica se um código de categoria é imposto sobre resultado.
 * Exemplos: IRPJ/CSLL.
 */
export function isIncomeTax(code: string, profile: DREProfile): boolean {
  return profile.incomeTaxCodes.some((prefix) => code.startsWith(prefix));
}

/**
 * Lista de setores disponíveis para o cadastro (frontend select).
 */
export const AVAILABLE_SECTORS = [
  { value: "VAREJO", label: "Varejo / Comércio" },
  { value: "SERVICOS", label: "Serviços / Consultoria" },
  { value: "INDUSTRIA", label: "Indústria / Manufatura" },
  { value: "SAAS", label: "SaaS / Tecnologia" },
  { value: "ECOMMERCE", label: "E-commerce" },
  { value: "MISTO", label: "Misto / Outros" },
];
