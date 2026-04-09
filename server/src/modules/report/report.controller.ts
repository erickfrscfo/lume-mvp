/**
 * report.controller.ts
 * 
 * Endpoints da API de relatório dinâmico ("Monte seu Relatório").
 * 
 * Caminho no projeto: server/modules/report/report.controller.ts
 */

import { Router, Request, Response } from "express";
import { prisma } from "../../shared/database.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  STANDARD_INDICATORS,
  INDICATOR_CATEGORIES,
  getAllCategoriesWithIndicators,
  getIndicatorById,
} from "./indicators.js";
import {
  calculateIndicators,
  getLastCompleteMonth,
} from "./report.service.js";
import { callAi } from "../ai/ai.service.js";

const router = Router();

// Middleware: todas as rotas requerem autenticação
router.use(requireAuth);

// ============================================
// GET /api/report/indicators
// Lista todos os indicadores disponíveis (padrão + custom), agrupados por categoria
// ============================================
router.get("/indicators", async (req: Request, res: Response) => {
  try {
    const companyId = (req as any).companyId;

    // Indicadores padrão agrupados por categoria
    const standardCategories = getAllCategoriesWithIndicators();

    // Indicadores customizados da empresa
    const customIndicators = await prisma.customIndicator.findMany({
      where: { companyId, isActive: true },
      orderBy: { createdAt: "asc" },
    });

    res.json({
      categories: standardCategories,
      customIndicators: customIndicators.map((ci) => ({
        id: ci.id,
        name: ci.name,
        description: ci.description,
        formula: ci.formula,
        category: "CUSTOM" as const,
        unit: "TEXT" as const,
      })),
    });
  } catch (error) {
    console.error("Erro ao listar indicadores:", error);
    res.status(500).json({ error: "Erro ao listar indicadores." });
  }
});

// ============================================
// GET /api/report/template
// Retorna o template salvo da empresa (indicadores selecionados + ordem)
// ============================================
router.get("/template", async (req: Request, res: Response) => {
  try {
    const companyId = (req as any).companyId;

    const template = await prisma.reportTemplate.findUnique({
      where: { companyId },
    });

    if (!template) {
      return res.json({
        indicators: [],
        name: "Relatório Financeiro",
        referenceMonth: getLastCompleteMonth(),
      });
    }

    res.json({
      indicators: template.indicators, // JSON array: [{ id, type, order }]
      name: template.name,
      referenceMonth: template.referenceMonth || getLastCompleteMonth(),
    });
  } catch (error) {
    console.error("Erro ao buscar template:", error);
    res.status(500).json({ error: "Erro ao buscar template do relatório." });
  }
});

// ============================================
// PUT /api/report/template
// Salva/atualiza o template (indicadores selecionados + ordem)
// ============================================
router.put("/template", async (req: Request, res: Response) => {
  try {
    const companyId = (req as any).companyId;
    const { indicators, name, referenceMonth } = req.body;

    // Validar limite de 20 indicadores
    if (indicators && indicators.length > 20) {
      return res.status(400).json({ error: "O relatório pode ter no máximo 20 indicadores." });
    }

    const template = await prisma.reportTemplate.upsert({
      where: { companyId },
      create: {
        companyId,
        name: name || "Relatório Financeiro",
        indicators: indicators || [],
        referenceMonth: referenceMonth || null,
      },
      update: {
        name: name || undefined,
        indicators: indicators || undefined,
        referenceMonth: referenceMonth !== undefined ? referenceMonth : undefined,
      },
    });

    res.json({
      indicators: template.indicators,
      name: template.name,
      referenceMonth: template.referenceMonth,
    });
  } catch (error) {
    console.error("Erro ao salvar template:", error);
    res.status(500).json({ error: "Erro ao salvar template do relatório." });
  }
});

// ============================================
// POST /api/report/generate
// Calcula os valores reais dos indicadores selecionados
// ============================================
router.post("/generate", async (req: Request, res: Response) => {
  try {
    const companyId = (req as any).companyId;
    const { month, indicatorIds } = req.body;

    if (!indicatorIds || !Array.isArray(indicatorIds) || indicatorIds.length === 0) {
      return res.status(400).json({ error: "Selecione pelo menos um indicador." });
    }

    if (indicatorIds.length > 20) {
      return res.status(400).json({ error: "O relatório pode ter no máximo 20 indicadores." });
    }

    const referenceMonth = month || getLastCompleteMonth();

    // Buscar dados da empresa para o cabeçalho
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true, cnpj: true, logoUrl: true, sector: true },
    });

    // Calcular indicadores
    const calculatedIndicators = await calculateIndicators(
      companyId,
      referenceMonth,
      indicatorIds
    );

    // Formatar mês de referência para exibição
    const [year, m] = referenceMonth.split("-");
    const monthNames = [
      "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
      "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
    ];
    const monthLabel = `${monthNames[parseInt(m) - 1]} de ${year}`;

    res.json({
      company: {
        name: company?.name || "Empresa",
        cnpj: company?.cnpj || "",
        logoUrl: company?.logoUrl || null,
        sector: company?.sector || "",
      },
      referenceMonth,
      monthLabel,
      generatedAt: new Date().toISOString(),
      indicators: calculatedIndicators,
    });
  } catch (error) {
    console.error("Erro ao gerar relatório:", error);
    res.status(500).json({ error: "Erro ao gerar relatório. Tente novamente." });
  }
});

// ============================================
// POST /api/report/indicators/custom
// Cria indicador customizado via IA
// ============================================
router.post("/indicators/custom", async (req: Request, res: Response) => {
  try {
    const companyId = (req as any).companyId;
    const userId = (req as any).userId;
    const { description } = req.body;

    if (!description || description.trim().length < 5) {
      return res.status(400).json({ error: "Descreva o indicador que deseja criar." });
    }

    // Verificar limite de 20 indicadores custom por empresa
    const customCount = await prisma.customIndicator.count({
      where: { companyId, isActive: true },
    });
    if (customCount >= 20) {
      return res.status(400).json({
        error: "Limite de 20 indicadores customizados atingido. Remova um indicador existente para criar um novo.",
      });
    }

    // Usar IA para interpretar a descrição e gerar o indicador
    const systemPrompt = `Você é um analista financeiro que ajuda a criar indicadores personalizados para relatórios financeiros de PMEs brasileiras.

O usuário vai descrever um indicador que deseja ter no relatório. Sua tarefa é:
1. Interpretar a descrição
2. Criar um nome curto e claro para o indicador
3. Criar um texto explicativo em linguagem simples (sem jargões)
4. Descrever a fórmula de cálculo em linguagem natural
5. Avaliar se o indicador é calculável com os dados disponíveis

DADOS DISPONÍVEIS NO SISTEMA:
- Transações financeiras (receitas e despesas) com: valor, data, categoria, contraparte, status (pago/pendente/atrasado), tipo de custo (fixo/variável)
- Detalhes de transação: data de vencimento, data de pagamento, juros, descontos, multas
- Categorias contábeis hierárquicas (plano de contas)
- Contrapartes (clientes e fornecedores) com: prazo médio de pagamento/recebimento
- Alertas financeiros com: tipo, valor de economia potencial

DADOS NÃO DISPONÍVEIS:
- Número de funcionários
- Dados de estoque (quantidade, SKU)
- Dados de produção
- Dados de CRM (leads, oportunidades)
- Dados bancários (saldo em conta, extrato)

Retorne APENAS um JSON com este formato:
{
  "name": "Nome do Indicador",
  "description": "Texto explicativo em linguagem simples",
  "formula": "Descrição da fórmula de cálculo",
  "viable": true/false,
  "viabilityNote": "Se não viável, explique por quê e sugira alternativa"
}`;

    const response = await callAi({
      userId,
      type: "CHAT",
      systemPrompt,
      userPrompt: `O usuário quer criar este indicador: "${description}"`,
      temperature: 0.3,
      maxTokens: 500,
    });

    // Extrair JSON da resposta
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: "Não foi possível interpretar a descrição. Tente reformular." });
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.viable) {
      return res.json({
        success: false,
        suggestion: parsed,
        message: parsed.viabilityNote || "Este indicador não pode ser calculado com os dados disponíveis.",
      });
    }

    // Salvar o indicador customizado
    const customIndicator = await prisma.customIndicator.create({
      data: {
        companyId,
        name: parsed.name,
        description: parsed.description,
        formula: parsed.formula,
        queryTemplate: description, // guardar a descrição original
        createdByUserId: userId,
      },
    });

    res.json({
      success: true,
      indicator: {
        id: customIndicator.id,
        name: customIndicator.name,
        description: customIndicator.description,
        formula: customIndicator.formula,
        category: "CUSTOM",
        unit: "TEXT",
      },
    });
  } catch (error) {
    console.error("Erro ao criar indicador custom:", error);
    res.status(500).json({ error: "Erro ao criar indicador. Tente novamente." });
  }
});

// ============================================
// DELETE /api/report/indicators/custom/:id
// Remove indicador customizado (soft delete)
// ============================================
router.delete("/indicators/custom/:id", async (req: Request, res: Response) => {
  try {
    const companyId = (req as any).companyId;
    const { id } = req.params;

    const indicator = await prisma.customIndicator.findFirst({
      where: { id, companyId },
    });

    if (!indicator) {
      return res.status(404).json({ error: "Indicador não encontrado." });
    }

    await prisma.customIndicator.update({
      where: { id },
      data: { isActive: false },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Erro ao remover indicador custom:", error);
    res.status(500).json({ error: "Erro ao remover indicador." });
  }
});

export default router;
