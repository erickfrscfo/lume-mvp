/**
 * Seed script para dados de teste do módulo de conciliação
 * Executar após a migration: npx tsx prisma/seed-conciliation.ts
 * 
 * IMPORTANTE: Este script assume que já existem Company e Transaction no banco.
 * Ele cria: Counterparties, TransactionDetails, Documents e Reconciliations
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Iniciando seed de conciliação...");

  // Buscar a primeira empresa existente
  const company = await prisma.company.findFirst();
  if (!company) {
    console.error("❌ Nenhuma empresa encontrada. Execute o seed principal primeiro.");
    process.exit(1);
  }

  console.log(`📊 Usando empresa: ${company.name} (${company.id})`);

  // Buscar um user da empresa para usar como reconciledBy
  const user = await prisma.user.findFirst({
    where: { companyId: company.id },
  });

  if (!user) {
    console.error("❌ Nenhum usuário encontrado.");
    process.exit(1);
  }

  // =============================================
  // 1. Criar Contrapartes
  // =============================================
  console.log("👥 Criando contrapartes...");

  const counterparties = await Promise.all([
    prisma.counterparty.create({
      data: {
        companyId: company.id,
        name: "Fornecedor ABC Ltda",
        document: "12.345.678/0001-90",
        type: "SUPPLIER",
        email: "contato@fornecedorabc.com.br",
        phone: "(11) 3456-7890",
        notes: "Fornecedor principal de matéria-prima",
      },
    }),
    prisma.counterparty.create({
      data: {
        companyId: company.id,
        name: "Cliente XYZ S.A.",
        document: "98.765.432/0001-10",
        type: "CLIENT",
        email: "financeiro@clientexyz.com.br",
        phone: "(21) 9876-5432",
      },
    }),
    prisma.counterparty.create({
      data: {
        companyId: company.id,
        name: "Tech Solutions ME",
        document: "45.678.901/0001-23",
        type: "SUPPLIER",
        email: "nf@techsolutions.com.br",
        notes: "Serviços de TI e infraestrutura",
      },
    }),
    prisma.counterparty.create({
      data: {
        companyId: company.id,
        name: "Distribuidora Nacional",
        document: "67.890.123/0001-45",
        type: "BOTH",
        email: "comercial@distnacional.com.br",
        phone: "(31) 2345-6789",
      },
    }),
    prisma.counterparty.create({
      data: {
        companyId: company.id,
        name: "Consultoria Estratégica",
        document: "23.456.789/0001-67",
        type: "SUPPLIER",
        email: "projetos@consultoria.com.br",
      },
    }),
  ]);

  console.log(`✅ ${counterparties.length} contrapartes criadas`);

  // =============================================
  // 2. Criar Documentos
  // =============================================
  console.log("📄 Criando documentos...");

  const documents = await Promise.all([
    prisma.document.create({
      data: {
        companyId: company.id,
        counterpartyId: counterparties[0].id,
        type: "INVOICE",
        number: "NF-2024-001",
        issueDate: new Date("2024-11-15"),
        amount: 15000.0,
        description: "Fornecimento de matéria-prima - Lote 45",
      },
    }),
    prisma.document.create({
      data: {
        companyId: company.id,
        counterpartyId: counterparties[1].id,
        type: "INVOICE",
        number: "NF-2024-002",
        issueDate: new Date("2024-11-20"),
        amount: 25000.0,
        description: "Venda de produtos - Pedido #1234",
      },
    }),
    prisma.document.create({
      data: {
        companyId: company.id,
        counterpartyId: counterparties[2].id,
        type: "RECEIPT",
        number: "REC-2024-010",
        issueDate: new Date("2024-12-01"),
        amount: 3500.0,
        description: "Serviço de manutenção de servidores",
      },
    }),
    prisma.document.create({
      data: {
        companyId: company.id,
        type: "BANK_STATEMENT",
        number: "EXT-2024-12",
        issueDate: new Date("2024-12-31"),
        amount: 0,
        description: "Extrato bancário dezembro 2024",
      },
    }),
    prisma.document.create({
      data: {
        companyId: company.id,
        counterpartyId: counterparties[4].id,
        type: "CONTRACT",
        number: "CTR-2024-003",
        issueDate: new Date("2024-10-01"),
        amount: 48000.0,
        description: "Contrato de consultoria estratégica - 12 meses",
      },
    }),
  ]);

  console.log(`✅ ${documents.length} documentos criados`);

  // =============================================
  // 3. Criar TransactionDetails para transações existentes
  // =============================================
  console.log("📋 Criando detalhes de transações...");

  const transactions = await prisma.transaction.findMany({
    where: { companyId: company.id },
    orderBy: { date: "desc" },
    take: 10,
  });

  if (transactions.length === 0) {
    console.log("⚠️ Nenhuma transação encontrada. Pulando criação de detalhes.");
  } else {
    const details = [];
    for (let i = 0; i < Math.min(transactions.length, 8); i++) {
      const tx = transactions[i];
      const statuses = ["PENDING", "RECONCILED", "DIVERGENT", "PENDING", "RECONCILED", "PENDING", "RECONCILED", "PENDING"] as const;
      const counterpartyIdx = i % counterparties.length;

      const detail = await prisma.transactionDetail.create({
        data: {
          transactionId: tx.id,
          counterpartyId: counterparties[counterpartyIdx].id,
          reconciliationStatus: statuses[i],
          dueDate: new Date(tx.date.getTime() + 30 * 24 * 60 * 60 * 1000), // +30 dias
          paymentDate: statuses[i] === "RECONCILED" ? tx.date : null,
          documentNumber: `DOC-${String(i + 1).padStart(3, "0")}`,
          reconciledBy: statuses[i] === "RECONCILED" ? user.id : null,
          reconciledAt: statuses[i] === "RECONCILED" ? new Date() : null,
        },
      });
      details.push(detail);
    }

    console.log(`✅ ${details.length} detalhes de transação criados`);

    // =============================================
    // 4. Criar Reconciliations para os que estão RECONCILED
    // =============================================
    console.log("🔗 Criando conciliações...");

    const reconciledDetails = details.filter(
      (d) => d.reconciliationStatus === "RECONCILED"
    );

    const reconciliations = [];
    for (let i = 0; i < reconciledDetails.length; i++) {
      const detail = reconciledDetails[i];
      const docId = i < documents.length ? documents[i].id : null;

      const reconciliation = await prisma.reconciliation.create({
        data: {
          companyId: company.id,
          transactionDetailId: detail.id,
          documentId: docId,
          method: i === 0 ? "MANUAL" : i === 1 ? "AUTO_EXACT" : "AI_SUGGESTED",
          confidence: i === 1 ? 1.0 : i === 2 ? 0.85 : null,
          notes: i === 0 ? "Conciliação manual pelo CFO" : null,
          reconciledBy: user.id,
        },
      });
      reconciliations.push(reconciliation);
    }

    console.log(`✅ ${reconciliations.length} conciliações criadas`);
  }

  console.log("\n🎉 Seed de conciliação concluído com sucesso!");
  console.log("📊 Resumo:");
  console.log(`   - ${counterparties.length} contrapartes`);
  console.log(`   - ${documents.length} documentos`);
  console.log(`   - Detalhes e conciliações criados para transações existentes`);
}

main()
  .catch((e) => {
    console.error("❌ Erro no seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
