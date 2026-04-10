import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../auth/auth.middleware';

const router = Router();
const prisma = new PrismaClient();

/**
 * GET /api/categories
 * Retorna todas as categorias do plano de contas da empresa do usuário autenticado.
 * Ordenadas por código (1.1, 1.2, ..., 9.5).
 */
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    const categories = await prisma.category.findMany({
      where: { companyId: user.companyId },
      select: {
        id: true,
        name: true,
        code: true,
        type: true,
      },
      orderBy: { code: 'asc' },
    });

    return res.json({ data: categories });
  } catch (error) {
    console.error('Erro ao listar categorias:', error);
    return res.status(500).json({ error: 'Erro ao listar categorias' });
  }
});

export default router;
