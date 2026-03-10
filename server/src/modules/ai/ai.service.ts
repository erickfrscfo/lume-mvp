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
Exemplo: se "Consultoria técnica" é classificada como 1.2, TODAS as ocorrências
de "Consultoria técnica" devem ser 1.2. Nunca alterne entre categorias diferentes.

=== PLANO DE CONTAS COMPLETO ===

RECEITAS:
- 1.0 Receita Operacional (genérico)
- 1.1 Venda de Produtos (produtos físicos, mercadorias)
- 1.2 Prestação de Serviços (consultoria, projetos, horas técnicas, assessoria, treinamento)
- 1.3 Assinaturas/Recorrência (mensalidades, retainers, contratos recorrentes)
- 1.4 Comissões Recebidas (intermediação, indicação)
- 2.0 Receita Não Operacional (genérico)
- 2.1 Rendimentos Financeiros (juros recebidos, rendimento de aplicação, CDB, poupança)
- 2.2 Aluguéis Recebidos (imóvel alugado, sublocação)
- 2.3 Venda de Ativos (venda de equipamento, veículo, móvel usado)
- 2.4 Empréstimos Recebidos (empréstimo bancário, aporte de sócio)
- 2.5 Outras Receitas (reembolsos recebidos, receitas diversas)

CUSTOS DIRETOS (CMV) - GRUPO 3.x:
- 3.0 Custos Diretos (genérico)
- 3.1 Matéria-Prima (insumos de produção)
- 3.2 Mercadoria para Revenda (compra de estoque, perdas e avarias de estoque)
- 3.3 Mão de Obra Direta (salário de consultor alocado em projeto, freelancer de projeto, subcontratação para entrega ao cliente)
- 3.4 Frete sobre Vendas (frete de entrega, frete sobre compras, logística, deslocamento para projeto do cliente)
- 3.5 Embalagens (embalagens, caixas)
- 3.6 Serviços de Terceiros - Produção (subcontratação de consultores, terceirização de serviço para cliente)

DESPESAS COM PESSOAL - GRUPO 4.x:
- 4.0 Despesas com Pessoal (genérico)
- 4.1 Salários e Pró-Labore (folha de pagamento, salários, prolabore, pró-labore)
- 4.2 Encargos Trabalhistas (FGTS, INSS funcionário, férias, 13º, rescisão)
- 4.3 Benefícios (vale transporte, vale refeição, plano de saúde, vale alimentação)
- 4.4 Prestadores PJ (pagamento a PJ, nota fiscal de serviço de prestador fixo)
- 4.5 Treinamento e Capacitação (curso, certificação, workshop, evento)

DESPESAS OPERACIONAIS - GRUPO 5.x:
- 5.0 Despesas Operacionais (genérico)
- 5.1 Aluguel e Condomínio (aluguel escritório, aluguel loja, condomínio, IPTU)
- 5.2 Energia e Água (conta de energia, conta de água, conta de luz, gás)
- 5.3 Telecomunicações (internet, telefone, celular corporativo)
- 5.4 Software e Assinaturas (ERP, CRM, SaaS, licença de software, sistema, Slack, Zoom)
- 5.5 Material de Escritório (papelaria, toner)
- 5.6 Manutenção e Reparos (manutenção de equipamento, reparo, conserto)
- 5.7 Seguros (seguro empresarial, seguro de vida)
- 5.8 Transporte e Deslocamento (uber, táxi, estacionamento, combustível)

DESPESAS COMERCIAIS - GRUPO 6.x:
- 6.0 Despesas Comerciais (genérico)
- 6.1 Marketing Digital (Google Ads, Facebook Ads, Instagram Ads, LinkedIn Ads, SEO)
- 6.2 Marketing Offline (evento, feira, material impresso)
- 6.3 Comissões de Vendas (comissão de vendedor, bônus de vendas)
- 6.4 Ferramentas de Vendas (CRM de vendas, ferramenta de prospecção)
- 6.5 Brindes e Amostras (brinde corporativo, amostra grátis)

DESPESAS FINANCEIRAS - GRUPO 7.x:
- 7.0 Despesas Financeiras (genérico)
- 7.1 Juros de Empréstimos (juros bancários, juros de financiamento)
- 7.2 Tarifas Bancárias (tarifa de conta, TED, DOC, Pix empresarial)
- 7.3 Taxas de Cartão/Maquininha (taxa de cartão, taxa Stripe, taxa PagSeguro)
- 7.4 Multas e Juros Pagos (multa por atraso, juros moratórios)
- 7.5 IOF e Encargos (IOF, encargos financeiros)

IMPOSTOS E TRIBUTOS - GRUPO 8.x:
- 8.0 Impostos e Tributos (genérico)
- 8.1 Simples Nacional / DAS (Simples Nacional, DAS, guia DAS)
- 8.2 ISS (ISS, imposto sobre serviço)
- 8.3 ICMS (ICMS)
- 8.4 PIS/COFINS (PIS, COFINS)
- 8.5 IRPJ/CSLL (IRPJ, CSLL, imposto de renda pessoa jurídica)
- 8.6 INSS Patronal (INSS patronal, contribuição previdenciária patronal)
- 8.7 Outros Tributos (taxa de licença, alvará, outros tributos)

INVESTIMENTOS (CAPEX) - GRUPO 9.x:
- 9.1 Equipamentos e Máquinas (computador, notebook, servidor, impressora)
- 9.2 Móveis e Utensílios (mesa, cadeira, armário)
- 9.3 Veículos (carro, moto, van)
- 9.4 Desenvolvimento de Software (desenvolvimento de sistema próprio, app)
- 9.5 Obras e Reformas (reforma do escritório, obra)

=== REGRAS PARA EMPRESAS DE SERVIÇO/CONSULTORIA ===
- Receita de projeto de consultoria, assessoria, mentoria → 1.2
- Receita recorrente (retainer, mensalidade de serviço) → 1.3
- Salário de consultor que trabalha DIRETAMENTE em projetos de clientes → 3.3
- Subcontratação de consultor externo para projeto de cliente → 3.6
- Viagem/deslocamento PARA projeto de cliente → 3.4
- Salário de equipe administrativa/backoffice → 4.1

=== REGRAS PARA COMÉRCIO/VAREJO ===
- Compra de mercadoria, estoque → 3.2
- Perdas e avarias de estoque → 3.2
- Frete sobre compras/vendas → 3.4
- Embalagens → 3.5

=== PROIBIÇÕES ===
- NÃO classifique impostos (Simples, ISS, ICMS, PIS, COFINS, IRPJ) como 4.x — use 8.x
- NÃO classifique salários como 5.x — use 4.1
- NÃO classifique CMV (mercadoria, estoque, frete, embalagem) como 5.x ou 6.x — use 3.x
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
