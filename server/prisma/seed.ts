import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const categories = [
  // RECEITAS
  { code: "1.0", name: "Receita Operacional", type: "INCOME", parentCode: null },
  { code: "1.1", name: "Venda de Produtos", type: "INCOME", parentCode: "1.0" },
  { code: "1.2", name: "Prestação de Serviços", type: "INCOME", parentCode: "1.0" },
  { code: "1.3", name: "Assinaturas/Recorrência", type: "INCOME", parentCode: "1.0" },
  { code: "1.4", name: "Comissões Recebidas", type: "INCOME", parentCode: "1.0" },
  { code: "2.0", name: "Receita Não Operacional", type: "INCOME", parentCode: null },
  { code: "2.1", name: "Rendimentos Financeiros", type: "INCOME", parentCode: "2.0" },
  { code: "2.2", name: "Aluguéis Recebidos", type: "INCOME", parentCode: "2.0" },
  { code: "2.3", name: "Venda de Ativos", type: "INCOME", parentCode: "2.0" },
  { code: "2.4", name: "Empréstimos Recebidos", type: "INCOME", parentCode: "2.0" },
  { code: "2.5", name: "Outras Receitas", type: "INCOME", parentCode: "2.0" },
  // CUSTOS DIRETOS
  { code: "3.0", name: "Custos Diretos", type: "EXPENSE", parentCode: null },
  { code: "3.1", name: "Matéria-Prima", type: "EXPENSE", parentCode: "3.0" },
  { code: "3.2", name: "Mercadoria para Revenda", type: "EXPENSE", parentCode: "3.0" },
  { code: "3.3", name: "Mão de Obra Direta", type: "EXPENSE", parentCode: "3.0" },
  { code: "3.4", name: "Frete sobre Vendas", type: "EXPENSE", parentCode: "3.0" },
  { code: "3.5", name: "Embalagens", type: "EXPENSE", parentCode: "3.0" },
  { code: "3.6", name: "Serviços de Terceiros (Produção)", type: "EXPENSE", parentCode: "3.0" },
  // DESPESAS COM PESSOAL
  { code: "4.0", name: "Despesas com Pessoal", type: "EXPENSE", parentCode: null },
  { code: "4.1", name: "Salários e Pró-Labore", type: "EXPENSE", parentCode: "4.0" },
  { code: "4.2", name: "Encargos Trabalhistas", type: "EXPENSE", parentCode: "4.0" },
  { code: "4.3", name: "Benefícios", type: "EXPENSE", parentCode: "4.0" },
  { code: "4.4", name: "Prestadores PJ", type: "EXPENSE", parentCode: "4.0" },
  { code: "4.5", name: "Treinamento e Capacitação", type: "EXPENSE", parentCode: "4.0" },
  { code: "4.6", name: "INSS Patronal", type: "EXPENSE", parentCode: "4.0" },
  // DESPESAS OPERACIONAIS
  { code: "5.0", name: "Despesas Operacionais", type: "EXPENSE", parentCode: null },
  { code: "5.1", name: "Aluguel e Condomínio", type: "EXPENSE", parentCode: "5.0" },
  { code: "5.2", name: "Energia e Água", type: "EXPENSE", parentCode: "5.0" },
  { code: "5.3", name: "Telecomunicações", type: "EXPENSE", parentCode: "5.0" },
  { code: "5.4", name: "Software e Assinaturas", type: "EXPENSE", parentCode: "5.0" },
  { code: "5.5", name: "Material de Escritório", type: "EXPENSE", parentCode: "5.0" },
  { code: "5.6", name: "Manutenção e Reparos", type: "EXPENSE", parentCode: "5.0" },
  { code: "5.7", name: "Seguros", type: "EXPENSE", parentCode: "5.0" },
  { code: "5.8", name: "Transporte e Deslocamento", type: "EXPENSE", parentCode: "5.0" },
  // DESPESAS COMERCIAIS
  { code: "6.0", name: "Despesas Comerciais", type: "EXPENSE", parentCode: null },
  { code: "6.1", name: "Marketing Digital", type: "EXPENSE", parentCode: "6.0" },
  { code: "6.2", name: "Marketing Offline", type: "EXPENSE", parentCode: "6.0" },
  { code: "6.3", name: "Comissões de Vendas", type: "EXPENSE", parentCode: "6.0" },
  { code: "6.4", name: "Ferramentas de Vendas", type: "EXPENSE", parentCode: "6.0" },
  { code: "6.5", name: "Brindes e Amostras", type: "EXPENSE", parentCode: "6.0" },
  // DESPESAS FINANCEIRAS
  { code: "7.0", name: "Despesas Financeiras", type: "EXPENSE", parentCode: null },
  { code: "7.1", name: "Juros de Empréstimos", type: "EXPENSE", parentCode: "7.0" },
  { code: "7.2", name: "Tarifas Bancárias", type: "EXPENSE", parentCode: "7.0" },
  { code: "7.3", name: "Taxas de Cartão/Maquininha", type: "EXPENSE", parentCode: "7.0" },
  { code: "7.4", name: "Multas e Juros Pagos", type: "EXPENSE", parentCode: "7.0" },
  { code: "7.5", name: "IOF e Encargos", type: "EXPENSE", parentCode: "7.0" },
  // IMPOSTOS
  { code: "8.0", name: "Impostos e Tributos", type: "EXPENSE", parentCode: null },
  { code: "8.1", name: "Simples Nacional / DAS", type: "EXPENSE", parentCode: "8.0" },
  { code: "8.2", name: "ISS", type: "EXPENSE", parentCode: "8.0" },
  { code: "8.3", name: "ICMS", type: "EXPENSE", parentCode: "8.0" },
  { code: "8.4", name: "PIS/COFINS", type: "EXPENSE", parentCode: "8.0" },
  { code: "8.5", name: "IRPJ/CSLL", type: "EXPENSE", parentCode: "8.0" },
  // 8.6 removido — INSS Patronal movido para 4.6 (Despesas com Pessoal)
  { code: "8.7", name: "Outros Tributos", type: "EXPENSE", parentCode: "8.0" },
  // INVESTIMENTOS
  { code: "9.0", name: "Investimentos (Capex)", type: "EXPENSE", parentCode: null },
  { code: "9.1", name: "Equipamentos e Máquinas", type: "EXPENSE", parentCode: "9.0" },
  { code: "9.2", name: "Móveis e Utensílios", type: "EXPENSE", parentCode: "9.0" },
  { code: "9.3", name: "Veículos", type: "EXPENSE", parentCode: "9.0" },
  { code: "9.4", name: "Desenvolvimento de Software", type: "EXPENSE", parentCode: "9.0" },
  { code: "9.5", name: "Obras e Reformas", type: "EXPENSE", parentCode: "9.0" },
];

async function main() {
  console.log("🌱 Iniciando seed de categorias contábeis...");

  // Criar categorias pai primeiro
  const parentCategories = categories.filter((c) => c.parentCode === null);
  for (const cat of parentCategories) {
    await prisma.category.upsert({
      where: { code: cat.code },
      update: {},
      create: {
        code: cat.code,
        name: cat.name,
        type: cat.type as any,
        isDefault: true,
      },
    });
  }

  // Criar subcategorias
  const childCategories = categories.filter((c) => c.parentCode !== null);
  for (const cat of childCategories) {
    const parent = await prisma.category.findUnique({ where: { code: cat.parentCode! } });
    await prisma.category.upsert({
      where: { code: cat.code },
      update: {},
      create: {
        code: cat.code,
        name: cat.name,
        type: cat.type as any,
        parentId: parent?.id,
        isDefault: true,
      },
    });
  }

  // Criar templates de prompts
  await prisma.promptTemplate.upsert({
    where: { name_version: { name: "classification", version: 1 } },
    update: {},
    create: {
      name: "classification",
      type: "CLASSIFICATION",
      version: 1,
      content: `Você é um contador especializado em classificação contábil para PMEs brasileiras.
Classifique cada transação em uma das categorias fornecidas.
Retorne APENAS um JSON array com objetos contendo: id, categoryCode, confidence (0-1).`,
      isActive: true,
    },
  });

  await prisma.promptTemplate.upsert({
    where: { name_version: { name: "explanation", version: 1 } },
    update: {},
    create: {
      name: "explanation",
      type: "EXPLANATION",
      version: 1,
      content: `Você é um CFO virtual chamado Lume que explica finanças para empreendedores leigos.
Use linguagem simples, sem jargões técnicos. Dê exemplos práticos do dia a dia.
Responda em JSON com: summary, details, recommendation.`,
      isActive: true,
    },
  });

  await prisma.promptTemplate.upsert({
    where: { name_version: { name: "chat", version: 1 } },
    update: {},
    create: {
      name: "chat",
      type: "CHAT",
      version: 1,
      content: `Você é o Lume, um CFO virtual inteligente. Responda perguntas financeiras
de forma clara e acessível para empreendedores sem formação em finanças.`,
      isActive: true,
    },
  });

  console.log(`✅ ${categories.length} categorias criadas`);
  console.log("✅ 3 templates de prompts criados");
  console.log("🎉 Seed concluído com sucesso!");
}

main()
  .catch((e) => {
    console.error("❌ Erro no seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
