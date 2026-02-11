import OpenAI from "openai";
import { env } from "../../config/env.js";
import { prisma } from "../../shared/database.js";
import { AiInteractionType } from "@prisma/client";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

interface AiCallOptions {
  userId: string;
  type: AiInteractionType;
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

interface AiResponse {
  content: string;
  tokenUsage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model: string;
  latencyMs: number;
}

// Função central que faz todas as chamadas à OpenAI
export async function callAi(options: AiCallOptions): Promise<AiResponse> {
  const {
    userId,
    type,
    systemPrompt,
    userPrompt,
    model = "gpt-4o-mini",
    temperature = 0.3,
    maxTokens = 2000,
  } = options;

  const startTime = Date.now();

  const completion = await openai.chat.completions.create({
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const latencyMs = Date.now() - startTime;
  const content = completion.choices[0]?.message?.content || "";
  const tokenUsage = {
    prompt_tokens: completion.usage?.prompt_tokens || 0,
    completion_tokens: completion.usage?.completion_tokens || 0,
    total_tokens: completion.usage?.total_tokens || 0,
  };

  // Registrar interação no banco
  await prisma.aiInteraction.create({
    data: {
      userId,
      type,
      promptSent: `[SYSTEM] ${systemPrompt}\n\n[USER] ${userPrompt}`,
      responseReceived: content,
      tokenUsage,
      model,
      latencyMs,
    },
  });

  return { content, tokenUsage, model, latencyMs };
}

// Classificar transações
export async function classifyTransactions(
  userId: string,
  transactions: Array<{ id: string; description: string; amount: number; type: string }>,
  categories: Array<{ code: string; name: string; type: string }>
) {
  const categoryList = categories
    .map((c) => `${c.code} - ${c.name} (${c.type})`)
    .join("\n");

  const transactionList = transactions
    .map((t) => `ID: ${t.id} | Descrição: "${t.description}" | Valor: R$ ${t.amount} | Tipo: ${t.type}`)
    .join("\n");

  const systemPrompt = `Você é um contador especializado em classificação contábil para PMEs brasileiras.
Classifique cada transação abaixo em uma das categorias fornecidas.
Retorne APENAS um JSON array com objetos contendo: id, categoryCode, confidence (0-1).
Não inclua explicações, apenas o JSON.`;

  const userPrompt = `CATEGORIAS DISPONÍVEIS:
${categoryList}

TRANSAÇÕES PARA CLASSIFICAR:
${transactionList}`;

  const response = await callAi({
    userId,
    type: "CLASSIFICATION",
    systemPrompt,
    userPrompt,
    temperature: 0.1,
  });

  try {
    // Extrair JSON da resposta
    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return [];
  } catch {
    console.error("Erro ao parsear resposta da IA:", response.content);
    return [];
  }
}

/// Explicar métrica (Explica pra Mim)
export async function explainMetric(
  userId: string,
  metric: string,
  value: string,
  financialContext: string
) {
  const systemPrompt = `Você é o Lume, um CFO virtual que traduz finanças para empreendedores que NÃO são da área financeira.

Sua missão é transformar números abstratos em narrativas acionáveis. O empreendedor não precisa saber o que é EBITDA — ele precisa saber se o negócio está saudável.

REGRAS DE COMUNICAÇÃO:
- Use linguagem coloquial e direta, como se estivesse conversando com um amigo
- NUNCA use jargões sem explicar (se precisar mencionar um termo técnico, explique entre parênteses)
- Sempre contextualize com os dados REAIS da empresa (use os números fornecidos)
- Compare com o mês anterior quando possível ("melhorou X%" ou "piorou X%")
- Dê exemplos práticos do que o número significa no dia a dia do negócio
- Sugira ações concretas e específicas (não genéricas)
- Use benchmarks do setor quando relevante (média de mercado para PMEs brasileiras)
- Se o valor for bom, celebre. Se for ruim, seja honesto mas construtivo.
- Mencione o impacto anualizado quando fizer sentido ("se mantiver esse ritmo, no ano será X")

FORMATO DA RESPOSTA — JSON com 4 campos:
- summary: Explicação principal em 3-4 frases. Comece dizendo o que o número significa em linguagem simples, depois contextualize com dados reais da empresa. Inclua comparação com mês anterior.
- details: Análise mais profunda em 4-5 frases. Inclua: comparação com benchmarks do setor, impacto anualizado, e quais categorias/fatores mais influenciaram esse número.
- recommendation: 2-3 ações concretas e específicas que o empreendedor pode tomar AGORA. Seja prático (ex: "renegocie o contrato X" em vez de "reduza custos").
- sentiment: "positive", "negative" ou "neutral" — indica se o número é bom, ruim ou neutro para o negócio.`;

  const userPrompt = `DADOS COMPLETOS DA EMPRESA:
${financialContext}

MÉTRICA QUE O EMPREENDEDOR QUER ENTENDER: ${metric}
VALOR ATUAL: ${value}

Explique de forma simples, prática e personalizada para este negócio. Use os dados reais acima para contextualizar. Compare com o mês anterior. Sugira ações específicas.`;

  const response = await callAi({
    userId,
    type: "EXPLANATION",
    systemPrompt,
    userPrompt,
    temperature: 0.6,
    maxTokens: 2000,
  });

  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { summary: response.content, details: "", recommendation: "" };
  } catch {
    return { summary: response.content, details: "", recommendation: "" };
  }
}

// Chat da Reunião Executiva
export async function chat(
  userId: string,
  message: string,
  financialContext: string,
  chatHistory: Array<{ role: string; content: string }>
) {
  const systemPrompt = `Você é o Lume, um CFO virtual inteligente e analítico. Seu papel é ser o braço direito financeiro do empreendedor.

IMPORTANTE — VOCÊ TEM ACESSO TOTAL AOS DADOS FINANCEIROS DA EMPRESA:
Os dados abaixo são REAIS e extraídos diretamente do banco de dados da empresa. Use-os para responder QUALQUER pergunta financeira. Você DEVE calcular, analisar e responder com base nesses dados. NUNCA diga que não tem acesso aos dados.

DADOS FINANCEIROS COMPLETOS:
${financialContext}

REGRAS DE RESPOSTA:
1. SEMPRE use os dados acima para responder. Eles são reais e atualizados.
2. Quando perguntarem sobre um mês específico, consulte a seção "EVOLUÇÃO MENSAL DETALHADA" — lá estão receita, despesa, líquido, margem E as categorias detalhadas de CADA mês separadamente.
3. CRÍTICO: Os dados na evolução mensal são POR MÊS. Use APENAS os valores do mês perguntado. NUNCA some valores de meses diferentes. Exemplo: se perguntarem "quanto gastei com salários em fevereiro?", use APENAS a linha de Salários dentro do bloco 2026-02, não some com outros meses.
4. Para calcular margem de lucro: Margem = (Receita - Despesa) / Receita × 100. Os dados já estão na evolução mensal.
5. Para comparações entre meses, use os dados mês a mês da evolução mensal.
6. Use linguagem simples e direta, como se conversasse com um amigo empreendedor.
7. NUNCA use jargões sem explicar.
8. Sempre que possível, compare com o mês anterior e dê contexto ("isso é bom porque..." ou "isso preocupa porque...").
9. Sugira ações concretas e práticas quando relevante.
10. Formate a resposta com parágrafos curtos e use negrito (**texto**) para destacar números importantes.
11. Se a pergunta envolver projeção futura, use os dados históricos como base e deixe claro que é uma estimativa.
12. Ao mencionar valores, sempre use 2 casas decimais no formato brasileiro (R$ xx.xxx,xx).`;

  const historyText = chatHistory
    .map((h) => `${h.role === "user" ? "USUÁRIO" : "LUME"}: ${h.content}`)
    .join("\n\n");

  const userPrompt = `${historyText ? `HISTÓRICO DA CONVERSA:\n${historyText}\n\n` : ""}PERGUNTA DO USUÁRIO: ${message}`;

  const response = await callAi({
    userId,
    type: "CHAT",
    systemPrompt,
    userPrompt,
    temperature: 0.5,
    maxTokens: 3000,
  });

  return {
    message: response.content,
    tokenUsage: response.tokenUsage,
  };
}
