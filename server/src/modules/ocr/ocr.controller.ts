import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../../shared/database.js";
import { Prisma } from "@prisma/client";
import { authMiddleware } from "../auth/auth.middleware.js";
import { generateAlerts } from "../alerts/alerts.controller.js";
import multer from "multer";
import OpenAI from "openai";
import { pdfToPng } from "pdf-to-png-converter";

const router = Router();

// Helper: parsear data sem problema de timezone (D-1)
function parseLocalDate(dateStr: string | Date): Date {
  if (dateStr instanceof Date) return dateStr;
  if (!dateStr) return new Date();
  if (dateStr.includes('T') || dateStr.includes(' ')) return new Date(dateStr);
  if (dateStr.includes('/')) {
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]), 12, 0, 0);
    }
  }
  return new Date(dateStr + 'T12:00:00');
}

// Multer config — armazena em memória (não persiste arquivo)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Tipo de arquivo não suportado. Use PDF, JPG, PNG ou WebP."));
    }
  },
});

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ============================================
// PROMPT DE EXTRAÇÃO OCR (dinâmico) — agora inclui categoria e tipo_custo
// ============================================
function buildExtractionPrompt(tipoTransacao: string): string {
  const tipoLabel = tipoTransacao === "INCOME"
    ? "RECEITA (entrada de dinheiro)"
    : "DESPESA (saída de dinheiro)";

  return `Analise este documento financeiro e extraia as seguintes informações em JSON.
Retorne APENAS o JSON, sem markdown, sem explicações.

CONTEXTO IMPORTANTE: O usuário informou que este documento é uma ${tipoLabel}. Use essa informação como referência para o campo tipo_transacao.

Campos obrigatórios:
{
  "tipo_documento": "INVOICE" | "RECEIPT" | "BANK_STATEMENT" | "CONTRACT" | "OTHER",
  "fornecedor_ou_cliente": "nome da empresa ou pessoa",
  "cnpj_cpf": "número do documento (CNPJ ou CPF) ou null",
  "valor_total": 0.00,
  "data_emissao": "YYYY-MM-DD" ou null,
  "data_vencimento": "YYYY-MM-DD" ou null,
  "tipo_transacao": "${tipoTransacao}",
  "descricao": "descrição resumida do documento",
  "referencia": "número da NF, boleto ou referência" ou null,
  "categoria_sugerida": "nome da categoria contábil mais adequada",
  "tipo_custo": "FIXO" | "VARIAVEL" | null,
  "itens": [
    { "descricao": "descrição do item", "valor": 0.00 }
  ],
  "confianca": 0.0 a 1.0
}

Regras:
- O tipo_transacao já foi definido pelo usuário como "${tipoTransacao}", mantenha esse valor
- tipo_documento DEVE ser um destes valores exatos: INVOICE, RECEIPT, BANK_STATEMENT, CONTRACT, OTHER
- Valores devem ser numéricos (sem R$, sem pontos de milhar)
- Datas no formato YYYY-MM-DD
- Se não conseguir extrair algum campo, use null
- O campo confianca indica sua confiança na extração (0.0 = nenhuma, 1.0 = total)
- categoria_sugerida: sugira a categoria contábil mais adequada (ex: "Despesas com Pessoal", "Despesas Operacionais", "Impostos e Tributos", "Prestação de Serviços", "Receita de Vendas", etc.)
- tipo_custo: para DESPESAS, classifique como "FIXO" (aluguel, salários, assinaturas, seguros) ou "VARIAVEL" (comissões, matéria-prima, frete, marketing). Para RECEITAS, use null.`;
}

// Mapear tipo_documento da IA para o enum DocumentType do Prisma
function mapDocumentType(tipo: string): "INVOICE" | "RECEIPT" | "BANK_STATEMENT" | "CONTRACT" | "OTHER" {
  const map: Record<string, "INVOICE" | "RECEIPT" | "BANK_STATEMENT" | "CONTRACT" | "OTHER"> = {
    "INVOICE": "INVOICE",
    "RECEIPT": "RECEIPT",
    "BANK_STATEMENT": "BANK_STATEMENT",
    "CONTRACT": "CONTRACT",
    "OTHER": "OTHER",
    "nota_fiscal": "INVOICE",
    "boleto": "INVOICE",
    "recibo": "RECEIPT",
    "extrato": "BANK_STATEMENT",
    "contrato": "CONTRACT",
    "outro": "OTHER",
  };
  return map[tipo] || "OTHER";
}

// ============================================
// Montar conteúdo para a API OpenAI
// PDFs são convertidos para imagem PNG antes de enviar (melhor extração visual)
// Imagens são enviadas diretamente como base64
// ============================================
async function buildFileContent(file: Express.Multer.File): Promise<any[]> {
  const mimeType = file.mimetype;

  if (mimeType === "application/pdf") {
    console.log(`[OCR] Convertendo PDF para imagem: ${file.originalname}`);
    try {
      const pdfBuffer = new Uint8Array(file.buffer);
      const pngPages = await pdfToPng(pdfBuffer as any, {
        disableFontFace: false,
        useSystemFonts: false,
        viewportScale: 2.0, // Alta resolução para melhor OCR
        pagesToProcess: [1, 2, 3], // Processar até 3 páginas
      });

      if (!pngPages || pngPages.length === 0) {
        throw new Error("Nenhuma página convertida do PDF");
      }

      console.log(`[OCR] PDF convertido: ${pngPages.length} página(s) → enviando como imagem`);

      // Retornar todas as páginas como imagens
      return pngPages
        .filter((page) => page.content != null)
        .map((page) => {
        const pageBase64 = page.content!.toString("base64");
        return {
          type: "image_url" as const,
          image_url: {
            url: `data:image/png;base64,${pageBase64}`,
            detail: "high" as const,
          },
        };
      });
    } catch (pdfError: any) {
      console.error(`[OCR] Erro ao converter PDF para imagem: ${pdfError.message}`);
      // Fallback: enviar PDF via Files API (menos preciso, mas funciona)
      console.log(`[OCR] Fallback: enviando PDF via Files API`);
      const uploadedFile = await openai.files.create({
        file: new File([file.buffer], file.originalname, { type: mimeType }),
        purpose: "user_data",
      });
      return [{
        type: "file" as const,
        file: {
          file_id: uploadedFile.id,
        },
      }];
    }
  } else {
    const base64 = file.buffer.toString("base64");
    return [{
      type: "image_url" as const,
      image_url: {
        url: `data:${mimeType};base64,${base64}`,
        detail: "high" as const,
      },
    }];
  }
}

// ============================================
// Buscar categoria por nome (fuzzy match)
// ============================================
async function findCategoryByName(name: string, type: string): Promise<{ id: string; name: string; code: string } | null> {
  if (!name) return null;

  // Tentar match exato primeiro
  let cat = await prisma.category.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      type: type as any,
    },
  });

  if (!cat) {
    // Tentar match parcial
    cat = await prisma.category.findFirst({
      where: {
        name: { contains: name, mode: "insensitive" },
        type: type as any,
      },
    });
  }

  if (!cat) {
    // Tentar match com BOTH
    cat = await prisma.category.findFirst({
      where: {
        name: { contains: name, mode: "insensitive" },
      },
    });
  }

  return cat ? { id: cat.id, name: cat.name, code: cat.code } : null;
}

// ============================================
// POST /api/ocr/extract — Upload e extração
// ============================================
router.post(
  "/extract",
  authMiddleware,
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = (req as any).companyId;
      const userId = (req as any).userId;

      if (!companyId) {
        return res.status(401).json({
          success: false,
          error: "Usuário não autenticado ou empresa não identificada.",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "Nenhum arquivo enviado",
        });
      }

      const file = req.file;

      // Tipo de transação informado pelo usuário (INCOME ou EXPENSE)
      const tipoTransacao = req.body?.tipo_transacao || "EXPENSE";

      // Montar conteúdo do arquivo para a API (suporta PDF e imagens)
      console.log(`[OCR] Processando arquivo: ${file.originalname} (${file.mimetype}, ${(file.size / 1024).toFixed(1)}KB) | Company: ${companyId}`);
      const fileContents = await buildFileContent(file);

      // Chamar GPT-4o com prompt dinâmico
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: buildExtractionPrompt(tipoTransacao) },
              ...fileContents,
            ],
          },
        ],
        max_tokens: 2000,
        temperature: 0.1,
      });

      const responseText = completion.choices[0]?.message?.content || "";

      // Tentar parsear o JSON da resposta
      let extractedData: any;
      try {
        const cleanJson = responseText
          .replace(/```json\n?/g, "")
          .replace(/```\n?/g, "")
          .trim();
        extractedData = JSON.parse(cleanJson);
      } catch (parseError) {
        return res.status(422).json({
          success: false,
          error: "Não foi possível extrair dados do documento. Tente com uma imagem mais nítida.",
          rawResponse: responseText,
        });
      }

      // Garantir que o tipo_transacao respeita a escolha do usuário
      extractedData.tipo_transacao = tipoTransacao;

      // Mapear tipo de documento para o enum correto
      const docType = mapDocumentType(extractedData.tipo_documento);

      // Tentar auto-match de categoria
      let categoriaSugerida = extractedData.categoria_sugerida || null;
      let categoriaMatch = null;
      if (categoriaSugerida) {
        categoriaMatch = await findCategoryByName(categoriaSugerida, tipoTransacao);
      }

      // Salvar o documento no banco com os dados extraídos
      const document = await prisma.document.create({
        data: {
          companyId,
          fileName: file.originalname,
          fileType: file.mimetype,
          fileSize: file.size,
          type: docType,
          number: extractedData.referencia || `OCR-${Date.now()}`,
          issueDate: extractedData.data_emissao ? parseLocalDate(extractedData.data_emissao) : new Date(),
          amount: Math.abs(parseFloat(extractedData.valor_total) || 0),
          description: extractedData.descricao || null,
          extractedData: extractedData,
          extractionConfidence: extractedData.confianca || 0.5,
          status: "ACTIVE",
        },
      });

      console.log(`[OCR] Extração concluída: ${file.originalname} → doc ${document.id} | confiança ${extractedData.confianca} | categoria sugerida: ${categoriaSugerida} | match: ${categoriaMatch?.name || 'nenhum'}`);

      res.json({
        success: true,
        data: {
          documentId: document.id,
          fileName: file.originalname,
          extractedData: {
            tipo_documento: docType,
            fornecedor_ou_cliente: extractedData.fornecedor_ou_cliente,
            cnpj_cpf: extractedData.cnpj_cpf,
            valor_total: extractedData.valor_total,
            data_emissao: extractedData.data_emissao,
            data_vencimento: extractedData.data_vencimento,
            tipo_transacao: extractedData.tipo_transacao,
            descricao: extractedData.descricao,
            referencia: extractedData.referencia,
            categoria_sugerida: categoriaSugerida,
            categoria_match: categoriaMatch,
            tipo_custo: extractedData.tipo_custo || null,
            itens: extractedData.itens || [],
            confianca: extractedData.confianca,
          },
        },
      });
    } catch (error: any) {
      console.error("[OCR] Erro na extração:", error?.message || error);
      if (error?.status === 400 && error?.message?.includes("MIME")) {
        return res.status(400).json({
          success: false,
          error: "Formato de arquivo não suportado pela IA. Tente converter o PDF para imagem (JPG/PNG) e enviar novamente.",
        });
      }
      if (error?.status === 401) {
        return res.status(500).json({
          success: false,
          error: "Erro de autenticação com a API de IA. Verifique a chave OPENAI_API_KEY.",
        });
      }
      if (error?.status === 429) {
        return res.status(429).json({
          success: false,
          error: "Limite de requisições da API de IA atingido. Tente novamente em alguns minutos.",
        });
      }
      next(error);
    }
  }
);

// ============================================
// GET /api/ocr/history — Listar documentos importados via OCR
// ============================================
router.get(
  "/history",
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = (req as any).companyId;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;

      const [documents, total] = await Promise.all([
        prisma.document.findMany({
          where: {
            companyId,
            extractedData: { not: Prisma.DbNull },
          },
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
        }),
        prisma.document.count({
          where: {
            companyId,
            extractedData: { not: Prisma.DbNull },
          },
        }),
      ]);

      res.json({
        success: true,
        data: documents.map((doc) => ({
          id: doc.id,
          fileName: doc.fileName,
          type: doc.type,
          number: doc.number,
          amount: doc.amount,
          status: doc.status,
          extractedData: doc.extractedData,
          extractionConfidence: doc.extractionConfidence,
          counterpartyId: doc.counterpartyId,
          createdAt: doc.createdAt,
        })),
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================
// GET /api/ocr/document/:documentId — Obter dados extraídos
// ============================================
router.get(
  "/document/:documentId",
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = (req as any).companyId;
      const { documentId } = req.params;

      const document = await prisma.document.findFirst({
        where: {
          id: documentId,
          companyId,
        },
      });

      if (!document) {
        return res.status(404).json({
          success: false,
          error: "Documento não encontrado",
        });
      }

      res.json({
        success: true,
        data: {
          documentId: document.id,
          fileName: document.fileName,
          documentType: document.type,
          extractedData: document.extractedData,
          extractionConfidence: document.extractionConfidence,
          status: document.status,
          createdAt: document.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================
// POST /api/ocr/confirm/:documentId — Confirmar e criar transação
// ============================================
router.post(
  "/confirm/:documentId",
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = (req as any).companyId;
      const userId = (req as any).userId;
      const { documentId } = req.params;

      const {
        descricao,
        valor,
        tipo_transacao,
        data,
        data_vencimento,
        categoria,
        contraparte_nome,
        contraparte_documento,
        referencia,
        tipo_custo,
      } = req.body;

      console.log(`[OCR Confirm] Payload recebido:`, JSON.stringify(req.body, null, 2));

      const document = await prisma.document.findFirst({
        where: {
          id: documentId,
          companyId,
        },
      });

      if (!document) {
        return res.status(404).json({
          success: false,
          error: "Documento não encontrado",
        });
      }

      if (document.status === "ARCHIVED") {
        return res.status(400).json({
          success: false,
          error: "Este documento já foi confirmado e uma transação já foi criada.",
        });
      }

      // Buscar ou criar contraparte (se fornecido)
      let counterpartyId: string | null = null;
      if (contraparte_nome) {
        let counterparty = await prisma.counterparty.findFirst({
          where: {
            companyId,
            OR: [
              { name: { contains: contraparte_nome, mode: "insensitive" } },
              ...(contraparte_documento
                ? [{ document: contraparte_documento }]
                : []),
            ],
          },
        });

        if (!counterparty) {
          counterparty = await prisma.counterparty.create({
            data: {
              companyId,
              name: contraparte_nome,
              document: contraparte_documento || null,
              type: tipo_transacao === "INCOME" ? "CLIENT" : "SUPPLIER",
              isActive: true,
            },
          });
        }
        counterpartyId = counterparty.id;
      }

      // Buscar categoria (se fornecida)
      let categoryId: string | null = null;
      if (categoria) {
        const cat = await prisma.category.findFirst({
          where: {
            name: { contains: categoria, mode: "insensitive" },
          },
        });
        if (cat) {
          categoryId = cat.id;
        }
      }

      // Determinar tipo_custo para despesas
      let tipoCusto: "FIXO" | "VARIAVEL" | null = null;
      if (tipo_transacao === "EXPENSE" || tipo_transacao === "DESPESA") {
        if (tipo_custo === "FIXO" || tipo_custo === "VARIAVEL") {
          tipoCusto = tipo_custo;
        }
      }

      // Criar a transação com tipo_custo
      const transaction = await prisma.transaction.create({
        data: {
          companyId,
          date: data ? parseLocalDate(data) : new Date(),
          description: descricao || "Transação via documento",
          amount: Math.abs(parseFloat(valor) || 0),
          tipo_transacao: tipo_transacao || "EXPENSE",
          source: "OCR",
          status: "PENDING", // OCR nunca tem data de pagamento/recebimento, sempre PENDING
          ...(categoryId && { categoryId }),
          ...(counterpartyId && { counterpartyId }),
          ...(tipoCusto && { tipo_custo: tipoCusto }),
          ...(tipoCusto && { costConfidence: 0.85 }),
        },
      });

      // Criar detalhes da transação (se tiver vencimento)
      if (data_vencimento) {
        await prisma.transactionDetail.create({
          data: {
            transactionId: transaction.id,
            dueDate: parseLocalDate(data_vencimento),
            amountOriginal: Math.abs(parseFloat(valor) || 0),
            documentNumber: referencia || null,
            reconciliationStatus: "PENDING",
          },
        });
      }

      // Atualizar status do documento para ARCHIVED (= confirmado/processado)
      await prisma.document.update({
        where: { id: documentId },
        data: {
          status: "ARCHIVED",
          counterpartyId: counterpartyId || undefined,
        },
      });

      // Atualizar métricas da contraparte
      if (counterpartyId) {
        const txCount = await prisma.transaction.count({
          where: { counterpartyId },
        });
        await prisma.counterparty.update({
          where: { id: counterpartyId },
          data: { totalTransactions: txCount },
        });
      }

      console.log(`[OCR Confirm] Transação criada: ${transaction.id} | tipo_custo: ${tipoCusto} | categoria: ${categoryId} | vencimento: ${data_vencimento || 'N/A'}`);

      // Regenerar alertas em background (não bloqueia a resposta)
      generateAlerts(companyId, userId).catch(err => console.error('[OCR Confirm] Erro ao gerar alertas:', err));

      res.json({
        success: true,
        data: {
          transactionId: transaction.id,
          documentId: document.id,
          message: "Transação criada com sucesso a partir do documento.",
        },
      });
    } catch (error) {
      console.error("[OCR Confirm] Erro:", error);
      next(error);
    }
  }
);

export const ocrController = router;
