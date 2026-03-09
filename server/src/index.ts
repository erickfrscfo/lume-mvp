import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env.js";
import { prisma } from "./shared/database.js";
import { AppError } from "./shared/errors.js";
import { ZodError } from "zod";

// Controllers existentes
import authController from "./modules/auth/auth.controller.js";
import financialController from "./modules/financial/financial.controller.js";
import aiController from "./modules/ai/ai.controller.js";
import uploadController from "./modules/upload/upload.controller.js";
import scenariosController from "./modules/scenarios/scenarios.controller.js";
import alertsController from "./modules/alerts/alerts.controller.js";
import forecastController from "./modules/forecast/forecast.controller.js";

// NOVOS Controllers - MVP v2 Conciliação
import transactionsController from "./modules/transactions/transactions.controller.js";
import counterpartiesController from "./modules/counterparties/counterparties.controller.js";
import documentsController from "./modules/documents/documents.controller.js";
import reconciliationsController from "./modules/reconciliations/reconciliations.controller.js";
import insightsController from "./modules/insights/insights.controller.js";
import { ocrController } from "./modules/ocr/ocr.controller.js";




const app = express();

// =============================================
// MIDDLEWARES GLOBAIS
// =============================================
app.use(helmet());
// CORS: aceitar qualquer origem no MVP
const corsOrigin = env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN;
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Log de requests (desenvolvimento)
if (env.NODE_ENV === "development") {
  app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} | ${req.method} ${req.path}`);
    next();
  });
}

// =============================================
// ROTAS EXISTENTES
// =============================================
app.use("/api/auth", authController);
app.use("/api/financial", financialController);
app.use("/api/ai", aiController);
app.use("/api/upload", uploadController);
app.use("/api/scenarios", scenariosController);
app.use("/api/alerts", alertsController);
app.use("/api/forecast", forecastController);

// =============================================
// NOVAS ROTAS - MVP v2 Conciliação
// =============================================
app.use("/api/transactions", transactionsController);
app.use("/api/counterparties", counterpartiesController);
app.use("/api/documents", documentsController);
app.use("/api/reconciliations", reconciliationsController);
app.use("/api/insights", insightsController);
app.use("/api/ocr", ocrController);




// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    environment: env.NODE_ENV,
  });
});

// =============================================
// ERROR HANDLER GLOBAL
// =============================================
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Erros de validação do Zod
  if (err instanceof ZodError) {
    const messages = err.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
    return res.status(422).json({
      success: false,
      error: "Erro de validação",
      details: messages,
    });
  }

  // Erros da aplicação
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
    });
  }

  // Erros do Multer
  if (err.message?.includes("Formato inválido")) {
    return res.status(400).json({
      success: false,
      error: err.message,
    });
  }

  // Erros inesperados
  console.error("Erro não tratado:", err);
  return res.status(500).json({
    success: false,
    error: "Erro interno do servidor",
  });
});

// =============================================
// INICIAR SERVIDOR
// =============================================
const PORT = env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📊 Ambiente: ${env.NODE_ENV}`);
  console.log(`🔗 Health: http://localhost:${PORT}/api/health`);
});

export default app;
