import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { UnauthorizedError } from "../../shared/errors.js";

interface JwtPayload {
  userId: string;
  companyId: string;
  role: string;
}

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
