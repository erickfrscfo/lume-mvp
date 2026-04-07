// ============================================
// DRE PROFILES — Perfis de DRE por Setor
// Define quais categorias compõem o "Custo Direto",
// quais são "Impostos" (deduzidos da receita bruta),
// e qual nomenclatura usar na interface.
//
// ESTRUTURA DO DRE:
//   Receita Bruta (1.x + 2.x)
//   (-) Custos Diretos / CSP / CMV / CPV (conforme directCostCodes)
//   (-) Impostos e Tributos (conforme taxCodes)
//   = Lucro Bruto
//   (-) Despesas Operacionais (4.x + 5.x + 6.x + 7.x + 9.x, exceto directCost)
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

  // Quais prefixos de código são Impostos/Tributos (deduzidos da receita bruta)
  taxCodes: string[];
}

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
    taxCodes: ["8."],
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
    taxCodes: ["8."],
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
    taxCodes: ["8."],
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
    taxCodes: ["8."],
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
    taxCodes: ["8."],
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
    taxCodes: ["8."],
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
 * Verifica se um código de categoria é "imposto/tributo" para o perfil dado.
 * Impostos são deduzidos da receita bruta no DRE (antes do Lucro Bruto).
 */
export function isTax(code: string, profile: DREProfile): boolean {
  return profile.taxCodes.some((prefix) => code.startsWith(prefix));
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
