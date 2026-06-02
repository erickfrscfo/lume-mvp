import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../../shared/database.js";
import { Prisma } from "@prisma/client";
import { authMiddleware } from "../auth/auth.middleware.js";
import { generateAlerts } from "../alerts/alerts.controller.js";
import multer from "multer";
import OpenAI from "openai";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import { formatCategoriesForPrompt, resolveCompanyCategories } from "../../shared/resolve-categories.js";

const execFileAsync = promisify(execFile);

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
function buildExtractionPrompt(tipoTransacao: string, categoriesForPrompt: string): string {
  const tipoLabel = tipoTransacao === "INCOME"
    ? "RECEITA (entrada de dinheiro)"
    : "DESPESA (saída de dinheiro)";

  return `Você é um especialista em documentos financeiros brasileiros. Analise CUIDADOSAMENTE este documento e extraia os dados em JSON.
Retorne APENAS o JSON, sem markdown, sem explicações.

CONTEXTO: O usuário informou que este documento é uma ${tipoLabel}.

## IDENTIFICAÇÃO DO TIPO DE DOCUMENTO
Antes de extrair, identifique o tipo:
- **BOLETO/FATURA**: Tem código de barras, "Vencimento", "Total a Pagar", pode ser conta de luz, água, telefone, internet, etc.
- **NOTA FISCAL (NF-e/NFS-e)**: Tem "Nota Fiscal", CNPJ de prestador/tomador, discriminação de serviços
- **RECIBO**: Tem "Recibo", "Recebi de", assinatura
- **EXTRATO BANCÁRIO**: Lista de transações com datas e saldos
- **CONTRATO**: Termos, cláusulas, partes contratantes

## CAMPOS A EXTRAIR
{
  "tipo_documento": "INVOICE" | "RECEIPT" | "BANK_STATEMENT" | "CONTRACT" | "OTHER",
  "fornecedor_ou_cliente": "nome da empresa ou pessoa",
  "cnpj_cpf": "número do CNPJ ou CPF formatado (XX.XXX.XXX/XXXX-XX) ou null",
  "valor_total": 0.00,
  "data_emissao": "YYYY-MM-DD" ou null,
  "data_vencimento": "YYYY-MM-DD" ou null,
  "tipo_transacao": "${tipoTransacao}",
  "descricao": "descrição clara e específica do documento",
  "referencia": "número da NF, nº da fatura, nº do boleto ou referência" ou null,
  "categoria_sugerida": "nome da categoria contábil mais adequada",
  "categoria_codigo": "código exato da categoria no plano de contas" ou null,
  "tipo_custo": "FIXO" | "VARIAVEL" | null,
  "itens": [
    { "descricao": "descrição do item/serviço", "valor": 0.00 }
  ],
  "confianca": 0.0 a 1.0
}

## REGRAS CRÍTICAS DE EXTRAÇÃO

### Valor (valor_total)
- NUNCA retorne 0 ou null para valor_total — procure em TODO o documento
- Em BOLETOS/FATURAS: procure "Total a Pagar", "Valor a Pagar (R$)", "Valor do Documento", "Total"
- Em NOTAS FISCAIS: procure "Valor Total do Serviço", "Valor Total da Nota", "Valor Líquido"
- Converta para número decimal: "R$ 1.234,56" → 1234.56, "119,99" → 119.99
- Se houver múltiplos valores, use o VALOR TOTAL FINAL (maior valor ou "Total a Pagar")

### Datas
- NUNCA use a data de hoje como fallback — se não encontrar, use null
- data_emissao: "Data de Emissão", "Data", "Emitida em", ou mês de referência (ex: "Referência 02/2026" → use o primeiro dia: "2026-02-01")
- data_vencimento: "Vencimento", "Data de Vencimento", "Vence em" — MUITO IMPORTANTE para boletos
- Formato de saída: YYYY-MM-DD

### Fornecedor/Cliente
- Em BOLETOS/FATURAS: o fornecedor é a empresa que EMITE a cobrança (ex: Vivo, CPFL, Sabesp, etc.)
- Em NOTAS FISCAIS: o fornecedor é o PRESTADOR DE SERVIÇOS
- Use o nome comercial/razão social completa

### CNPJ/CPF
- Procure em TODO o documento — geralmente está no cabeçalho, rodapé ou dados do emissor
- Em BOLETOS: procure "CNPJ" do beneficiário/cedente
- Em NFs: procure no bloco "PRESTADOR DE SERVIÇOS"
- Mantenha a formatação: XX.XXX.XXX/XXXX-XX para CNPJ, XXX.XXX.XXX-XX para CPF

### Referência
- Em BOLETOS: "Nº da Fatura", "Nosso Número", "Nº do Documento"
- Em NFs: "Número da Nota", "Nº NF"

### Descrição
- Seja ESPECÍFICO: em vez de "Resumo da conta", use "Fatura Vivo Casa Conectada - Fibra 500 Mbps - Ref. 02/2026"
- Inclua o tipo de serviço/produto e período de referência quando disponível

### Categoria e Tipo de Custo
Use EXCLUSIVAMENTE o plano de contas abaixo para categorizar. Escolha uma categoria do mesmo tipo_transacao informado pelo usuário.
${categoriesForPrompt}
- categoria_codigo: retorne o código exato da categoria escolhida no plano de contas acima (ex: "5.3"). Se nenhuma categoria for adequada, use null.
- categoria_sugerida: retorne o nome exato da categoria escolhida. Se nenhuma categoria for adequada, use null.
- tipo_custo: para DESPESAS, classifique como "FIXO" (aluguel, salários, assinaturas, contas de consumo recorrentes) ou "VARIAVEL" (comissões, matéria-prima, frete, marketing). Para RECEITAS, use null.

### Tipo de Documento
- Boletos, faturas de serviço (telefone, internet, energia, água) → "INVOICE"
- Notas fiscais (NF-e, NFS-e) → "INVOICE"
- Recibos → "RECEIPT"
- Extratos bancários → "BANK_STATEMENT"
- Contratos → "CONTRACT"
- Outros → "OTHER"

### Confiança
- 0.9-1.0: todos os campos principais extraídos com certeza
- 0.7-0.8: maioria dos campos extraídos, alguns inferidos
- 0.5-0.6: dados parciais, baixa qualidade de imagem
- Abaixo de 0.5: documento ilegível ou tipo não reconhecido

O tipo_transacao já foi definido pelo usuário como "${tipoTransacao}", mantenha esse valor.`;
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
// PDFs são convertidos para imagem PNG usando pdftoppm (poppler-utils)
// que renderiza fontes embutidas corretamente (ao contrário de pdfjs-dist)
// Imagens são enviadas diretamente como base64
// ============================================
async function buildFileContent(file: Express.Multer.File): Promise<any[]> {
  const mimeType = file.mimetype;

  if (mimeType === "application/pdf") {
    console.log(`[OCR] Convertendo PDF para imagem com pdftoppm: ${file.originalname}`);
    
    // Criar diretório temporário para o PDF e as imagens
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-pdf-'));
    const pdfPath = path.join(tmpDir, 'input.pdf');
    const outputPrefix = path.join(tmpDir, 'page');
    
    try {
      // Salvar o buffer do PDF em arquivo temporário
      fs.writeFileSync(pdfPath, file.buffer);
      
      // Converter PDF para PNG usando pdftoppm (poppler-utils)
      // -png: formato de saída PNG
      // -r 200: resolução 200 DPI (boa qualidade sem ser excessivo)
      // -l 3: processar no máximo 3 páginas
      await execFileAsync('pdftoppm', [
        '-png',
        '-r', '200',
        '-l', '3',
        pdfPath,
        outputPrefix,
      ], { timeout: 30000 });
      
      // Ler as imagens geradas (pdftoppm gera page-1.png, page-2.png, etc.)
      const pngFiles = fs.readdirSync(tmpDir)
        .filter(f => f.startsWith('page-') && f.endsWith('.png'))
        .sort();
      
      if (pngFiles.length === 0) {
        throw new Error('pdftoppm não gerou nenhuma imagem');
      }
      
      console.log(`[OCR] PDF convertido com pdftoppm: ${pngFiles.length} página(s)`);
      
      const result = pngFiles.map(pngFile => {
        const pngBuffer = fs.readFileSync(path.join(tmpDir, pngFile));
        const pageBase64 = pngBuffer.toString('base64');
        return {
          type: "image_url" as const,
          image_url: {
            url: `data:image/png;base64,${pageBase64}`,
            detail: "high" as const,
          },
        };
      });
      
      // Limpar arquivos temporários
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.warn(`[OCR] Aviso: falha ao limpar tmpDir: ${tmpDir}`);
      }
      
      return result;
    } catch (pdfError: any) {
      console.error(`[OCR] Erro ao converter PDF com pdftoppm: ${pdfError.message}`);
      
      // Limpar arquivos temporários em caso de erro
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (cleanupErr) {}
      
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
async function findCategoryByName(companyId: string, name: string, type: string): Promise<{ id: string; name: string; code: string } | null> {
  if (!name) return null;
  const categories = await resolveCompanyCategories(companyId);
  const normalizedName = name.toLowerCase();

  const match = categories.find((cat) =>
    cat.type === type && cat.name.toLowerCase() === normalizedName
  ) || categories.find((cat) =>
    cat.type === type && cat.name.toLowerCase().includes(normalizedName)
  ) || categories.find((cat) =>
    cat.type === type && normalizedName.includes(cat.name.toLowerCase())
  );

  if (!match) return null;

  const globalCategory = await prisma.category.findFirst({
    where: { code: match.code, type: type as any },
    select: { id: true },
  });

  return { id: globalCategory?.id || `custom:${match.code}`, name: match.name, code: match.code };
}

async function findCategoryByCode(companyId: string, code: string, type: string): Promise<{ id: string; name: string; code: string } | null> {
  if (!code) return null;
  const categories = await resolveCompanyCategories(companyId);
  const normalizedCode = code.trim();
  const match = categories.find((cat) =>
    cat.type === type && cat.code === normalizedCode
  );

  if (!match) return null;

  const globalCategory = await prisma.category.findFirst({
    where: { code: match.code, type: type as any },
    select: { id: true },
  });

  return { id: globalCategory?.id || `custom:${match.code}`, name: match.name, code: match.code };
}

async function resolveCategoryIdByName(companyId: string, name: string, type: string): Promise<string | null> {
  const match = await findCategoryByName(companyId, name, type);
  if (!match || match.id.startsWith("custom:")) return null;
  return match.id;
}

async function resolveCategoryIdFromPayload(
  companyId: string,
  type: string,
  categoryId?: string | null,
  categoryCode?: string | null,
  categoryName?: string | null,
): Promise<string | null> {
  if (categoryId && !categoryId.startsWith("custom:")) {
    const category = await prisma.category.findFirst({
      where: { id: categoryId, type: type as any },
      select: { id: true },
    });
    if (category) return category.id;
  }

  if (categoryCode) {
    const match = await findCategoryByCode(companyId, categoryCode, type);
    if (match && !match.id.startsWith("custom:")) return match.id;
  }

  if (categoryName) {
    return resolveCategoryIdByName(companyId, categoryName, type);
  }

  return null;
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
      const companyCategories = await resolveCompanyCategories(companyId);
      const categoriesForPrompt = formatCategoriesForPrompt(
        companyCategories.filter((category) => category.type === tipoTransacao)
      );

      // Chamar GPT-4o com prompt dinâmico
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: buildExtractionPrompt(tipoTransacao, categoriesForPrompt) },
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
      let categoriaCodigo = extractedData.categoria_codigo || null;
      let categoriaMatch = null;
      if (categoriaCodigo) {
        categoriaMatch = await findCategoryByCode(companyId, categoriaCodigo, tipoTransacao);
      }
      if (!categoriaMatch && categoriaSugerida) {
        categoriaMatch = await findCategoryByName(companyId, categoriaSugerida, tipoTransacao);
      }
      if (categoriaMatch) {
        categoriaSugerida = categoriaMatch.name;
        categoriaCodigo = categoriaMatch.code;
      }
      extractedData.categoria_sugerida = categoriaSugerida;
      extractedData.categoria_codigo = categoriaCodigo;
      extractedData.categoria_match = categoriaMatch;

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
            categoria_codigo: categoriaCodigo,
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
        categoryId,
        categoryCode,
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
      const resolvedCategoryId = await resolveCategoryIdFromPayload(
        companyId,
        tipo_transacao || "EXPENSE",
        categoryId,
        categoryCode,
        categoria,
      );

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
          ...(resolvedCategoryId && { categoryId: resolvedCategoryId }),
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

      console.log(`[OCR Confirm] Transação criada: ${transaction.id} | tipo_custo: ${tipoCusto} | categoria: ${resolvedCategoryId} | vencimento: ${data_vencimento || 'N/A'}`);

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
