/**
 * CAMADA 3 — HUMANIZAÇÃO POR LLM (com IA, batch otimizado)
 * 
 * Recebe TODOS os alertas de uma vez em uma única chamada à IA.
 * Usa cache por hash para evitar chamadas repetidas.
 * Custo estimado: ~500-800 tokens por lote (< R$ 0,001).
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
    return `${i + 1}. [${a.type}] ${a.title}\n   Dados: ${a.templateText}`;
  }).join("\n\n");

  const systemPrompt = `Você é o Lume, CFO virtual de uma PME brasileira. Reescreva cada alerta abaixo em linguagem coloquial e direta para um empreendedor que NÃO é da área financeira.

REGRAS:
- Mantenha cada alerta em no máximo 3-4 frases
- Use números reais (R$, %, meses)
- Sugira uma ação concreta e específica em cada alerta
- Seja empático mas direto
- NÃO use jargões financeiros sem explicar
- Retorne APENAS um JSON array de strings, na mesma ordem dos alertas
- Cada string é o texto humanizado de um alerta`;

  const userPrompt = `CONTEXTO: ${companyContext}

ALERTAS PARA REESCREVER (${alerts.length}):

${alertsList}

Retorne um JSON array com ${alerts.length} strings humanizadas.`;

  try {
    const response = await callAi({
      userId,
      type: "CHAT", // Usar CHAT como tipo genérico
      systemPrompt,
      userPrompt,
      temperature: 0.6,
      maxTokens: 1500,
    });

    // Parsear JSON da resposta
    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const humanized = JSON.parse(jsonMatch[0]);
      if (Array.isArray(humanized) && humanized.length === alerts.length) {
        return humanized.map((h: any) => String(h));
      }
    }

    // Fallback: tentar separar por números
    console.warn("[Alerts] Resposta da IA não é JSON válido, usando templates");
    return alerts.map((a) => a.templateText);
  } catch (error) {
    console.error("[Alerts] Erro na humanização:", error);
    // Fallback: usar templates da Camada 2
    return alerts.map((a) => a.templateText);
  }
}
