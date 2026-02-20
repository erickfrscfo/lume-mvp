/**
 * CAMADA 3 — HUMANIZAÇÃO POR LLM (com IA, batch otimizado)
 * 
 * Recebe TODOS os alertas de uma vez em uma única chamada à IA.
 * Usa cache por hash para evitar chamadas repetidas.
 * 
 * IMPORTANTE: A IA entende a NATUREZA das contas e adapta as recomendações:
 * - Contas de consumo (energia, água) → sugerir economia, NÃO renegociação
 * - Folha de pagamento (salários, pró-labore) → sugerir otimização, NÃO desconto
 * - Fornecedores/contratos → SIM, pode sugerir renegociação
 * - Perdas/avarias → sugerir prevenção e controle
 * - Impostos → NÃO sugerir renegociação (são obrigatórios)
 */

import crypto from "crypto";
import { callAi } from "../ai/ai.service.js";
import { prisma } from "../../shared/database.js";

interface AlertForHumanization {
  type: string;
  title: string;
  templateText: string;
  data: Record<string, any>;
}

/**
 * Humaniza um lote de alertas em uma única chamada à LLM.
 * Retorna um array de textos humanizados na mesma ordem dos alertas.
 */
export async function humanizeAlerts(
  userId: string,
  companyId: string,
  alerts: AlertForHumanization[]
): Promise<string[]> {
  if (alerts.length === 0) return [];

  // Gerar hash dos dados para cache
  const dataHash = crypto.createHash("md5")
    .update(JSON.stringify(alerts.map((a) => a.data)))
    .digest("hex");

  // Verificar cache (alertas com mesmo hash nas últimas 24h)
  const oneDayAgo = new Date();
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);

  const cachedAlerts = await prisma.alert.findMany({
    where: {
      companyId,
      dataHash,
      humanizedText: { not: null },
      createdAt: { gte: oneDayAgo },
    },
    orderBy: { createdAt: "desc" },
    take: alerts.length,
  });

  if (cachedAlerts.length >= alerts.length) {
    console.log(`[Alerts] Cache hit para ${alerts.length} alertas (hash: ${dataHash.slice(0, 8)})`);
    return cachedAlerts.map((a) => a.humanizedText || a.templateText);
  }

  // Buscar contexto básico da empresa
  let companyContext = "";
  try {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (company) {
      companyContext = `Empresa: ${company.name || "PME"} | Setor: ${(company as any).sector || "Não informado"}`;
    }
  } catch {
    companyContext = "PME brasileira";
  }

  // Montar prompt batch
  const alertsList = alerts.map((a, i) => {
    const nature = a.data.nature ? ` [Natureza: ${a.data.nature}]` : '';
    return `${i + 1}. [${a.type}]${nature} ${a.title}\n   Texto base: ${a.templateText}`;
  }).join("\n\n");

  const systemPrompt = `Você é o Lume, CFO virtual de uma PME brasileira. Reescreva cada alerta abaixo em linguagem coloquial e direta para um empreendedor que NÃO é da área financeira.

=== REGRAS OBRIGATÓRIAS ===

1. Mantenha cada alerta em no máximo 3-4 frases
2. Use números reais (R$, %, meses)
3. Seja empático mas direto — fale como um amigo que entende de finanças
4. NÃO use jargões financeiros sem explicar

=== REGRAS POR NATUREZA DA CONTA ===

CONTAS DE CONSUMO (energia, água, gás, combustível):
- NUNCA sugira "renegociar" — contas de consumo não se renegociam
- Sugira ECONOMIA DE CONSUMO: trocar lâmpadas por LED, desligar equipamentos fora do horário, verificar vazamentos, avaliar energia solar, instalar sensores de presença
- Diga que a "média mensal está em R$ X" (não "você paga R$ X")

FOLHA DE PAGAMENTO (salários, pró-labore, benefícios, encargos):
- NUNCA sugira "renegociar" ou "pedir desconto" em salários
- Para PRÓ-LABORE: sugira avaliar se o valor está adequado ao momento da empresa, conversar com o contador sobre estratégia tributária (pró-labore vs distribuição de lucros)
- Para SALÁRIOS: sugira revisar a estrutura de cargos, avaliar produtividade, considerar automação de processos antes de cortar pessoas
- Para BENEFÍCIOS: sugira pesquisar planos alternativos com melhor custo-benefício

FORNECEDORES E CONTRATOS (aluguel, software, serviços, mercadoria):
- SIM, pode sugerir renegociação
- Sugira pedir cotações de concorrentes e usar como argumento
- Mencione o poder de barganha pelo volume e recorrência

PERDAS E AVARIAS:
- Sugira investigar as CAUSAS (armazenamento, transporte, controle de estoque)
- Sugira inventários rotativos e melhoria nos processos
- Destaque o impacto anual (valor mensal x 12)

IMPOSTOS:
- NUNCA sugira renegociar impostos
- Sugira conversar com o contador sobre planejamento tributário
- Mencione se o regime tributário atual é o mais vantajoso

=== ALERTAS CRÍTICOS (margem, receita, desequilíbrio) ===
- Use tom de URGÊNCIA mas sem pânico
- Sempre sugira uma ação concreta e imediata
- Contextualize o impacto: "se continuar assim, em X meses..."

=== FORMATO ===
Retorne APENAS um JSON array de strings, na mesma ordem dos alertas.
Cada string é o texto humanizado de um alerta.`;

  const userPrompt = `CONTEXTO: ${companyContext}

ALERTAS PARA REESCREVER (${alerts.length}):

${alertsList}

Retorne um JSON array com ${alerts.length} strings humanizadas.`;

  try {
    const response = await callAi({
      userId,
      type: "CHAT",
      systemPrompt,
      userPrompt,
      temperature: 0.5,
      maxTokens: 2000,
    });

    // Parsear JSON da resposta
    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const humanized = JSON.parse(jsonMatch[0]);
      if (Array.isArray(humanized) && humanized.length === alerts.length) {
        return humanized.map((h: any) => String(h));
      }
    }

    // Fallback: usar templates da Camada 2
    console.warn("[Alerts] Resposta da IA não é JSON válido, usando templates");
    return alerts.map((a) => a.templateText);
  } catch (error) {
    console.error("[Alerts] Erro na humanização:", error);
    return alerts.map((a) => a.templateText);
  }
}
