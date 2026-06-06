/**
 * financial-tools.ts
 * 
 * Tools de function calling para o chat financeiro (Lume).
 * Cada tool faz queries Prisma e cálculos determinísticos no servidor,
 * eliminando erros de soma e confusão receita/despesa pelo LLM.
 * 
 * Caminho no projeto: server/modules/ai/financial-tools.ts
 */

import { prisma } from "../../shared/database.js";
import { getDREProfile } from "../../shared/dre-profiles.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

// ============================================
// HELPERS (mesma lógica do ai.controller.ts)
// ============================================

function getEffectiveDate(tx: any): Date {
  if (tx.tipo_transacao === "EXPENSE") {
    return tx.detail?.paymentDate || tx.date;
  } else {
    return tx.detail?.receiptDate || tx.date;
  }
}

function formatMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatBRL(value: number): string {
  return `R$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDateBR(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

function parseMonthRange(mes: string): { start: Date; end: Date } {
  const [year, month] = mes.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1)); // primeiro dia do mês seguinte
  return { start, end };
}

// ============================================
// TOOL SCHEMAS (OpenAI function calling format)
// ============================================

export const financialToolSchemas: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "buscar_transacoes",
      description: "Busca transações financeiras filtradas por tipo (receita/despesa), status (pago/pendente/atrasado), período e opcionalmente por categoria ou descrição. Retorna a lista de transações E o total já calculado. Use SEMPRE esta tool quando o usuário perguntar sobre custos, receitas, despesas, gastos, faturamento de um período específico.",
      parameters: {
        type: "object",
        properties: {
          tipo: {
            type: "string",
            enum: ["INCOME", "EXPENSE", "ALL"],
            description: "Tipo da transação. INCOME = receitas. EXPENSE = despesas/custos. ALL = ambos.",
          },
          status: {
            type: "string",
            enum: ["COMPLETED", "PENDING", "OVERDUE", "ALL"],
            description: "Status. COMPLETED = já pagas/recebidas. PENDING = pendentes. OVERDUE = em atraso. ALL = todos os status.",
          },
          mes: {
            type: "string",
            description: "Mês no formato YYYY-MM (ex: 2026-04). Se não informado, retorna todos os meses.",
          },
          categoria: {
            type: "string",
            description: "Nome da categoria para filtrar (ex: 'Salários e Pró-Labore'). Opcional.",
          },
          descricao: {
            type: "string",
            description: "Texto para buscar na descrição da transação (ex: 'aluguel', 'energia'). Busca parcial, case-insensitive. Opcional.",
          },
          limite: {
            type: "number",
            description: "Número máximo de transações a retornar. Padrão: 50.",
          },
        },
        required: ["tipo", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "obter_resumo_mes",
      description: "Retorna o resumo financeiro completo de um mês: total de receitas, total de despesas, saldo líquido, quantidade de transações, e top 5 categorias de receita e despesa. Use quando o usuário perguntar sobre o desempenho geral de um mês.",
      parameters: {
        type: "object",
        properties: {
          mes: {
            type: "string",
            description: "Mês no formato YYYY-MM (ex: 2026-04)",
          },
        },
        required: ["mes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "obter_dre_mensal",
      description: "Retorna o DRE (Demonstrativo de Resultado) completo de um mês: Receita Bruta, Deduções da Receita, Receita Líquida, Custos Diretos (CMV/CSP/CPV conforme setor), Lucro Bruto, Despesas Operacionais, Resultado Operacional, IRPJ/CSLL, Resultado Líquido, Margem Bruta e Margem Líquida. Use quando o usuário perguntar sobre margens, lucratividade, DRE ou resultado do mês.",
      parameters: {
        type: "object",
        properties: {
          mes: {
            type: "string",
            description: "Mês no formato YYYY-MM (ex: 2026-04)",
          },
        },
        required: ["mes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "comparar_meses",
      description: "Compara dois meses lado a lado: receita, despesa, saldo, margens, e as maiores variações por categoria. Use quando o usuário perguntar para comparar meses ou sobre evolução.",
      parameters: {
        type: "object",
        properties: {
          mes_atual: {
            type: "string",
            description: "Mês mais recente no formato YYYY-MM",
          },
          mes_anterior: {
            type: "string",
            description: "Mês de referência para comparação no formato YYYY-MM",
          },
        },
        required: ["mes_atual", "mes_anterior"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "obter_contas_pendentes",
      description: "Lista todas as contas a pagar e a receber que ainda estão pendentes ou em atraso, com totais calculados. Use quando o usuário perguntar sobre contas a pagar, contas a receber, inadimplência, atrasos, ou fluxo futuro.",
      parameters: {
        type: "object",
        properties: {
          tipo: {
            type: "string",
            enum: ["INCOME", "EXPENSE", "ALL"],
            description: "Filtrar por tipo. INCOME = a receber. EXPENSE = a pagar. ALL = ambos.",
          },
          apenas_atrasados: {
            type: "boolean",
            description: "Se true, retorna apenas transações em atraso (vencimento < hoje).",
          },
        },
        required: ["tipo"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "obter_evolucao_mensal",
      description: "Retorna a evolução financeira mês a mês dos últimos N meses: receita, despesa, saldo líquido e saldo acumulado. Use quando o usuário perguntar sobre tendências, evolução, histórico ou gráficos.",
      parameters: {
        type: "object",
        properties: {
          meses: {
            type: "number",
            description: "Quantidade de meses para retornar. Padrão: 6.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "obter_resumo_empresa",
      description: "Retorna dados básicos da empresa e KPIs gerais: nome, setor, total de receitas/despesas acumulado, saldo de caixa, receita média mensal, burn rate e runway. Use como contexto inicial ou quando o usuário perguntar sobre a saúde geral da empresa.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buscar_por_categoria",
      description: "Detalha todas as transações de uma categoria específica em um período, com total calculado. Use quando o usuário perguntar sobre uma categoria específica (ex: 'quanto gastei com marketing?', 'detalhe os salários').",
      parameters: {
        type: "object",
        properties: {
          categoria: {
            type: "string",
            description: "Nome da categoria (ex: 'Marketing Digital', 'Salários e Pró-Labore')",
          },
          mes: {
            type: "string",
            description: "Mês no formato YYYY-MM. Se não informado, retorna todos os meses.",
          },
          status: {
            type: "string",
            enum: ["COMPLETED", "PENDING", "ALL"],
            description: "Filtrar por status. Padrão: ALL.",
          },
        },
        required: ["categoria"],
      },
    },
  },
];

// ============================================
// TOOL HANDLERS
// ============================================

export async function executeFinancialTool(
  toolName: string,
  args: Record<string, any>,
  companyId: string
): Promise<string> {
  try {
    switch (toolName) {
      case "buscar_transacoes":
        return await handleBuscarTransacoes(args, companyId);
      case "obter_resumo_mes":
        return await handleObterResumoMes(args, companyId);
      case "obter_dre_mensal":
        return await handleObterDREMensal(args, companyId);
      case "comparar_meses":
        return await handleCompararMeses(args, companyId);
      case "obter_contas_pendentes":
        return await handleObterContasPendentes(args, companyId);
      case "obter_evolucao_mensal":
        return await handleObterEvolucaoMensal(args, companyId);
      case "obter_resumo_empresa":
        return await handleObterResumoEmpresa(args, companyId);
      case "buscar_por_categoria":
        return await handleBuscarPorCategoria(args, companyId);
      default:
        return JSON.stringify({ error: `Tool desconhecida: ${toolName}` });
    }
  } catch (error: any) {
    return JSON.stringify({ error: `Erro ao executar ${toolName}: ${error.message}` });
  }
}

// ============================================
// HANDLER: buscar_transacoes
// ============================================
async function handleBuscarTransacoes(args: Record<string, any>, companyId: string): Promise<string> {
  const { tipo, status, mes, categoria, descricao, limite = 50 } = args;

  // Montar where clause
  const where: any = { companyId };

  if (tipo !== "ALL") {
    where.tipo_transacao = tipo;
  }

  if (status !== "ALL") {
    if (status === "OVERDUE") {
      where.status = { in: ["PENDING", "OVERDUE"] };
    } else {
      where.status = status;
    }
  }

  if (descricao) {
    where.description = { contains: descricao, mode: "insensitive" };
  }

  if (categoria) {
    where.category = { name: { contains: categoria, mode: "insensitive" } };
  }

  const transactions = await prisma.transaction.findMany({
    where,
    include: {
      category: { select: { name: true, code: true } },
      detail: { select: { paymentDate: true, receiptDate: true, dueDate: true } },
      counterparty: { select: { name: true } },
    },
    orderBy: { date: "desc" },
    take: Math.min(limite, 100),
  });

  // Filtrar por mês usando data efetiva (regime de caixa) para COMPLETED
  // Para PENDING/OVERDUE, usar dueDate
  let filtered = transactions;
  if (mes) {
    const { start, end } = parseMonthRange(mes);
    filtered = transactions.filter((t) => {
      let dateToCheck: Date;
      if (t.status === "COMPLETED") {
        dateToCheck = getEffectiveDate(t);
      } else {
        dateToCheck = t.detail?.dueDate || t.date;
      }
      return dateToCheck >= start && dateToCheck < end;
    });
  }

  // Calcular totais no servidor (determinístico!)
  const total = filtered.reduce((sum, t) => sum + Number(t.amount), 0);
  const totalReceitas = filtered.filter(t => t.tipo_transacao === "INCOME").reduce((sum, t) => sum + Number(t.amount), 0);
  const totalDespesas = filtered.filter(t => t.tipo_transacao === "EXPENSE").reduce((sum, t) => sum + Number(t.amount), 0);

  // Formatar transações para o LLM
  const items = filtered.map((t) => {
    const effectiveDate = t.status === "COMPLETED" ? getEffectiveDate(t) : (t.detail?.dueDate || t.date);
    return {
      data: formatDateBR(effectiveDate),
      tipo: t.tipo_transacao === "INCOME" ? "Receita" : "Despesa",
      categoria: t.category?.name || "Não classificado",
      descricao: t.description,
      valor: formatBRL(Number(t.amount)),
      valor_numerico: Number(t.amount),
      status: t.status,
      contraparte: t.counterparty?.name || null,
      tipo_custo: t.tipo_custo || null,
    };
  });

  return JSON.stringify({
    quantidade: filtered.length,
    total_geral: formatBRL(total),
    total_receitas: formatBRL(totalReceitas),
    total_despesas: formatBRL(totalDespesas),
    filtros_aplicados: { tipo, status, mes: mes || "todos", categoria: categoria || "todas", descricao: descricao || null },
    transacoes: items,
  });
}

// ============================================
// HANDLER: obter_resumo_mes
// ============================================
async function handleObterResumoMes(args: Record<string, any>, companyId: string): Promise<string> {
  const { mes } = args;
  const { start, end } = parseMonthRange(mes);

  // Transações COMPLETED do mês (regime de caixa)
  const allTx = await prisma.transaction.findMany({
    where: { companyId, status: "COMPLETED" },
    include: { category: { select: { name: true } }, detail: true },
  });

  const monthTx = allTx.filter((t) => {
    const d = getEffectiveDate(t);
    return d >= start && d < end;
  });

  const receitas = monthTx.filter(t => t.tipo_transacao === "INCOME");
  const despesas = monthTx.filter(t => t.tipo_transacao === "EXPENSE");

  const totalReceitas = receitas.reduce((s, t) => s + Number(t.amount), 0);
  const totalDespesas = despesas.reduce((s, t) => s + Number(t.amount), 0);
  const saldoLiquido = totalReceitas - totalDespesas;

  // Top 5 categorias
  const catReceitas: Record<string, number> = {};
  receitas.forEach(t => {
    const cat = t.category?.name || "Não classificado";
    catReceitas[cat] = (catReceitas[cat] || 0) + Number(t.amount);
  });

  const catDespesas: Record<string, number> = {};
  despesas.forEach(t => {
    const cat = t.category?.name || "Não classificado";
    catDespesas[cat] = (catDespesas[cat] || 0) + Number(t.amount);
  });

  const top5Receitas = Object.entries(catReceitas)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([nome, valor]) => ({ nome, valor: formatBRL(valor) }));

  const top5Despesas = Object.entries(catDespesas)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([nome, valor]) => ({ nome, valor: formatBRL(valor) }));

  // Pendentes do mês
  const pendingTx = await prisma.transaction.findMany({
    where: { companyId, status: { in: ["PENDING", "OVERDUE"] } },
    include: { detail: true },
  });

  const pendingMonth = pendingTx.filter(t => {
    const d = t.detail?.dueDate || t.date;
    return d >= start && d < end;
  });

  const pendingReceitas = pendingMonth.filter(t => t.tipo_transacao === "INCOME").reduce((s, t) => s + Number(t.amount), 0);
  const pendingDespesas = pendingMonth.filter(t => t.tipo_transacao === "EXPENSE").reduce((s, t) => s + Number(t.amount), 0);

  return JSON.stringify({
    mes,
    realizados: {
      total_receitas: formatBRL(totalReceitas),
      total_despesas: formatBRL(totalDespesas),
      saldo_liquido: formatBRL(saldoLiquido),
      qtd_transacoes: monthTx.length,
      top5_receitas: top5Receitas,
      top5_despesas: top5Despesas,
    },
    pendentes: {
      receitas_previstas: formatBRL(pendingReceitas),
      despesas_previstas: formatBRL(pendingDespesas),
      qtd_pendentes: pendingMonth.length,
    },
    consolidado: {
      receitas_total_estimado: formatBRL(totalReceitas + pendingReceitas),
      despesas_total_estimado: formatBRL(totalDespesas + pendingDespesas),
      saldo_estimado: formatBRL((totalReceitas + pendingReceitas) - (totalDespesas + pendingDespesas)),
    },
  });
}

// ============================================
// HANDLER: obter_dre_mensal
// ============================================
async function handleObterDREMensal(args: Record<string, any>, companyId: string): Promise<string> {
  const { mes } = args;
  const { start, end } = parseMonthRange(mes);

  const company = await prisma.company.findUnique({ where: { id: companyId } });
  const dreProfile = getDREProfile(company?.sector || "MISTO");
  const directCostCodes = dreProfile.directCostCodes || ["3."];
  const excludeFromDirectCost = dreProfile.excludeFromDirectCost || [];
  const taxCodes = dreProfile.taxCodes || ["8.1", "8.2", "8.3", "8.4"];
  const incomeTaxCodes = dreProfile.incomeTaxCodes || ["8.5", "8.7"];

  const isDirectCost = (code: string): boolean => {
    const isDirect = directCostCodes.some((prefix: string) => code.startsWith(prefix));
    const isExcluded = excludeFromDirectCost.some((prefix: string) => code.startsWith(prefix));
    return isDirect && !isExcluded;
  };

  const isTaxCode = (code: string): boolean => {
    return taxCodes.some((prefix: string) => code.startsWith(prefix));
  };
  const isIncomeTaxCode = (code: string): boolean => {
    return incomeTaxCodes.some((prefix: string) => code.startsWith(prefix));
  };

  const allTx = await prisma.transaction.findMany({
    where: { companyId, status: "COMPLETED" },
    include: { category: { select: { name: true, code: true } }, detail: true },
  });

  const monthTx = allTx.filter((t) => {
    const d = getEffectiveDate(t);
    return d >= start && d < end;
  });

  // Agrupar por código de categoria
  const byCatCode: Record<string, number> = {};
  monthTx.forEach((t) => {
    let catCode = t.category?.code || "0.0";
    const catPrefix = catCode.split(".")[0];
    if (catCode === "0.0") {
      catCode = t.tipo_transacao === "INCOME" ? "2.5" : "5.0";
    } else if (t.tipo_transacao === "EXPENSE" && (catPrefix === "1" || catPrefix === "2")) {
      catCode = "5.0";
    } else if (t.tipo_transacao === "INCOME" && parseInt(catPrefix) >= 3) {
      catCode = "2.5";
    }
    byCatCode[catCode] = (byCatCode[catCode] || 0) + Number(t.amount);
  });

  // Calcular DRE
  const receita = Object.entries(byCatCode)
    .filter(([k]) => k.startsWith("1.") || k.startsWith("2."))
    .reduce((sum, [, v]) => sum + v, 0);

  const custosDiretos = Object.entries(byCatCode)
    .filter(([k]) => isDirectCost(k))
    .reduce((sum, [, v]) => sum + v, 0);

  const impostos = Object.entries(byCatCode)
    .filter(([k]) => isTaxCode(k))
    .reduce((sum, [, v]) => sum + v, 0);

  const incomeTaxes = Object.entries(byCatCode)
    .filter(([k]) => isIncomeTaxCode(k))
    .reduce((sum, [, v]) => sum + v, 0);

  const opex = Object.entries(byCatCode)
    .filter(([k]) => {
      const prefix = k.split(".")[0];
      if (!["3", "4", "5", "6", "7", "8", "9"].includes(prefix)) return false;
      return !isDirectCost(k) && !isTaxCode(k) && !isIncomeTaxCode(k);
    })
    .reduce((sum, [, v]) => sum + v, 0);

  const receitaLiquida = receita - impostos;
  const lucroBruto = receitaLiquida - custosDiretos;
  const resultadoOperacional = lucroBruto - opex;
  const resultadoLiquido = resultadoOperacional - incomeTaxes;
  const margemBruta = receita > 0 ? (lucroBruto / receita) * 100 : 0;
  const margemLiquida = receita > 0 ? (resultadoLiquido / receita) * 100 : 0;

  return JSON.stringify({
    mes,
    setor: company?.sector || "MISTO",
    dre: {
      receita_bruta: formatBRL(receita),
      deducoes_receita: formatBRL(impostos),
      receita_liquida: formatBRL(receitaLiquida),
      custos_diretos: formatBRL(custosDiretos),
      label_custos_diretos: dreProfile.directCostLabel,
      lucro_bruto: formatBRL(lucroBruto),
      despesas_operacionais: formatBRL(opex),
      resultado_operacional: formatBRL(resultadoOperacional),
      irpj_csll: formatBRL(incomeTaxes),
      resultado_liquido: formatBRL(resultadoLiquido),
      margem_bruta: `${margemBruta.toFixed(1)}%`,
      margem_liquida: `${margemLiquida.toFixed(1)}%`,
    },
    nota: "Margem Bruta = (Receita Líquida - Custos Diretos) / Receita Bruta. IRPJ/CSLL não reduz o Lucro Bruto; entra após Resultado Operacional para chegar ao Resultado Líquido.",
  });
}

// ============================================
// HANDLER: comparar_meses
// ============================================
async function handleCompararMeses(args: Record<string, any>, companyId: string): Promise<string> {
  const { mes_atual, mes_anterior } = args;

  // Buscar DRE de ambos os meses
  const dreAtual = JSON.parse(await handleObterDREMensal({ mes: mes_atual }, companyId));
  const dreAnterior = JSON.parse(await handleObterDREMensal({ mes: mes_anterior }, companyId));

  // Buscar resumo de ambos
  const resumoAtual = JSON.parse(await handleObterResumoMes({ mes: mes_atual }, companyId));
  const resumoAnterior = JSON.parse(await handleObterResumoMes({ mes: mes_anterior }, companyId));

  // Calcular variações
  const parseValue = (str: string): number => {
    return parseFloat(str.replace("R$ ", "").replace(/\./g, "").replace(",", ".")) || 0;
  };

  const receitaAtual = parseValue(resumoAtual.realizados.total_receitas);
  const receitaAnterior = parseValue(resumoAnterior.realizados.total_receitas);
  const despesaAtual = parseValue(resumoAtual.realizados.total_despesas);
  const despesaAnterior = parseValue(resumoAnterior.realizados.total_despesas);

  const varReceita = receitaAnterior > 0 ? ((receitaAtual - receitaAnterior) / receitaAnterior * 100) : 0;
  const varDespesa = despesaAnterior > 0 ? ((despesaAtual - despesaAnterior) / despesaAnterior * 100) : 0;

  // Top variações por categoria de despesa
  const catAtual = resumoAtual.realizados.top5_despesas || [];
  const catAnterior = resumoAnterior.realizados.top5_despesas || [];

  return JSON.stringify({
    comparacao: {
      mes_atual,
      mes_anterior,
      receita: {
        atual: resumoAtual.realizados.total_receitas,
        anterior: resumoAnterior.realizados.total_receitas,
        variacao: `${varReceita > 0 ? "+" : ""}${varReceita.toFixed(1)}%`,
      },
      despesa: {
        atual: resumoAtual.realizados.total_despesas,
        anterior: resumoAnterior.realizados.total_despesas,
        variacao: `${varDespesa > 0 ? "+" : ""}${varDespesa.toFixed(1)}%`,
      },
      margem_bruta: {
        atual: dreAtual.dre.margem_bruta,
        anterior: dreAnterior.dre.margem_bruta,
      },
      margem_liquida: {
        atual: dreAtual.dre.margem_liquida,
        anterior: dreAnterior.dre.margem_liquida,
      },
    },
    top5_despesas_atual: catAtual,
    top5_despesas_anterior: catAnterior,
  });
}

// ============================================
// HANDLER: obter_contas_pendentes
// ============================================
async function handleObterContasPendentes(args: Record<string, any>, companyId: string): Promise<string> {
  const { tipo, apenas_atrasados = false } = args;
  const now = new Date();

  const where: any = {
    companyId,
    status: { in: ["PENDING", "OVERDUE"] },
  };

  if (tipo !== "ALL") {
    where.tipo_transacao = tipo;
  }

  const transactions = await prisma.transaction.findMany({
    where,
    include: {
      category: { select: { name: true } },
      detail: { select: { dueDate: true } },
      counterparty: { select: { name: true } },
    },
    orderBy: { date: "asc" },
  });

  // Filtrar atrasados se solicitado
  let filtered = transactions;
  if (apenas_atrasados) {
    filtered = transactions.filter(t => {
      const dueDate = t.detail?.dueDate;
      return dueDate && new Date(dueDate) < now;
    });
  }

  const receivables = filtered.filter(t => t.tipo_transacao === "INCOME");
  const payables = filtered.filter(t => t.tipo_transacao === "EXPENSE");

  const totalRecebiveis = receivables.reduce((s, t) => s + Number(t.amount), 0);
  const totalPagaveis = payables.reduce((s, t) => s + Number(t.amount), 0);

  // Detectar atrasos
  const overdueReceivables = receivables.filter(t => {
    const dueDate = t.detail?.dueDate;
    return dueDate && new Date(dueDate) < now;
  });
  const overduePayables = payables.filter(t => {
    const dueDate = t.detail?.dueDate;
    return dueDate && new Date(dueDate) < now;
  });

  const formatItem = (t: any) => {
    const dueDate = t.detail?.dueDate || t.date;
    const isOverdue = t.detail?.dueDate && new Date(t.detail.dueDate) < now;
    return {
      vencimento: formatDateBR(new Date(dueDate)),
      descricao: t.description,
      categoria: t.category?.name || "Não classificado",
      valor: formatBRL(Number(t.amount)),
      contraparte: t.counterparty?.name || "Não identificado",
      em_atraso: isOverdue,
    };
  };

  return JSON.stringify({
    resumo: {
      total_a_receber: formatBRL(totalRecebiveis),
      qtd_a_receber: receivables.length,
      total_a_pagar: formatBRL(totalPagaveis),
      qtd_a_pagar: payables.length,
      saldo_liquido_pendente: formatBRL(totalRecebiveis - totalPagaveis),
      inadimplencia: {
        receitas_em_atraso: overdueReceivables.length,
        valor_receitas_atraso: formatBRL(overdueReceivables.reduce((s, t) => s + Number(t.amount), 0)),
        despesas_em_atraso: overduePayables.length,
        valor_despesas_atraso: formatBRL(overduePayables.reduce((s, t) => s + Number(t.amount), 0)),
      },
    },
    a_receber: receivables.slice(0, 30).map(formatItem),
    a_pagar: payables.slice(0, 30).map(formatItem),
  });
}

// ============================================
// HANDLER: obter_evolucao_mensal
// ============================================
async function handleObterEvolucaoMensal(args: Record<string, any>, companyId: string): Promise<string> {
  const { meses = 6 } = args;

  const allTx = await prisma.transaction.findMany({
    where: { companyId, status: "COMPLETED" },
    include: { detail: true },
  });

  // Agrupar por mês (data efetiva)
  const monthlyData: Record<string, { income: number; expense: number }> = {};
  allTx.forEach((t) => {
    const d = getEffectiveDate(t);
    const mk = formatMonthKey(d);
    if (!monthlyData[mk]) monthlyData[mk] = { income: 0, expense: 0 };
    if (t.tipo_transacao === "INCOME") {
      monthlyData[mk].income += Number(t.amount);
    } else {
      monthlyData[mk].expense += Number(t.amount);
    }
  });

  // Ordenar e pegar últimos N meses
  const sortedKeys = Object.keys(monthlyData).sort();
  const recentKeys = sortedKeys.slice(-meses);

  // Calcular saldo acumulado
  let acumulado = 0;
  const allKeys = Object.keys(monthlyData).sort();
  const acumulados: Record<string, number> = {};
  allKeys.forEach(mk => {
    acumulado += monthlyData[mk].income - monthlyData[mk].expense;
    acumulados[mk] = acumulado;
  });

  const evolucao = recentKeys.map(mk => {
    const d = monthlyData[mk];
    const liquido = d.income - d.expense;
    return {
      mes: mk,
      receita: formatBRL(d.income),
      despesa: formatBRL(d.expense),
      saldo_liquido: formatBRL(liquido),
      saldo_acumulado: formatBRL(acumulados[mk] || 0),
    };
  });

  return JSON.stringify({
    periodo: `Últimos ${recentKeys.length} meses`,
    evolucao,
  });
}

// ============================================
// HANDLER: obter_resumo_empresa
// ============================================
async function handleObterResumoEmpresa(_args: Record<string, any>, companyId: string): Promise<string> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });

  const allTx = await prisma.transaction.findMany({
    where: { companyId, status: "COMPLETED" },
    include: { detail: true },
  });

  const totalIncome = allTx.filter(t => t.tipo_transacao === "INCOME").reduce((s, t) => s + Number(t.amount), 0);
  const totalExpense = allTx.filter(t => t.tipo_transacao === "EXPENSE").reduce((s, t) => s + Number(t.amount), 0);
  const balance = totalIncome - totalExpense;

  // Contar meses com dados
  const months = new Set<string>();
  allTx.forEach(t => {
    const d = getEffectiveDate(t);
    months.add(formatMonthKey(d));
  });
  const monthCount = months.size || 1;

  const avgIncome = totalIncome / monthCount;
  const avgExpense = totalExpense / monthCount;
  const burnRate = avgExpense - avgIncome;
  const runway = burnRate > 0 ? balance / burnRate : Infinity;

  // Mês atual
  const now = new Date();
  const currentMonthKey = formatMonthKey(now);

  // Cenários ativos
  const scenarios = await prisma.scenario.findMany({
    where: { companyId, isActive: true },
  });

  return JSON.stringify({
    empresa: {
      nome: company?.name || "Não informado",
      cnpj: company?.cnpj || "Não informado",
      setor: company?.sector || "Não informado",
      atividade: company?.activity || "Não informada",
    },
    kpis: {
      total_receitas: formatBRL(totalIncome),
      total_despesas: formatBRL(totalExpense),
      saldo_caixa: formatBRL(balance),
      receita_media_mensal: formatBRL(avgIncome),
      despesa_media_mensal: formatBRL(avgExpense),
      burn_rate: burnRate > 0 ? formatBRL(burnRate) + "/mês" : "Caixa positivo",
      runway: runway === Infinity ? "Indefinido (caixa positivo)" : `${runway.toFixed(1)} meses`,
      total_transacoes: allTx.length,
      meses_com_dados: monthCount,
    },
    mes_atual: currentMonthKey,
    cenarios_ativos: scenarios.length,
  });
}

// ============================================
// HANDLER: buscar_por_categoria
// ============================================
async function handleBuscarPorCategoria(args: Record<string, any>, companyId: string): Promise<string> {
  const { categoria, mes, status = "ALL" } = args;

  const where: any = {
    companyId,
    category: { name: { contains: categoria, mode: "insensitive" } },
  };

  if (status !== "ALL") {
    where.status = status;
  }

  const transactions = await prisma.transaction.findMany({
    where,
    include: {
      category: { select: { name: true } },
      detail: { select: { paymentDate: true, receiptDate: true, dueDate: true } },
    },
    orderBy: { date: "desc" },
  });

  // Filtrar por mês se informado
  let filtered = transactions;
  if (mes) {
    const { start, end } = parseMonthRange(mes);
    filtered = transactions.filter((t) => {
      const d = t.status === "COMPLETED" ? getEffectiveDate(t) : (t.detail?.dueDate || t.date);
      return d >= start && d < end;
    });
  }

  const total = filtered.reduce((s, t) => s + Number(t.amount), 0);

  const items = filtered.map(t => {
    const d = t.status === "COMPLETED" ? getEffectiveDate(t) : (t.detail?.dueDate || t.date);
    return {
      data: formatDateBR(d),
      descricao: t.description,
      valor: formatBRL(Number(t.amount)),
      tipo: t.tipo_transacao === "INCOME" ? "Receita" : "Despesa",
      status: t.status,
    };
  });

  return JSON.stringify({
    categoria,
    mes: mes || "todos",
    quantidade: filtered.length,
    total: formatBRL(total),
    transacoes: items,
  });
}
