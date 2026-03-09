import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../../shared/database.js";
import multer from "multer";
import OpenAI from "openai";

const router = Router();

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
// PROMPT DE EXTRAÇÃO OCR (dinâmico)
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
- O campo confianca indica sua confiança na extração (0.0 = nenhuma, 1.0 = total)`;
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
// POST /api/ocr/extract — Upload e extração
// ============================================
router.post(
  "/extract",
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = (req as any).companyId;
      const userId = (req as any).userId;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "Nenhum arquivo enviado",
        });
      }

      const file = req.file;
      const base64 = file.buffer.toString("base64");
      const mimeType = file.mimetype;

      // Tipo de transação informado pelo usuário (INCOME ou EXPENSE)
      const tipoTransacao = req.body?.tipo_transacao || "EXPENSE";

      // Montar conteúdo da imagem para a API
      const imageContent = {
        type: "image_url" as const,
        image_url: {
          url: `data:${mimeType};base64,${base64}`,
          detail: "high" as const,
        },
      };

      // Chamar GPT-4o Vision com prompt dinâmico
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: buildExtractionPrompt(tipoTransacao) },
              imageContent,
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

      // Salvar o documento no banco com os dados extraídos
      const document = await prisma.document.create({
        data: {
          companyId,
          fileName: file.originalname,
          fileType: mimeType,
          fileSize: file.size,
          type: docType,
          number: extractedData.referencia || `OCR-${Date.now()}`,
          issueDate: extractedData.data_emissao ? new Date(extractedData.data_emissao) : new Date(),
          amount: Math.abs(parseFloat(extractedData.valor_total) || 0),
          description: extractedData.descricao || null,
          extractedData: extractedData,
          extractionConfidence: extractedData.confianca || 0.5,
          status: "ACTIVE",
        },
      });

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
            itens: extractedData.itens || [],
            confianca: extractedData.confianca,
          },
        },
      });
    } catch (error: any) {
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
// GET /api/ocr/document/:documentId — Obter dados extraídos
// ============================================
router.get(
  "/document/:documentId",
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
      } = req.body;

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

      // Criar a transação
      const transaction = await prisma.transaction.create({
        data: {
          companyId,
          date: new Date(data || new Date()),
          description: descricao || "Transação via documento",
          amount: Math.abs(parseFloat(valor) || 0),
          tipo_transacao: tipo_transacao || "EXPENSE",
          source: "OCR",
          status: data_vencimento ? "PENDING" : "COMPLETED",
          ...(categoryId && { categoryId }),
          ...(counterpartyId && { counterpartyId }),
        },
      });

      // Criar detalhes da transação (se tiver vencimento)
      if (data_vencimento) {
        await prisma.transactionDetail.create({
          data: {
            transactionId: transaction.id,
            dueDate: new Date(data_vencimento),
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

      res.json({
        success: true,
        data: {
          transactionId: transaction.id,
          documentId: document.id,
          message: "Transação criada com sucesso a partir do documento.",
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export const ocrController = router;
