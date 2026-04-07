import OpenAI from "openai";
import { env } from "../../config/env.js";
import { prisma } from "../../shared/database.js";
import { AiInteractionType } from "@prisma/client";
import {
  resolveCompanyCategories,
  formatCategoriesForPrompt,
  type ResolvedCategory,
} from "../../shared/resolve-categories.js";

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

interface CompanyContext {
  sector: string;
  activity?: string | null;
  useCustomChart: boolean;
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

// ============================================
// HELPER: Buscar contexto da empresa
// ============================================
async function getCompanyContext(companyId: string): Promise<CompanyContext> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { sector: true, activity: true, useCustomChart: true },
  });
  return {
    sector: company?.sector || "MISTO",
    activity: company?.activity,
    useCustomChart: company?.useCustomChart ?? false,
  };
}

// ============================================
// HELPER: Gerar regras por setor + atividade
// ============================================
function buildSectorRules(sector: string, activity?: string | null): string {
  let rules = "";

  switch (sector) {
    case "SERVICOS":
      rules = `
** EMPRESA DE SERVIÇOS/CONSULTORIA (PRIORIDADE ALTA) **
- Receita de projeto de consultoria, assessoria, mentoria → 1.2
- Receita recorrente (retainer, mensalidade de serviço) → 1.3
- Salário de consultor que trabalha DIRETAMENTE em projetos de clientes → 3.3 (CSP)
- Subcontratação de consultor externo para projeto de cliente → 3.6 (CSP)
- Viagem/deslocamento PARA projeto de cliente → 3.4 (CSP)
- Salário de equipe administrativa/backoffice → 4.1
- Freelancer/PJ alocado em projeto de cliente → 4.4 (CSP)
- Software usado DIRETAMENTE na entrega ao cliente → 3.6
- Software administrativo (ERP, CRM, Slack) → 5.4`;
      break;

    case "SAAS":
      rules = `
** EMPRESA SaaS/TECNOLOGIA (PRIORIDADE ALTA) **
- Receita de assinatura/SaaS → 1.3
- Receita de implementação/setup → 1.2
- Servidores, cloud (AWS, Azure, GCP) → 5.4 (Custo de Receita)
- Salário de dev/suporte que mantém o produto → 3.3 (Custo de Receita)
- Freelancer de desenvolvimento → 3.6 (Custo de Receita)
- APIs e serviços terceiros (Stripe, Twilio, etc.) → 3.6
- Salário de equipe administrativa → 4.1`;
      break;

    case "INDUSTRIA":
      rules = `
** EMPRESA INDUSTRIAL/MANUFATURA (PRIORIDADE ALTA) **
- Matéria-prima, insumos de produção → 3.1 (CPV)
- Mão de obra direta da fábrica → 3.3 (CPV)
- Embalagens de produção → 3.5 (CPV)
- Frete de entrega → 3.4 (CPV)
- Serviços terceirizados de produção → 3.6 (CPV)
- Salário administrativo → 4.1`;
      break;

    case "ECOMMERCE":
      rules = `
** EMPRESA E-COMMERCE (PRIORIDADE ALTA) **
- Venda de produtos online → 1.1
- Compra de mercadoria, estoque → 3.2 (CMV)
- Frete de entrega ao cliente → 3.4 (CMV)
- Embalagens para envio → 3.5 (CMV)
- Perdas e avarias de estoque → 3.2 (CMV)
- Taxas de marketplace (Mercado Livre, Shopee, Amazon) → 7.3
- Plataforma de e-commerce (Shopify, VTEX, Nuvemshop) → 5.4
- Gateway de pagamento (Stripe, PagSeguro, Mercado Pago) → 7.3
- Marketing digital (Google Ads, Facebook Ads) → 6.1
- Logística reversa (devoluções) → 3.4
- Salário administrativo → 4.1`;
      break;

    default: // VAREJO, MISTO
      rules = `
** EMPRESA DE VAREJO/COMÉRCIO **
- Compra de mercadoria, estoque → 3.2 (CMV)
- Perdas e avarias de estoque → 3.2 (CMV)
- Frete sobre compras/vendas → 3.4 (CMV)
- Embalagens → 3.5 (CMV)`;
      break;
  }

  // Adicionar contexto de atividade se disponível
  if (activity) {
    rules += `\n\n** ATIVIDADE PRINCIPAL DA EMPRESA: "${activity}" **
Use essa informação para desambiguar classificações. Exemplo:
- Se a atividade é "consultoria tributária", receitas de serviço provavelmente são 1.2 (Prestação de Serviços)
- Se a atividade é "varejo de moda", compras de mercadoria são 3.2 (Mercadoria para Revenda)
- Priorize categorias que façam sentido para essa atividade específica.`;
  }

  return rules;
}

// ============================================
// HELPER: Montar plano de contas para o prompt
// ============================================
function buildChartOfAccountsPrompt(categories: ResolvedCategory[]): string {
  const incomeGroups = categories.filter(c => c.type === "INCOME" && !c.parentCode);
  const expenseGroups = categories.filter(c => c.type === "EXPENSE" && !c.parentCode);

  let text = "=== PLANO DE CONTAS COMPLETO ===\n\n";

  text += "RECEITAS:\n";
  for (const group of incomeGroups) {
    text += `- ${group.code} ${group.name} (genérico)\n`;
    const children = categories.filter(c => c.parentCode === group.code && c.type === "INCOME");
    for (const child of children) {
      text += `- ${child.code} ${child.name}\n`;
    }
  }

  text += "\nDESPESAS:\n";
  for (const group of expenseGroups) {
    text += `- ${group.code} ${group.name} (genérico)\n`;
    const children = categories.filter(c => c.parentCode === group.code && c.type === "EXPENSE");
    for (const child of children) {
      text += `- ${child.code} ${child.name}\n`;
    }
  }

  return text;
}

// ============================================
// Classificar transações — CONTEXTUALIZADO POR EMPRESA
// ============================================
export async function classifyTransactions(
  userId: string,
  companyId: string,
  transactions: Array<{ id: string; description: string; amount: number; type: string }>,
  previousClassifications?: Array<{ description: string; categoryCode: string }>
) {
  // Buscar contexto da empresa
  const companyCtx = await getCompanyContext(companyId);

  // Resolver categorias (customizadas ou globais)
  const resolvedCategories = await resolveCompanyCategories(companyId);

  const categoryList = resolvedCategories
    .map((c) => `${c.code} - ${c.name} (${c.type})`)
    .join("\n");

  const transactionList = transactions
    .map((t) => `ID: ${t.id} | Descrição: "${t.description}" | Valor: R$ ${t.amount} | Tipo: ${t.type}`)
    .join("\n");

  // Construir contexto de classificações anteriores para consistência entre lotes
  let previousContext = "";
  if (previousClassifications && previousClassifications.length > 0) {
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

  // Montar plano de contas dinâmico
  const chartPrompt = buildChartOfAccountsPrompt(resolvedCategories);

  // Montar regras por setor + atividade
  const sectorRules = buildSectorRules(companyCtx.sector, companyCtx.activity);

  const systemPrompt = `Você é um contador especializado em classificação contábil para PMEs brasileiras.
Classifique cada transação abaixo em uma das categorias fornecidas.
Retorne APENAS um JSON array com objetos contendo: id, categoryCode, confidence (0-1).
Não inclua explicações, apenas o JSON.

=== REGRA DE CONSISTÊNCIA (OBRIGATÓRIA) ===
Trasações com a MESMA descrição DEVEM SEMPRE receber o MESMO código de categoria.
Exemplo: se "Consultoria técnica" é classificada como 1.2, TODAS as ocorrências
de "Consultoria técnica" devem ser 1.2. Nunca alterne entre categorias diferentes.

${chartPrompt}

=== REGRAS ESPECÍFICAS POR SETOR ===
${sectorRules}

=== REGRAS DE DESAMBIGUAÇÃO (PRIORIDADE MÁXIMA) ===

** PADRÃO 1 — SERVIÇOS BASEADOS EM APLICATIVO vs TELECOMUNICAÇÕES **
A natureza do gasto define a categoria, NÃO a forma de contratação (app/digital).
- Uber, 99, Cabify, táxi, Uber Corporativo → 5.8 Transporte e Deslocamento (NUNCA 5.3)
- iFood, Rappi, Uber Eats, VR, VA, vale-alimentação → 4.3 Benefícios (NUNCA 5.3)
- Plano de Saúde, Unimed, Amil, SulAmérica, dental, saúde corporativa → 4.3 Benefícios (NUNCA 5.3)
- Telecomunicações (5.3) é EXCLUSIVAMENTE para: telefonia fixa/móvel, internet fibra/banda larga, planos de celular corporativo
- REGRA: Se o serviço é contratado via app mas a NATUREZA é transporte → 5.8. Se é alimentação → 4.3. Se é saúde → 4.3.

** PADRÃO 2 — CONTAS DE CONSUMO: NATUREZA DO SERVIÇO, NÃO FORMA DE COBRANÇA **
Não agrupe "contas" genéricas. Classifique pela natureza do serviço:
- Conta de Energia, Eletricidade, CPFL, Enel, Light → 5.2 Energia e Água
- Conta de Água, Sabesp, Copasa, CEDAE → 5.2 Energia e Água
- Internet, Fibra, Banda Larga, Vivo Fibra, NET, Tim Live → 5.3 Telecomunicações (NUNCA 5.2)
- Telefone, Celular Corporativo, Plano Vivo/Tim/Claro → 5.3 Telecomunicações
- REGRA: Internet NÃO é Energia e Água. Internet é Telecomunicações (5.3).

** PADRÃO 3 — DESPESAS COM PESSOAL (GRUPO 4.x) — SUBCATEGORIAS OBRIGATÓRIAS **
O grupo 4.x tem subcategorias específicas. NÃO misture:
- 4.1 Salários e Pró-Labore: APENAS salário bruto, folha de pagamento, pró-labore de sócios, 13º salário, férias
- 4.2 Encargos Trabalhistas: FGTS, multa FGTS, contribuição sindical, INSS funcionário (retido). FGTS NUNCA é 4.1.
- 4.3 Benefícios: Plano de saúde, plano dental, vale-alimentação (VA), vale-refeição (VR), vale-transporte (VT), seguro de vida de funcionários, alimentação corporativa, coffee break
- 4.5 Treinamento e Capacitação: Cursos, workshops, treinamentos, certificações, capacitação, palestras, eventos de treinamento
- 4.6 INSS Patronal: APENAS a contribuição patronal do INSS (parte da empresa). NÃO confundir com INSS retido do funcionário (4.2).
- REGRA: FGTS → SEMPRE 4.2. Plano de Saúde → SEMPRE 4.3. Cursos → SEMPRE 4.5. Alimentação/Coffee → SEMPRE 4.3.

** PADRÃO 4 — IMPOSTOS E TRIBUTOS (GRUPO 8.x) — DESAMBIGUAÇÃO OBRIGATÓRIA **
- 8.1 Simples Nacional / DAS: APENAS para empresas optantes do Simples Nacional. Se a descrição menciona ISS, PIS, COFINS, IRPJ, CSLL separadamente, NÃO é Simples Nacional.
- 8.2 ISS: Imposto Sobre Serviços, recolhido separadamente (Lucro Presumido/Real)
- 8.4 PIS/COFINS: Contribuições federais, recolhidas separadamente
- Se a descrição menciona "ISS/PIS/COFINS" ou "Impostos Trimestrais", classifique como 8.4 PIS/COFINS (maior componente). NUNCA como 8.1 DAS.
- Se a descrição menciona APENAS "ISS", use 8.2. Se menciona APENAS "PIS" ou "COFINS", use 8.4.
- REGRA: Empresa de Lucro Presumido/Real NUNCA paga DAS (8.1). Use 8.2, 8.4 ou 8.7.

** PADRÃO 5 — SERVIÇOS GERAIS vs MANUTENÇÃO **
- Manutenção e Reparos (5.6): APENAS conserto de equipamentos, reparos em instalações, manutenção preventiva de máquinas
- Serviço de Limpeza, faxina, conservação → 5.1 Aluguel e Condomínio (custo de ocupação)
- Serviços Gráficos, impressão de materiais, folders, cartões → 5.5 Material de Escritório
- REGRA: Limpeza NÃO é Manutenção. Gráfica NÃO é Manutenção.

** PADRÃO 6 — TRANSPORTE E DESLOCAMENTO (5.8) **
- Uber, 99, táxi, corridas de app → 5.8
- Estacionamento, vaga de garagem corporativa → 5.8
- Combustível, gasolina, diesel, abastecimento → 5.8
- Pedágio, IPVA (se frota) → 5.8
- Viagens, hospedagem, passagens aéreas → 5.8
- REGRA: Estacionamento Corporativo é Transporte (5.8), NÃO Aluguel (5.1).

** PADRÃO 7 — CONDOMÍNIO E OCUPAÇÃO **
- Condomínio, taxa condominial, IPTU, prestação de contas condominial → 5.1 Aluguel e Condomínio
- Se a descrição contém "condomínio" ou "condominial" → SEMPRE 5.1

=== PROIBIÇÕES ===
- NÃO classifique impostos (Simples, ISS, ICMS, PIS, COFINS, IRPJ) como 4.x — use 8.x
- NÃO classifique INSS Patronal como 8.x — use 4.6 (Despesas com Pessoal)
- NÃO classifique salários como 5.x — use 4.1
- NÃO classifique CMV (mercadoria, estoque, frete, embalagem) como 5.x ou 6.x — use 3.x
- NÃO classifique a mesma descrição em categorias diferentes em lotes distintos
- NÃO classifique Uber/99/táxi como Telecomunicações — use 5.8
- NÃO classifique Plano de Saúde como Telecomunicações — use 4.3
- NÃO classifique FGTS como Salários — use 4.2
- NÃO classifique Internet como Energia e Água — use 5.3
- NÃO classifique Estacionamento como Aluguel — use 5.8
- NÃO classifique Cursos/Treinamentos como Material de Escritório — use 4.5
- NÃO classifique ISS/PIS/COFINS como Simples Nacional/DAS — use 8.2 ou 8.4

=== REGRA CRÍTICA: CONSISTÊNCIA TIPO vs CATEGORIA (OBRIGATÓRIA) ===
- Transações com Tipo=EXPENSE DEVEM OBRIGATORIAMENTE receber categorias de DESPESA (códigos 3.x a 9.x). NUNCA use 1.x ou 2.x para despesas.
- Transações com Tipo=INCOME DEVEM OBRIGATORIAMENTE receber categorias de RECEITA (códigos 1.x ou 2.x). NUNCA use 3.x a 9.x para receitas.
- Se a descrição parecer ambígua, SEMPRE respeite o campo Tipo da transação.

=== USE APENAS OS CÓDIGOS DO PLANO DE CONTAS ACIMA ===
Não invente códigos. Use APENAS os códigos listados no plano de contas.`;

  const userPrompt = `CATEGORIAS DISPONÍVEIS:
${categoryList}${previousContext}

TRANSAÇÕES PARA CLASSIFICAR:
${transactionList}

Classifique cada transação. Retorne APENAS o JSON array.`;

  const response = await callAi({
    userId,
    type: "CLASSIFICATION",
    systemPrompt,
    userPrompt,
    temperature: 0.1,
  });

  try {
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
// Classificar tipo de custo (fixo/variável)
// ============================================
export async function classifyCostType(
  userId: string,
  transactions: Array<{ id: string; description: string; amount: number; categoryName?: string }>,
  companyActivity?: string | null
) {
  const transactionList = transactions
    .map((t) => {
      const category = t.categoryName ? ` | Categoria: ${t.categoryName}` : "";
      return `ID: ${t.id} | Descrição: "${t.description}" | Valor: R$ ${t.amount}${category}`;
    })
    .join("\n");

  const activityContext = companyActivity
    ? `\n\n=== CONTEXTO DA EMPRESA ===\nAtividade principal: "${companyActivity}"\nUse essa informação para desambiguar custos. Exemplo: para uma empresa de consultoria, "viagem a cliente" pode ser custo variável (proporcional a projetos).`
    : "";

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
${activityContext}

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
    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
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

/// Explicar métrica (Explica pra Mim) — com contexto de setor/atividade
export async function explainMetric(
  userId: string,
  metric: string,
  value: string,
  financialContext: string,
  companyContext?: { sector?: string; activity?: string | null }
) {
  const sectorInfo = companyContext
    ? `\n\nSETOR DA EMPRESA: ${companyContext.sector || "Não informado"}${companyContext.activity ? `\nATIVIDADE PRINCIPAL: ${companyContext.activity}` : ""}\nUse essas informações para contextualizar benchmarks e recomendações específicas do setor.`
    : "";

  const systemPrompt = `Você é o Lume, um CFO virtual que traduz finanças para empreendedores que NÃO são da área financeira.

Sua missão é transformar números abstratos em narrativas acionáveis. O empreendedor não precisa de jargões financeiros — ele precisa saber se o negócio está saudável.
${sectorInfo}

## INSTRUÇÕES CRÍTICAS PARA PRECISÃO:

1. USE APENAS DADOS DO MÊS ATUAL — Nunca some meses anteriores. Analise o mês específico solicitado.
2. COMPARE COM MÊS ANTERIOR — Sempre calcule a variação percentual (% de mudança) e mencione se aumentou ou diminuiu.
3. IDENTIFIQUE ANOMALIAS — Se algo mudou mais de 20%, isso é um alerta. Mencione explicitamente.
4. CALCULE COBERTURA — Se for fluxo de caixa, divida o saldo pelas despesas mensais. Se cobrir menos de 1 mês, é crítico.
5. CALCULE MARGEM — Margem Bruta = (Receita Bruta - Custos Diretos - Impostos) / Receita. Margem Líquida = (Lucro Bruto - Opex) / Receita. Use os valores de margem fornecidos no contexto. Margem líquida abaixo de 15% é alerta.
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

// Chat da Reunião Executiva — com contexto de setor/atividade
export async function chat(
  userId: string,
  message: string,
  financialContext: string,
  chatHistory: Array<{ role: string; content: string }>,
  companyContext?: { sector?: string; activity?: string | null }
) {
  const sectorInfo = companyContext
    ? `\n\nSETOR DA EMPRESA: ${companyContext.sector || "Não informado"}${companyContext.activity ? `\nATIVIDADE PRINCIPAL: ${companyContext.activity}` : ""}\nUse essas informações para dar respostas mais relevantes ao contexto do negócio.`
    : "";

  const systemPrompt = `Você é o Lume, um CFO virtual inteligente. Seu papel é responder perguntas
financeiras de forma clara e acessível para um empreendedor sem formação em finanças.
${sectorInfo}

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
  chatHistory: Array<{ role: string; content: string }>,
  companyContext?: { sector?: string; activity?: string | null }
) {
  const sectorInfo = companyContext
    ? `\nSETOR DA EMPRESA: ${companyContext.sector || "Não informado"}${companyContext.activity ? `\nATIVIDADE PRINCIPAL: ${companyContext.activity}` : ""}`
    : "";

  const systemPrompt = `Você é o Lume, um CFO virtual que ajuda empreendedores a simular cenários financeiros.
Seu objetivo é criar simulações realistas e completas para o fluxo de caixa da empresa.
${sectorInfo}

IMPORTANTE — LINGUAGEM:
- Use linguagem SIMPLES e ACESSÍVEL. O usuário NÃO é da área financeira.
- NUNCA use termos técnicos sem explicar. Exemplos:
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
