import { Router, Request, Response } from 'express';
import { prisma } from '../../shared/database.js';
import { authMiddleware } from '../auth/auth.middleware.js';
import { resolveCompanyCategories } from '../../shared/resolve-categories.js';

const router = Router();

/**
 * GET /api/categories
 * Retorna todas as categorias do plano de contas.
 * Ordenadas por código (1.1, 1.2, ..., 9.5).
 */
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const companyId = (req as any).companyId;
    const resolvedCategories = await resolveCompanyCategories(companyId);
    const globalCategories = await prisma.category.findMany({
      select: {
        id: true,
        name: true,
        code: true,
        type: true,
      },
      orderBy: { code: 'asc' },
    });
    const globalByCode = new Map(globalCategories.map((cat) => [cat.code, cat]));

    const categories = resolvedCategories.map((cat) => {
      const global = globalByCode.get(cat.code);
      return {
        id: global?.id || `custom:${cat.code}`,
        globalCategoryId: global?.id || null,
        name: cat.name,
        code: cat.code,
        type: cat.type,
        source: cat.source || 'GLOBAL',
      };
    });

    return res.json({ data: categories });
  } catch (error) {
    console.error('Erro ao listar categorias:', error);
    return res.status(500).json({ error: 'Erro ao listar categorias' });
  }
});

export default router;
