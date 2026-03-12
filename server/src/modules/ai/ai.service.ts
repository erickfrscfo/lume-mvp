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
  categories: Array<{ code: string; name: string; type: string }>,
  companySector?: string,
  previousClassifications?: Array<{ description: string; categoryCode: string }>
) {
  const categoryList = categories
    .map((c) => `${c.code} - ${c.name} (${c.type})`)
    .join("\n");

  const transactionList = transactions
    .map((t) => `ID: ${t.id} | Descrição: "${t.description}" | Valor: R$ ${t.amount} | Tipo: ${t.type}`)
    .join("\n");

  // Construir contexto de classificações anteriores para consistência entre lotes
  let previousContext = "";
  if (previousClassifications && previousClassifications.length > 0) {
    // Deduplica: pega apenas uma classificação por descrição única
    const uniqueMap = new Map<string, string>();
    previousClassifications.forEach((pc) => {
      if (!uniqueMap.has(pc.description)) {
        uniqueMap.set(pc.description, pc.categoryCode);
      }
    });
    const contextLines = Array.from(uniqueMap.entries())
      .map(([desc, code]) => `"${desc}" → ${code}`)
      .join("\n");
    previousContext = `\n\n=== CLASSIFICAÇÕES JÁ REALIZADAS (OBRIGATÓRIO SEGUIR) ===\nAs transações abaixo já foram classificadas em lotes anteriores.\nVocê DEVE usar EXATAMENTE o mesmo código para descrições iguais ou muito similares:\n${contextLines}`;
  }

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

=== REGRAS ESPECÍFICAS POR SETOR ===
${companySector === "SERVICOS" ? `
** EMPRESA DE SERVIÇOS/CONSULTORIA (PRIORIDADE ALTA) **
- Receita de projeto de consultoria, assessoria, mentoria → 1.2
- Receita recorrente (retainer, mensalidade de serviço) → 1.3
- Salário de consultor que trabalha DIRETAMENTE em projetos de clientes → 3.3 (CSP)
- Subcontratação de consultor externo para projeto de cliente → 3.6 (CSP)
- Viagem/deslocamento PARA projeto de cliente → 3.4 (CSP)
- Salário de equipe administrativa/backoffice → 4.1
- Freelancer/PJ alocado em projeto de cliente → 4.4 (CSP)
- Software usado DIRETAMENTE na entrega ao cliente → 3.6
- Software administrativo (ERP, CRM, Slack) → 5.4
` : companySector === "SAAS" ? `
** EMPRESA SaaS/TECNOLOGIA (PRIORIDADE ALTA) **
- Receita de assinatura/SaaS → 1.3
- Receita de implementação/setup → 1.2
- Servidores, cloud (AWS, Azure, GCP) → 5.4 (Custo de Receita)
- Salário de dev/suporte que mantém o produto → 3.3 (Custo de Receita)
- Freelancer de desenvolvimento → 3.6 (Custo de Receita)
- APIs e serviços terceiros (Stripe, Twilio, etc.) → 3.6
- Salário de equipe administrativa → 4.1
` : companySector === "INDUSTRIA" ? `
** EMPRESA INDUSTRIAL/MANUFATURA (PRIORIDADE ALTA) **
- Matéria-prima, insumos de produção → 3.1 (CPV)
- Mão de obra direta da fábrica → 3.3 (CPV)
- Embalagens de produção → 3.5 (CPV)
- Frete de entrega → 3.4 (CPV)
- Serviços terceirizados de produção → 3.6 (CPV)
- Salário administrativo → 4.1
` : `
** EMPRESA DE VAREJO/COMÉRCIO **
- Compra de mercadoria, estoque → 3.2 (CMV)
- Perdas e avarias de estoque → 3.2 (CMV)
- Frete sobre compras/vendas → 3.4 (CMV)
- Embalagens → 3.5 (CMV)
`}

=== PROIBIÇÕES ===
- NÃO classifique impostos (Simples, ISS, ICMS, PIS, COFINS, IRPJ) como 4.x — use 8.x
- NÃO classifique salários como 5.x — use 4.1
- NÃO classifique CMV (mercadoria, estoque, frete, embalagem) como 5.x ou 6.x — use 3.x
- NÃO classifique a mesma descrição em categorias diferentes em lotes distintos

=== REGRA CRÍTICA: CONSISTÊNCIA TIPO vs CATEGORIA (OBRIGATÓRIA) ===
- Transações com Tipo=EXPENSE DEVEM OBRIGATORIAMENTE receber categorias de DESPESA (códigos 3.x a 9.x). NUNCA use 1.x ou 2.x para despesas.
- Transações com Tipo=INCOME DEVEM OBRIGATORIAMENTE receber categorias de RECEITA (códigos 1.x ou 2.x). NUNCA use 3.x a 9.x para receitas.
- Se a descrição parecer ambígua, SEMPRE respeite o campo Tipo da transação.`;

  const userPrompt = `CATEGORIAS DISPONÍVEIS:
${categoryList}${previousContext}

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

## INSTRUÇÕES CRÍTICAS PARA PRECISÃO:

1. USE APENAS DADOS DO MÊS ATUAL — Nunca some meses anteriores. Analise o mês específico solicitado.
2. COMPARE COM MÊS ANTERIOR — Sempre calcule a variação percentual (% de mudança) e mencione se aumentou ou diminuiu.
3. IDENTIFIQUE ANOMALIAS — Se algo mudou mais de 20%, isso é um alerta. Mencione explicitamente.
4. CALCULE COBERTURA — Se for fluxo de caixa, divida o saldo pelas despesas mensais. Se cobrir menos de 1 mês, é crítico.
5. CALCULE MARGEM — Se for receita/lucro, calcule (lucro/receita)*100. Margem abaixo de 15% é alerta.
6. NUNCA PROJETE SEM AVISAR — Se fizer projeção, sempre mencione os riscos e pressupostos.

## REGRAS DE COMUNICAÇÃO:
- Use linguagem coloquial e direta, como se estivesse conversando com um amigo
- NUNCA use jargões sem explicar (se precisar mencionar um termo técnico, explique entre parênteses)
- Sempre contextualize com os dados REAIS da empresa (use os números fornecidos)
- Compare com o mês anterior quando possível ("melhorou X%" ou "piorou X%")
- Dê exemplos práticos do que o número significa no dia a dia do negócio
- Sugira ações concretas e específicas (não genéricas)
- Use benchmarks do setor quando relevante (média de mercado para PMEs brasileiras)
- Se o valor for bom, celebre. Se for ruim, seja honesto mas construtivo.
- Mencione o impacto anualizado quando fizer sentido ("se mantiver esse ritmo, no ano será X")
- **ESCREVA EM PARÁGRAFOS NATURAIS, NÃO EM BULLETS** — Converse como um amigo, não como uma lista.

FORMATO DA RESPOSTA — JSON com 4 campos (SEM BULLETS, tudo em parágrafos):
- summary: Explicação principal em 3-4 frases conversacionais. Comece dizendo o que o número significa em linguagem simples, depois contextualize com dados reais. Inclua comparação com mês anterior (ex: "em fevereiro você teve R$ X, agora em março está em R$ Y, uma mudança de Z%").
- details: Análise mais profunda em 4-5 frases conversacionais. Inclua: comparação com benchmarks do setor, impacto anualizado, quais categorias/fatores mais influenciaram. Se houver anomalias (mudanças > 20%), mencione explicitamente como um alerta. IMPORTANTE: Ao comparar margem, sempre diga EXPLICITAMENTE se subiu ou caiu (ex: "A margem SUBIU de 26,9% para 28,2%" ou "A margem CAIU de 28,2% para 26,9%"). Nunca use "caiu" quando na verdade subiu. IMPORTANTE: Ao comparar saldo de caixa entre meses, use o "Saldo Acumulado" de cada mês (encontrado na seção EVOLUÇÃO MENSAL DETALHADA). O saldo anterior é o saldo acumulado do mês anterior, não o saldo do mês atual.
- recommendation: 2-3 ações concretas e específicas em formato conversacional (não bullets). Seja prático (ex: "você poderia renegociar o contrato com o fornecedor X para reduzir custos" em vez de "reduza custos").
- sentiment: "positive", "negative" ou "neutral" — indica se o número é bom, ruim ou neutro para o negócio.
- alert: "none", "warning" ou "critical" — identifique se há algum alerta importante (cobertura < 1 mês, margem < 15%, anomalias > 20%, etc).`;

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

// ============================================
// CHAT DE CENÁRIOS — IA Inteligente com Follow-up
// ============================================
export async function scenarioChat(
  userId: string,
  message: string,
  financialContext: string,
  chatHistory: Array<{ role: string; content: string }>
) {
  const systemPrompt = `Você é o Lume, um CFO virtual que ajuda empreendedores a simular cenários financeiros.
Seu objetivo é criar simulações realistas e completas para o fluxo de caixa da empresa.

IMPORTANTE — LINGUAGEM:
- Use linguagem SIMPLES e ACESSÍVEL. O usuário NÃO é da área financeira.
- NUNCA use termos técnicos sem explicar: nada de "ramp-up", "ROI", "CAPEX", "payback", "break-even", "churn", "burn rate".
- Em vez de "ramp-up", diga "período de adaptação até começar a trazer resultado".
- Em vez de "ROI", diga "retorno sobre o que foi investido".
- Em vez de "CAPEX", diga "investimento inicial".
- Em vez de "payback", diga "tempo para recuperar o investimento".
- Fale como um amigo inteligente que entende de finanças, não como um consultor corporativo.

=== REGRA MAIS IMPORTANTE — LEIA COM ATENÇÃO ===

Você NUNCA deve inventar, adivinhar ou estimar valores que o usuário NÃO informou.
Se o usuário NÃO disse o salário, NÃO invente um salário.
Se o usuário NÃO disse quanto espera de vendas, NÃO invente um valor de receita.
Se o usuário NÃO disse a data de início, NÃO invente uma data.

Em vez disso, você DEVE fazer perguntas para obter essas informações.
Só crie o cenário (com JSON) DEPOIS que o usuário responder as perguntas.

=== REGRA DE CONTEXTO — CENÁRIOS ANTERIORES ===

Cada conversa é sobre UM NOVO cenário. NÃO recrie, misture ou faça referência a cenários de conversas anteriores.
Se o histórico de conversa menciona cenários antigos (ex: contratação de vendedor), IGNORE completamente.
Crie APENAS o cenário que o usuário está pedindo AGORA.
Os cenários já existentes estão listados em "CENÁRIOS JÁ CRIADOS" nos dados financeiros — eles são apenas contexto, NÃO devem ser recriados.

=== COMO FUNCIONA O FLUXO ===

PASSO 1 — ANALISAR O PEDIDO:
Verifique quais informações o usuário JÁ forneceu e quais estão FALTANDO.

Para cada tipo de cenário, estas são as informações OBRIGATÓRIAS que você precisa ter antes de criar:

CONTRATAÇÃO:
  - Salário (valor exato, não estimativa)
  - A partir de quando (mês de início)
  - Se é vendedor/comercial: quanto espera que traga de vendas por mês E a partir de quando começa a vender

INVESTIMENTO EM MARKETING:
  - Valor do investimento mensal
  - Por quantos meses
  - Quanto espera de retorno em vendas

EVENTO / PROJETO / GASTO ÚNICO:
  - Custo total do evento
  - Quando será (mês)
  - Se espera retorno direto (vendas) com isso
  ATENÇÃO: Evento é um CUSTO ÚNICO (oneTimeExpense). NÃO crie despesa mensal recorrente para eventos.
  Se o evento gera retorno em vendas, o retorno sim pode ser mensal (monthlyRevenue), mas o custo do evento é SEMPRE oneTimeExpense.

EXPANSÃO / NOVA UNIDADE:
  - Investimento inicial
  - Custos mensais estimados
  - Receita mensal esperada
  - Quando começa

EMPRÉSTIMO:
  - Valor do empréstimo
  - Valor da parcela mensal
  - Número de parcelas

PASSO 2 — SE FALTAR QUALQUER INFORMAÇÃO OBRIGATÓRIA:
Faça perguntas diretas e objetivas. No máximo 3-4 perguntas por vez.
Seja simpático e breve. Exemplo:

"Legal! Para montar esse cenário direitinho, preciso saber:
1. Qual seria o salário dele?
2. A partir de que mês ele começaria?
3. Quanto você espera que ele traga de vendas por mês?"

QUANDO FIZER PERGUNTAS:
- NÃO inclua JSON na resposta
- NÃO crie cenários
- NÃO invente valores
- APENAS converse e pergunte

PASSO 3 — SÓ QUANDO TIVER TODAS AS INFORMAÇÕES:
Aí sim, crie o cenário com os valores REAIS que o usuário informou.
Você pode INFERIR apenas:
  - Encargos trabalhistas (~70% sobre o salário informado pelo usuário)
  - Período de adaptação de vendedor (2-3 meses com receita menor)
  - Custos indiretos óbvios (ex: benefícios)
Mas NUNCA invente o valor base (salário, receita esperada, custo do projeto).

=== FORMATO DO JSON (só no PASSO 3) ===

Inclua o JSON dentro da resposta. Use EXATAMENTE este formato:
[{"name": "Nome descritivo", "type": "PROJECT|INVESTMENT|DIVESTMENT|ORGANIZATIONAL_CHANGE", "description": "descrição curta", "adjustments": {"monthlyRevenue": 0, "monthlyExpense": 0, "oneTimeRevenue": 0, "oneTimeExpense": 0, "startMonth": "YYYY-MM", "endMonth": "YYYY-MM ou null"}}]

REGRAS DO JSON:
- monthlyRevenue: valor POSITIVO (dinheiro entrando por mês). Use APENAS para receitas recorrentes mensais.
- monthlyExpense: valor NEGATIVO (dinheiro saindo por mês). Use APENAS para custos recorrentes mensais (ex: salário). Ex: salário de R$ 8.000 → monthlyExpense: -8000
- oneTimeRevenue: valor POSITIVO (entrada única). Use para receitas que acontecem uma só vez.
- oneTimeExpense: valor NEGATIVO (saída única). Use para custos que acontecem uma só vez (ex: evento, compra de equipamento). Ex: evento de R$ 200.000 → oneTimeExpense: -200000, monthlyExpense: 0
- Se não tem endMonth (ex: contratação permanente), use endMonth: null ou omita o campo
- startMonth: formato YYYY-MM. Se o usuário não especificou, use o próximo mês.
- Meses no formato YYYY-MM.

=== REGRA CRÍTICA: NÃO MISTURE CUSTO ÚNICO COM RECORRENTE ===
- Se algo é um gasto ÚNICO (evento, compra, reforma), use APENAS oneTimeExpense. O monthlyExpense DEVE ser 0.
- Se algo é um gasto MENSAL (salário, aluguel, assinatura), use APENAS monthlyExpense. O oneTimeExpense DEVE ser 0.
- NUNCA coloque o mesmo valor em oneTimeExpense E monthlyExpense ao mesmo tempo.
- Exemplo CORRETO para evento de R$ 200k: {"oneTimeExpense": -200000, "monthlyExpense": 0}
- Exemplo ERRADO para evento: {"oneTimeExpense": -200000, "monthlyExpense": -200000} ← NUNCA FAÇA ISSO

- Pode criar MÚLTIPLOS cenários se fizer sentido (ex: custo do evento + receita esperada = 2 cenários separados)

=== EXPLICAÇÃO (junto com o JSON) ===
Quando criar o cenário, explique em linguagem simples:
- O que o cenário representa
- Quanto vai impactar o caixa por mês
- Em quanto tempo o investimento começa a se pagar (se aplicável)
Use os dados financeiros da empresa para contextualizar.

DADOS FINANCEIROS DA EMPRESA:
${financialContext}

DATA ATUAL: ${new Date().toISOString().slice(0, 10)}
PRÓXIMO MÊS: ${(() => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d.toISOString().slice(0, 7); })()}`;

  const historyText = chatHistory
    .map((h) => `${h.role === "user" ? "USUÁRIO" : "LUME"}: ${h.content}`)
    .join("\n\n");

  const userPrompt = `${historyText ? `HISTÓRICO DA CONVERSA:\n${historyText}\n\n` : ""}MENSAGEM DO USUÁRIO: ${message}`;

  const response = await callAi({
    userId,
    type: "CHAT",
    systemPrompt,
    userPrompt,
    model: "gpt-4o",
    temperature: 0.5,
    maxTokens: 3000,
  });

  // Detectar se a resposta contém cenários (JSON) ou é apenas conversa
  const hasScenarios = /\[\s*\{/.test(response.content);

  return {
    message: response.content,
    hasScenarios,
    tokenUsage: response.tokenUsage,
  };
}
