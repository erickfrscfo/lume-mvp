// ============================================
// DRE PROFILES — Perfis de DRE por Setor
// Define quais categorias compõem o "Custo Direto"
// e qual nomenclatura usar na interface.
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
 * Lista de setores disponíveis para o cadastro (frontend select).
 */
export const AVAILABLE_SECTORS = [
  { value: "VAREJO", label: "Varejo / Comércio" },
  { value: "SERVICOS", label: "Serviços / Consultoria" },
  { value: "INDUSTRIA", label: "Indústria / Manufatura" },
  { value: "SAAS", label: "SaaS / Tecnologia" },
  { value: "MISTO", label: "Misto / Outros" },
];
