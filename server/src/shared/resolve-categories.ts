/**
 * Helper: Resolve as categorias de uma empresa.
 * Se a empresa usa plano customizado (useCustomChart = true), busca de CompanyCategory.
 * Caso contrário, usa as categorias globais da tabela Category.
 *
 * ARQUIVO: server/src/shared/resolve-categories.ts
 *
 * Será usado na Frente 3 pelo ai.service.ts e upload.controller.ts
 * para montar o prompt da IA com as categorias corretas da empresa.
 */

import { prisma } from "./database.js";

export interface ResolvedCategory {
  code: string;
  name: string;
  type: "INCOME" | "EXPENSE";
  parentCode: string | null;
  isActive: boolean;
}

/**
 * Resolve as categorias que devem ser usadas para uma empresa específica.
 *
 * @param companyId - ID da empresa
 * @returns Lista de categorias (customizadas ou globais)
 */
export async function resolveCompanyCategories(
  companyId: string
): Promise<ResolvedCategory[]> {
  // Buscar a empresa para verificar se usa plano customizado
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { useCustomChart: true },
  });

  if (!company) {
    throw new Error(`Empresa não encontrada: ${companyId}`);
  }

  if (company.useCustomChart) {
    // Buscar categorias customizadas da empresa
    const customCategories = await prisma.companyCategory.findMany({
      where: {
        companyId,
        isActive: true,
      },
      orderBy: { code: "asc" },
    });

    return customCategories.map((cat) => ({
      code: cat.code,
      name: cat.name,
      type: cat.type as "INCOME" | "EXPENSE",
      parentCode: cat.parentCode,
      isActive: cat.isActive,
    }));
  }

  // Usar categorias globais
  const globalCategories = await prisma.category.findMany({
    orderBy: { code: "asc" },
    include: { parent: true },
  });

  return globalCategories.map((cat) => ({
    code: cat.code,
    name: cat.name,
    type: cat.type as "INCOME" | "EXPENSE",
    parentCode: cat.parent?.code || null,
    isActive: true,
  }));
}

/**
 * Formata as categorias resolvidas como texto para incluir no prompt da IA.
 *
 * @param categories - Lista de categorias resolvidas
 * @returns Texto formatado para o prompt
 */
export function formatCategoriesForPrompt(
  categories: ResolvedCategory[]
): string {
  const incomeCategories = categories.filter((c) => c.type === "INCOME");
  const expenseCategories = categories.filter((c) => c.type === "EXPENSE");

  let text = "=== PLANO DE CONTAS ===\n\n";

  text += "RECEITAS:\n";
  for (const cat of incomeCategories) {
    const indent = cat.parentCode ? "  " : "";
    text += `${indent}${cat.code} - ${cat.name}\n`;
  }

  text += "\nDESPESAS:\n";
  for (const cat of expenseCategories) {
    const indent = cat.parentCode ? "  " : "";
    text += `${indent}${cat.code} - ${cat.name}\n`;
  }

  return text;
}
