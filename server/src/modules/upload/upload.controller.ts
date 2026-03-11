import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import fs from "fs";
import { authMiddleware } from "../auth/auth.middleware.js";
import { prisma } from "../../shared/database.js";
import * as aiService from "../ai/ai.service.js";
import { generateAlerts } from "../alerts/alerts.controller.js";

const router = Router();

// Helper: parsear data sem problema de timezone (D-1)
function parseLocalDate(dateStr: string | Date): Date {
  if (dateStr instanceof Date) return dateStr;
  if (!dateStr) return new Date();
  if (typeof dateStr === 'string') {
    if (dateStr.includes('T') || dateStr.includes(' ')) return new Date(dateStr);
    if (dateStr.includes('/')) {
      const parts = dateStr.split('/');
      if (parts.length === 3) {
        return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]), 12, 0, 0);
      }
    }
    return new Date(dateStr + 'T12:00:00');
  }
  return new Date(dateStr);
}

// Configurar multer para upload
const upload = multer({
  dest: "/tmp/uploads/",
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["text/csv", "application/vnd.ms-excel", "text/plain"];
    if (allowed.includes(file.mimetype) || file.originalname.endsWith(".csv")) {
      cb(null, true);
    } else {
      cb(new Error("Formato inválido. Envie um arquivo CSV."));
    }
  },
});

// =============================================
// POST /api/upload/csv — Upload CSV com 10 colunas
// Colunas aceitas: data, descricao, valor, tipo, contraparte,
//   vencimento, data_pagamento, data_recebimento, documento, observacao
// Status é derivado: se data_pagamento/data_recebimento preenchida = COMPLETED, senão = PENDING
// =============================================
router.post("/csv", authMiddleware, upload.single("file"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, error: "Nenhum arquivo enviado" });
    }

    const userId = (req as any).userId;
    const companyId = (req as any).companyId;

    // Criar registro de upload
    const uploadRecord = await prisma.upload.create({
      data: {
        userId,
        filename: file.filename,
        originalName: file.originalname,
        status: "PROCESSING",
      },
    });

    // Ler e parsear CSV
    const fileContent = fs.readFileSync(file.path, "utf-8");
    let records: any[];
    try {
      records = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        delimiter: [",", ";"],
        bom: true,
      });
    } catch (parseError: any) {
      await prisma.upload.update({
        where: { id: uploadRecord.id },
        data: { status: "FAILED", errorDetails: { message: parseError.message } },
      });
      fs.unlinkSync(file.path);
      return res.status(422).json({
        success: false,
        error: `Erro ao ler CSV: ${parseError.message}`,
      });
    }

    // Buscar contrapartes existentes para matching
    const existingCounterparties = await prisma.counterparty.findMany({
      where: { companyId },
      select: { id: true, name: true, document: true },
    });

    // Validar e processar registros (10 colunas)
    const errors: Array<{ line: number; error: string }> = [];
    const validTransactions: Array<{
      date: Date;
      description: string;
      amount: number;
      tipo_transacao: "INCOME" | "EXPENSE";
      status: string;
      counterpartyId?: string;
      counterpartyName?: string;
      dueDate?: Date;
      paymentDate?: Date;
      receiptDate?: Date;
      documentNumber?: string;
      notes?: string;
    }> = [];

    records.forEach((record, index) => {
      const line = index + 2;

      // 1. DATA (obrigatório)
      const dateStr = record.data || record.Data || record.DATE || record.date;
      if (!dateStr) {
        errors.push({ line, error: "Campo 'data' ausente" });
        return;
      }
      let date: Date;
      if (dateStr.includes("/")) {
        const dateParts = dateStr.split("/");
        if (dateParts.length !== 3) {
          errors.push({ line, error: `Data inválida: ${dateStr}. Use DD/MM/AAAA` });
          return;
        }
        date = new Date(parseInt(dateParts[2]), parseInt(dateParts[1]) - 1, parseInt(dateParts[0]));
      } else {
        date = parseLocalDate(dateStr);
      }
      if (isNaN(date.getTime())) {
        errors.push({ line, error: `Data inválida: ${dateStr}` });
        return;
      }

      // 2. DESCRIÇÃO (obrigatório)
      const description = record.descricao || record.Descricao || record.DESCRICAO || record.description;
      if (!description) {
        errors.push({ line, error: "Campo 'descricao' ausente" });
        return;
      }

      // 3. VALOR (obrigatório)
      const valorStr = (record.valor || record.Valor || record.VALOR || record.amount || "")
        .toString()
        .replace(",", ".");
      const rawAmount = parseFloat(valorStr);
      if (isNaN(rawAmount) || rawAmount === 0) {
        errors.push({ line, error: `Valor inválido: ${valorStr}` });
        return;
      }
      const amount = Math.abs(rawAmount);
      const isNegativeValue = rawAmount < 0;

      // 4. TIPO (opcional — inferido pelo valor se ausente)
      let tipoStr = (record.tipo || record.Tipo || record.TIPO || record.type || "").toUpperCase();
      if (!tipoStr && isNegativeValue) {
        tipoStr = "SAIDA";
      } else if (!tipoStr && !isNegativeValue) {
        tipoStr = "ENTRADA";
      }
      if (tipoStr !== "ENTRADA" && tipoStr !== "SAIDA" && tipoStr !== "INCOME" && tipoStr !== "EXPENSE") {
        errors.push({ line, error: `Tipo inválido: ${tipoStr}. Use ENTRADA ou SAIDA` });
        return;
      }
      const tipo_transacao = (tipoStr === "ENTRADA" || tipoStr === "INCOME") ? "INCOME" : "EXPENSE";

      // 5. DATA DE PAGAMENTO (opcional — para SAIDA)
      const pagamentoStr = record.data_pagamento || record.Data_Pagamento || record.DATA_PAGAMENTO ||
        record.dataPagamento || record.pagamento || record.Pagamento || "";
      let paymentDate: Date | undefined;
      if (pagamentoStr) {
        if (pagamentoStr.includes("/")) {
          const parts = pagamentoStr.split("/");
          paymentDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
        } else {
          paymentDate = parseLocalDate(pagamentoStr);
        }
        if (isNaN(paymentDate.getTime())) paymentDate = undefined;
      }

      // 5b. DATA DE RECEBIMENTO (opcional — para ENTRADA)
      const recebimentoStr = record.data_recebimento || record.Data_Recebimento || record.DATA_RECEBIMENTO ||
        record.dataRecebimento || record.recebimento || record.Recebimento || "";
      let receiptDate: Date | undefined;
      if (recebimentoStr) {
        if (recebimentoStr.includes("/")) {
          const parts = recebimentoStr.split("/");
          receiptDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
        } else {
          receiptDate = parseLocalDate(recebimentoStr);
        }
        if (isNaN(receiptDate.getTime())) receiptDate = undefined;
      }

      // STATUS DERIVADO: se data de pagamento/recebimento preenchida = COMPLETED, senão = PENDING
      // Também aceita coluna status legada para retrocompatibilidade
      let status = "PENDING";
      if (tipo_transacao === "EXPENSE" && paymentDate) {
        status = "COMPLETED";
      } else if (tipo_transacao === "INCOME" && receiptDate) {
        status = "COMPLETED";
      } else {
        // Retrocompatibilidade: aceitar coluna status se existir
        const statusStr = (record.status || record.Status || record.STATUS || "").toUpperCase();
        const statusMap: Record<string, string> = {
          PENDENTE: "PENDING", PAGO: "COMPLETED", RECEBIDO: "COMPLETED",
          VENCIDO: "OVERDUE", PARCIAL: "PARTIAL",
        };
        if (statusStr) {
          status = statusMap[statusStr] || statusStr;
          // Se status legado diz PAGO/RECEBIDO mas sem data, preencher com data da transação
          if (status === "COMPLETED") {
            if (tipo_transacao === "EXPENSE" && !paymentDate) paymentDate = date;
            if (tipo_transacao === "INCOME" && !receiptDate) receiptDate = date;
          }
        }
      }

      // 6. CONTRAPARTE (opcional — busca por nome ou CNPJ/CPF)
      const counterpartyStr = record.contraparte || record.Contraparte || record.CONTRAPARTE ||
        record.fornecedor || record.Fornecedor || record.cliente || record.Cliente || "";
      let counterpartyId: string | undefined;
      let counterpartyName: string | undefined;
      if (counterpartyStr) {
        counterpartyName = counterpartyStr;
        const match = existingCounterparties.find(
          (cp) =>
            cp.name.toLowerCase() === counterpartyStr.toLowerCase() ||
            cp.document === counterpartyStr.replace(/[.\-/]/g, "")
        );
        if (match) {
          counterpartyId = match.id;
        }
      }

      // 7. VENCIMENTO (opcional)
      const vencimentoStr = record.vencimento || record.Vencimento || record.VENCIMENTO ||
        record.due_date || record.dueDate || "";
      let dueDate: Date | undefined;
      if (vencimentoStr) {
        if (vencimentoStr.includes("/")) {
          const parts = vencimentoStr.split("/");
          dueDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
        } else {
          dueDate = parseLocalDate(vencimentoStr);
        }
        if (isNaN(dueDate.getTime())) dueDate = undefined;
      }

      // 8. DOCUMENTO (opcional — número da NF, boleto, etc)
      const documentNumber = record.documento || record.Documento || record.DOCUMENTO ||
        record.nota_fiscal || record.nf || record.NF || "";

      // 9. OBSERVAÇÃO (opcional)
      const notes = record.observacao || record.Observacao || record.OBSERVACAO ||
        record.notes || record.obs || "";

      validTransactions.push({
        date,
        description,
        amount,
        tipo_transacao,
        status,
        counterpartyId,
        counterpartyName,
        dueDate,
        paymentDate,
        receiptDate,
        documentNumber: documentNumber || undefined,
        notes: notes || undefined,
      });
    });

    // Criar contrapartes que não existem
    const newCounterpartyNames = new Set<string>();
    for (const t of validTransactions) {
      if (t.counterpartyName && !t.counterpartyId) {
        newCounterpartyNames.add(t.counterpartyName);
      }
    }

    const createdCounterparties: Record<string, string> = {};
    for (const name of newCounterpartyNames) {
      try {
        const cp = await prisma.counterparty.create({
          data: {
            companyId,
            name,
            type: "SUPPLIER", // Default, pode ser ajustado depois
          },
        });
        createdCounterparties[name.toLowerCase()] = cp.id;
      } catch (e) {
        // Ignora se já existir
      }
    }

    // Inserir transações válidas no banco
    let createdCount = 0;
    for (const t of validTransactions) {
      try {
        const cpId = t.counterpartyId || createdCounterparties[t.counterpartyName?.toLowerCase() || ""] || null;

        const transaction = await prisma.transaction.create({
          data: {
            companyId,
            uploadId: uploadRecord.id,
            date: t.date,
            description: t.description,
            amount: t.amount,
            tipo_transacao: t.tipo_transacao,
            status: t.status as any,
            source: "UPLOAD",
            counterpartyId: cpId,
            notes: t.notes,
          },
        });

        // Criar detalhe — sempre criar para manter paymentDate/receiptDate
        await prisma.transactionDetail.create({
          data: {
            transactionId: transaction.id,
            counterpartyId: cpId,
            dueDate: t.dueDate,
            paymentDate: t.paymentDate,
            receiptDate: t.receiptDate,
            documentNumber: t.documentNumber,
            amountOriginal: t.amount,
          },
        });

        createdCount++;
      } catch (txError: any) {
        errors.push({ line: 0, error: `Erro ao inserir: ${t.description} - ${txError.message}` });
      }
    }

    // ============================================
    // CLASSIFICAÇÃO DE CATEGORIA (IA) - mantém lógica existente
    // ============================================
    const unclassified = await prisma.transaction.findMany({
      where: { uploadId: uploadRecord.id, categoryId: null },
      select: { id: true, description: true, amount: true, tipo_transacao: true },
    });

    if (unclassified.length > 0) {
      const categories = await prisma.category.findMany({
        select: { code: true, name: true, type: true },
      });

      // Buscar setor da empresa para categorização mais precisa
      const company = await prisma.company.findUnique({
        where: { id: companyId },
        select: { sector: true },
      });
      const companySector = company?.sector || "MISTO";

      const batchSize = 20;
      for (let i = 0; i < unclassified.length; i += batchSize) {
        const batch = unclassified.slice(i, i + batchSize).map((t) => ({
          id: t.id,
          description: t.description,
          amount: Number(t.amount),
          type: t.tipo_transacao,
        }));

        try {
          const classifications = await aiService.classifyTransactions(
            userId,
            batch,
            categories.map((c) => ({ code: c.code, name: c.name, type: c.type })),
            companySector
          );

          for (const classification of classifications) {
            const category = categories.find((c) => c.code === classification.categoryCode);
            if (category) {
              await prisma.transaction.update({
                where: { id: classification.id },
                data: {
                  categoryId: (await prisma.category.findUnique({ where: { code: classification.categoryCode } }))?.id,
                  aiClassified: true,
                  confidence: classification.confidence,
                },
              });
            }
          }
        } catch (aiError) {
          console.error("Erro na classificação IA (lote):", aiError);
        }
      }
    }

    // ============================================
    // CLASSIFICAÇÃO DE TIPO DE CUSTO (IA) - em lotes de 20
    // ============================================
    const unclassifiedExpenses = await prisma.transaction.findMany({
      where: {
        uploadId: uploadRecord.id,
        tipo_transacao: "EXPENSE",
        tipo_custo: null,
      },
      include: { category: true },
    });

    if (unclassifiedExpenses.length > 0) {
      const costBatchSize = 20;
      for (let i = 0; i < unclassifiedExpenses.length; i += costBatchSize) {
        const batch = unclassifiedExpenses.slice(i, i + costBatchSize).map((t) => ({
          id: t.id,
          description: t.description,
          amount: Number(t.amount),
          categoryName: t.category?.name,
        }));

        try {
          const costClassifications = await aiService.classifyCostType(
            userId,
            batch
          );

          for (const costClass of costClassifications) {
            try {
              await prisma.transaction.update({
                where: { id: costClass.id },
                data: {
                  tipo_custo: costClass.costType,
                  costConfidence: costClass.confidence,
                },
              });
            } catch (updateError) {
              console.error(`Erro ao atualizar tipo de custo da transação ${costClass.id}:`, updateError);
            }
          }
        } catch (costClassError) {
          console.error(`Erro na classificação de tipo de custo (lote ${Math.floor(i / costBatchSize) + 1}):`, costClassError);
        }
      }
    }

    // Atualizar status do upload
    const uploadStatus = errors.length === 0 ? "COMPLETED" : validTransactions.length > 0 ? "PARTIAL" : "FAILED";
    await prisma.upload.update({
      where: { id: uploadRecord.id },
      data: {
        status: uploadStatus,
        rowCount: createdCount,
        errorCount: errors.length,
        errorDetails: errors.length > 0 ? errors : undefined,
      },
    });

    // Limpar arquivo temporário
    fs.unlinkSync(file.path);

    // Gerar alertas inteligentes em background
    generateAlerts(companyId, userId).catch((err) => console.error("[Alerts] Erro ao gerar alertas:", err));

    res.json({
      success: true,
      data: {
        uploadId: uploadRecord.id,
        status: uploadStatus,
        totalRows: records.length,
        imported: createdCount,
        errors: errors.length,
        newCounterparties: Object.keys(createdCounterparties).length,
        errorDetails: errors.slice(0, 10),
      },
    });
  } catch (error) {
    next(error);
  }
});

// =============================================
// GET /api/upload/history — Histórico de uploads
// =============================================
router.get("/history", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).userId;
    const uploads = await prisma.upload.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    res.json({ success: true, data: uploads });
  } catch (error) {
    next(error);
  }
});

// =============================================
// GET /api/upload/template — Download template CSV
// =============================================
router.get("/template", authMiddleware, (_req: Request, res: Response) => {
  const header = "data;descricao;valor;tipo;contraparte;vencimento;data_pagamento;data_recebimento;documento;observacao";
  const example1 = "01/01/2025;Pagamento Aluguel;-3500.00;SAIDA;Imobiliária Central;05/01/2025;03/01/2025;;NF-001;Aluguel sede";
  const example2 = "05/01/2025;Recebimento Cliente ABC;12000.00;ENTRADA;ABC Tecnologia;10/01/2025;;08/01/2025;NF-100;Projeto web";
  const example3 = "10/01/2025;Compra Material;-850.50;SAIDA;Papelaria Express;15/01/2025;;;NF-050;Material escritório";
  const example4 = "15/01/2025;Consultoria Mensal;8000.00;ENTRADA;XYZ Corp;20/01/2025;;;;Aguardando pagamento";

  const csv = [header, example1, example2, example3, example4].join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=template_transacoes_v3.csv");
  res.send("\uFEFF" + csv); // BOM para Excel
});

export default router;
