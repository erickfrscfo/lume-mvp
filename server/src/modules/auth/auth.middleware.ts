import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { UnauthorizedError } from "../../shared/errors.js";

interface JwtPayload {
  userId: string;
  companyId: string;
  role: string;
}

/**
 * Middleware de autenticação JWT.
 * Valida o token Bearer e injeta userId, companyId e role no request.
 */
export function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(new UnauthorizedError("Token não fornecido"));
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    (req as any).userId = decoded.userId;
    (req as any).companyId = decoded.companyId;
    (req as any).role = decoded.role;
    next();
  } catch {
    next(new UnauthorizedError("Token inválido ou expirado"));
  }
}

/**
 * Middleware de proteção admin via chave secreta.
 * Exige o header X-Admin-Key com o valor da variável de ambiente ADMIN_ONBOARDING_KEY.
 * Sem esse header ou com valor incorreto, retorna 403 Forbidden.
 */
export function adminKeyMiddleware(req: Request, _res: Response, next: NextFunction) {
  const adminKey = req.headers["x-admin-key"] as string | undefined;
  const expectedKey = env.ADMIN_ONBOARDING_KEY;

  if (!expectedKey) {
    // Se a variável de ambiente não estiver definida, bloqueia tudo por segurança
    return next(new UnauthorizedError("Registro desabilitado. ADMIN_ONBOARDING_KEY não configurada."));
  }

  if (!adminKey || adminKey !== expectedKey) {
    return next(new UnauthorizedError("Chave de administrador inválida ou não fornecida."));
  }

  next();
}

/**
 * Middleware que verifica se o usuário autenticado tem role ADMIN.
 * Deve ser usado APÓS authMiddleware.
 */
export function adminRoleMiddleware(req: Request, _res: Response, next: NextFunction) {
  const role = (req as any).role;
  if (role !== "ADMIN") {
    return next(new UnauthorizedError("Acesso restrito a administradores."));
  }
  next();
}
