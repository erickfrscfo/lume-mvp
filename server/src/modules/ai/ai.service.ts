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
Não inclua explicações, apenas o JSON.

=== REGRA DE CONSISTÊNCIA (OBRIGATÓRIA) ===
Trasações com a MESMA descrição DEVEM SEMPRE receber o MESMO código de categoria.
Exemplo: se "Perdas e avarias de estoque" é classificada como 3.2, TODAS as ocorrências
de "Perdas e avarias de estoque" devem ser 3.2. Nunca alterne entre categorias diferentes.

=== CUSTOS DE MERCADORIA VENDIDA (CMV) - GRUPO 3.x ===
Qualquer custo diretamente atrelado ao produto, estoque ou operação de venda é CMV.

MAPEAMENTO OBRIGATÓRIO:
- Matéria-prima, insumos de produção → 3.1
- Mercadoria para revenda, compra de estoque, compra de mercadorias → 3.2
- Perdas e avarias de estoque, quebras, devoluções de mercadoria → 3.2 (são perdas de mercadoria vendida)
- Mão de obra direta de produção → 3.3
- Frete sobre vendas, frete de entrega, frete sobre compras, logística → 3.4
- Embalagens, caixas, fornecedor de embalagens → 3.5
- Serviços terceirizados de produção → 3.6

=== DESPESAS OPERACIONAIS - GRUPO 5.x ===
- Aluguel da loja, aluguel escritório, condomínio, IPTU → 5.1
- Energia elétrica, água, gás → 5.2
- Salários, folha de pagamento, prolabore, pró-labore → 5.3
- Internet, telefone, sistemas, ERP, software, SaaS → 5.4

=== DESPESAS COMERCIAIS - GRUPO 6.x ===
- Marketing digital, Google Ads, Facebook Ads, campanhas → 6.1

=== IMPOSTOS - GRUPO 4.x ===
- Simples Nacional, ICMS, ISS, PIS, COFINS → 4.1

EXEMPLOS CONCRETOS:
- "Compra de mercadorias (estoque)" → 3.2
- "Frete sobre compras" → 3.4
- "Embalagens varejo/online" → 3.5
- "Perdas e avarias de estoque" → 3.2 (SEMPRE 3.2, nunca 5.x)
- "Folha de pagamento" → 5.3
- "Prolabore" → 5.3
- "Aluguel da loja" → 5.1
- "Internet" → 5.4
- "Sistemas e ERP" → 5.4
- "Conta de energia" → 5.2
- "Conta de agua" → 5.2
- "Marketing digital" → 6.1
- "Impostos Simples Nacional" → 4.1

PROIBIÇÕES:
- NÃO classifique CMV (mercadoria, estoque, frete, embalagem, perdas) como 5.x ou 6.x
- NÃO classifique a mesma descrição em categorias diferentes em lotes distintos`;

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

// ============================================
// NOVA FUNÇÃO: Classificar tipo de custo (fixo/variável)
// ============================================
export async function classifyCostType(
  userId: string,
  transactions: Array<{ id: string; description: string; amount: number; categoryName?: string }>
) {
  const transactionList = transactions
    .map((t) => {
      const category = t.categoryName ? ` | Categoria: ${t.categoryName}` : "";
      return `ID: ${t.id} | Descrição: "${t.description}" | Valor: R$ ${t.amount}${category}`;
    })
    .join("\n");

  const systemPrompt = `Você é um analista financeiro especializado em classificação de custos para PMEs brasileiras.

Sua tarefa é classificar cada DESPESA como CUSTO FIXO ou CUSTO VARIÁVEL.

=== REGRA DE CONSISTÊNCIA (OBRIGATÓRIA) ===
Trasações com a MESMA descrição DEVEM SEMPRE receber o MESMO tipo de custo.
Exemplo: se "Perdas e avarias de estoque" é VARIAVEL, TODAS as ocorrências devem ser VARIAVEL.

=== DEFINIÇÕES ===

CUSTO FIXO (FIXO): Despesas que NÃO variam com o volume de vendas/produção.
Existem independentemente de vender muito ou pouco.
  * Aluguel, IPTU, condomínio
  * Salários fixos, folha de pagamento, prolabore
  * Assinaturas de software/SaaS (ERP, CRM, sistemas)
  * Seguros (empresarial, vida)
  * Telefone/internet fixo
  * Contador, advogado (honorários fixos)
  * Licenças e taxas governamentais
  * Depreciação de equipamentos
  * Conta de energia (uso geral/administrativo)
  * Conta de água (uso geral/administrativo)

CUSTO VARIÁVEL (VARIAVEL): Despesas que VARIAM proporcionalmente ao volume de vendas/produção.
Se vender mais, esse custo aumenta. Se vender menos, diminui.
  * Compra de mercadorias, estoque
  * Matéria-prima, insumos
  * Frete sobre compras, frete de entrega
  * Embalagens, caixas
  * Perdas e avarias de estoque (proporcional ao volume de estoque)
  * Impostos sobre vendas (Simples Nacional, ICMS, PIS, COFINS)
  * Comissões de vendas
  * Marketing de performance (Google Ads, Facebook Ads)
  * Mão de obra temporária/freelancer

=== MAPEAMENTO EXPLÍCITO POR DESCRIÇÃO ===
- "Compra de mercadorias (estoque)" → VARIAVEL
- "Frete sobre compras" → VARIAVEL
- "Embalagens varejo/online" → VARIAVEL
- "Perdas e avarias de estoque" → VARIAVEL (SEMPRE, varia com volume de estoque)
- "Impostos Simples Nacional" → VARIAVEL (proporcional ao faturamento)
- "Marketing digital" → VARIAVEL (proporcional ao investimento em vendas)
- "Folha de pagamento" → FIXO
- "Prolabore" → FIXO
- "Aluguel da loja" → FIXO
- "Internet" → FIXO
- "Sistemas e ERP" → FIXO
- "Conta de energia" → FIXO (uso geral, não varia com vendas)
- "Conta de agua" → FIXO

=== REGRAS ===
1. Transações com a mesma descrição = mesmo tipo de custo, SEMPRE
2. Qualquer custo ligado a mercadoria, estoque, frete, embalagem, perdas → VARIAVEL
3. Qualquer custo de estrutura fixa (aluguel, salário, software, utilidades) → FIXO
4. Impostos sobre faturamento → VARIAVEL
5. Dê confidence de 0 a 1 para cada classificação

FORMATO DE RESPOSTA:
Retorne APENAS um JSON array com objetos contendo:
- id: string (ID da transação)
- costType: "FIXO" ou "VARIAVEL"
- confidence: number (0-1, onde 1 = certeza absoluta)

Não inclua explicações, apenas o JSON puro.`;

  const userPrompt = `DESPESAS PARA CLASSIFICAR:
${transactionList}

Classifique cada uma como FIXO ou VARIAVEL com base nas definições acima.`;

  const response = await callAi({
    userId,
    type: "COST_CLASSIFICATION",
    systemPrompt,
    userPrompt,
    temperature: 0.1,
    maxTokens: 3000,
  });

  try {
    // Extrair JSON da resposta
    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      // Validar estrutura
      return parsed.filter((item: any) => 
        item.id && 
        (item.costType === "FIXO" || item.costType === "VARIAVEL") &&
        typeof item.confidence === "number"
      );
    }
    return [];
  } catch (error) {
    console.error("Erro ao parsear resposta da IA (classificação de custos):", response.content);
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
  const systemPrompt = `Você é o Lume, um CFO virtual inteligente. Seu papel é responder perguntas
financeiras de forma clara e acessível para um empreendedor sem formação em finanças.

REGRAS:
- Use linguagem simples e direta
- Sempre use os dados reais da empresa quando disponíveis
- Sugira ações concretas e práticas
- Se não souber algo, diga honestamente
- Formate a resposta com parágrafos curtos para facilitar a leitura
- Quando o usuário perguntar sobre uma despesa específica (ex: "energia", "aluguel", "internet", "salário"),
  busque nas TRANSAÇÕES INDIVIDUAIS filtrando pela DESCRIÇÃO, não apenas pela categoria.
  Liste cada transação individual com data, descrição e valor.
- Uma categoria pode agrupar transações de naturezas diferentes. Exemplo: "Energia e Água" pode conter
  "Conta de energia" e "Conta de internet". Sempre diferencie-as pela descrição.
- Quando listar transações, use formato de lista com data, descrição e valor para facilitar a leitura.

DADOS FINANCEIROS DA EMPRESA:
${financialContext}`;

  const historyText = chatHistory
    .map((h) => `${h.role === "user" ? "USUÁRIO" : "LUME"}: ${h.content}`)
    .join("\n\n");

  const userPrompt = `${historyText ? `HISTÓRICO:\n${historyText}\n\n` : ""}PERGUNTA DO USUÁRIO: ${message}`;

  const response = await callAi({
    userId,
    type: "CHAT",
    systemPrompt,
    userPrompt,
    temperature: 0.7,
    maxTokens: 2000,
  });

  return {
    message: response.content,
    tokenUsage: response.tokenUsage,
  };
}
