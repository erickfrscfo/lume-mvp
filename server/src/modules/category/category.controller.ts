import { Router, Request, Response } from 'express';
import { prisma } from '../../shared/database.js';
import { authMiddleware } from '../auth/auth.middleware.js';

const router = Router();

/**
 * GET /api/categories
 * Retorna todas as categorias do plano de contas.
 * Ordenadas por código (1.1, 1.2, ..., 9.5).
 */
router.get('/', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const categories = await prisma.category.findMany({
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
