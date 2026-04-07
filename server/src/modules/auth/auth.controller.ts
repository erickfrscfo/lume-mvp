import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as authService from "./auth.service.js";
import { authMiddleware, adminKeyMiddleware } from "./auth.middleware.js";

const router = Router();

const registerSchema = z.object({
  name: z.string().min(2, "Nome deve ter pelo menos 2 caracteres"),
  username: z
    .string()
    .min(3, "Usuário deve ter pelo menos 3 caracteres")
    .regex(/^[a-zA-Z0-9_]+$/, "Usuário só pode conter letras, números e _"),
  email: z.string().email("E-mail inválido"),
  password: z.string().min(6, "Senha deve ter pelo menos 6 caracteres"),
  company: z.object({
    name: z.string().min(2, "Razão social deve ter pelo menos 2 caracteres"),
    cnpj: z.string().min(14, "CNPJ inválido"),
    sector: z.string().min(2, "Setor deve ter pelo menos 2 caracteres"),
  }),
});

const loginSchema = z.object({
  username: z.string().min(1, "Usuário é obrigatório"),
  password: z.string().min(1, "Senha é obrigatória"),
  companyCode: z.string().min(1, "Código da empresa é obrigatório"),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Senha atual é obrigatória"),
  newPassword: z.string().min(6, "Nova senha deve ter pelo menos 6 caracteres"),
});

// POST /api/auth/validate-admin-key — Valida se a chave admin é correta (usado pelo frontend)
router.post(
  "/validate-admin-key",
  adminKeyMiddleware,
  async (_req: Request, res: Response) => {
    res.json({ success: true, message: "Chave válida." });
  }
);

// POST /api/auth/register — PROTEGIDO: requer header X-Admin-Key
router.post(
  "/register",
  adminKeyMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = registerSchema.parse(req.body);
      const result = await authService.register(data);
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/auth/login
router.post(
  "/login",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = loginSchema.parse(req.body);
      const result = await authService.login(data);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/auth/me
router.get(
  "/me",
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await authService.getMe((req as any).userId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /api/auth/change-password — requer autenticação
router.patch(
  "/change-password",
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = changePasswordSchema.parse(req.body);
      const userId = (req as any).userId;
      await authService.changePassword(userId, data.currentPassword, data.newPassword);
      res.json({ success: true, message: "Senha alterada com sucesso." });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
