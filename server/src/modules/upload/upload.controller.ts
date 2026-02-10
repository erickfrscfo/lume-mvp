import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import fs from "fs";
import { authMiddleware } from "../auth/auth.middleware.js";
import { prisma } from "../../shared/database.js";
import * as aiService from "../ai/ai.service.js";
import { generateAlerts } from "../alerts/alerts.controller.js";

const router = Router();

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

// POST /api/upload/csv
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

    // Validar e processar registros
    const errors: Array<{ line: number; error: string }> = [];
    const validTransactions: Array<{
      date: Date;
      description: string;
      amount: number;
      type: "INCOME" | "EXPENSE";
      notes?: string;
    }> = [];

    records.forEach((record, index) => {
      const line = index + 2; // +2 porque header é linha 1

      // Validar data
      const dateStr = record.data || record.Data || record.DATE;
      if (!dateStr) {
        errors.push({ line, error: "Campo 'data' ausente" });
        return;
      }
      const dateParts = dateStr.split("/");
      if (dateParts.length !== 3) {
        errors.push({ line, error: `Data inválida: ${dateStr}. Use DD/MM/AAAA` });
        return;
      }
      const date = new Date(
        parseInt(dateParts[2]),
        parseInt(dateParts[1]) - 1,
        parseInt(dateParts[0])
      );
      if (isNaN(date.getTime())) {
        errors.push({ line, error: `Data inválida: ${dateStr}` });
        return;
      }

      // Validar descrição
      const description = record.descricao || record.Descricao || record.DESCRICAO || record.description;
      if (!description) {
        errors.push({ line, error: "Campo 'descricao' ausente" });
        return;
      }

      // Validar valor
      const valorStr = (record.valor || record.Valor || record.VALOR || record.amount || "")
        .toString()
        .replace(",", ".");
      const rawAmount = parseFloat(valorStr);
      if (isNaN(rawAmount) || rawAmount === 0) {
        errors.push({ line, error: `Valor inválido: ${valorStr}` });
        return;
      }
      // Aceitar valores negativos — usar Math.abs e inferir tipo se necessário
      const amount = Math.abs(rawAmount);
      // Se valor é negativo e não tem tipo definido, inferir como SAIDA
      const isNegativeValue = rawAmount < 0;

      // Validar tipo
      let tipoStr = (record.tipo || record.Tipo || record.TIPO || record.type || "").toUpperCase();
      // Se tipo está vazio mas valor é negativo, inferir como SAIDA
      if (!tipoStr && isNegativeValue) {
        tipoStr = "SAIDA";
      } else if (!tipoStr && !isNegativeValue) {
        tipoStr = "ENTRADA";
      }
      if (tipoStr !== "ENTRADA" && tipoStr !== "SAIDA" && tipoStr !== "INCOME" && tipoStr !== "EXPENSE") {
        errors.push({ line, error: `Tipo inválido: ${tipoStr}. Use ENTRADA ou SAIDA` });
        return;
      }
      const type = (tipoStr === "ENTRADA" || tipoStr === "INCOME") ? "INCOME" : "EXPENSE";

      const notes = record.observacao || record.Observacao || record.notes || "";

      validTransactions.push({ date, description, amount, type, notes });
    });

    // Inserir transações válidas no banco
    let createdCount = 0;
    if (validTransactions.length > 0) {
      const created = await prisma.transaction.createMany({
        data: validTransactions.map((t) => ({
          companyId,
          uploadId: uploadRecord.id,
          date: t.date,
          description: t.description,
          amount: t.amount,
          type: t.type,
          notes: t.notes,
        })),
      });
      createdCount = created.count;
    }

    // Classificar transações com IA (em background)
    const unclassified = await prisma.transaction.findMany({
      where: { uploadId: uploadRecord.id, categoryId: null },
      select: { id: true, description: true, amount: true, type: true },
    });

    if (unclassified.length > 0) {
      const categories = await prisma.category.findMany({
        select: { code: true, name: true, type: true },
      });

      // Processar em lotes de 20
      const batchSize = 20;
      for (let i = 0; i < unclassified.length; i += batchSize) {
        const batch = unclassified.slice(i, i + batchSize).map((t) => ({
          id: t.id,
          description: t.description,
          amount: Number(t.amount),
          type: t.type,
        }));

        try {
          const classifications = await aiService.classifyTransactions(
            userId,
            batch,
            categories.map((c) => ({ code: c.code, name: c.name, type: c.type }))
          );

          // Atualizar transações com categorias
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

    // Atualizar status do upload
    const status = errors.length === 0 ? "COMPLETED" : validTransactions.length > 0 ? "PARTIAL" : "FAILED";
    await prisma.upload.update({
      where: { id: uploadRecord.id },
      data: {
        status,
        rowCount: createdCount,
        errorCount: errors.length,
        errorDetails: errors.length > 0 ? errors : undefined,
      },
    });

    // Limpar arquivo temporário
    fs.unlinkSync(file.path);

    // Gerar alertas inteligentes em background (não bloqueia a resposta)
    generateAlerts(companyId, userId).catch((err) => console.error("[Alerts] Erro ao gerar alertas:", err));

    res.json({
      success: true,
      data: {
        uploadId: uploadRecord.id,
        status,
        totalRows: records.length,
        imported: createdCount,
        errors: errors.length,
        errorDetails: errors.slice(0, 10), // Máximo 10 erros na resposta
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/upload/history
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

export default router;
