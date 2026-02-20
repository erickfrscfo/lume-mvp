import {
  Alert,
  AlertRule,
  Company,
  Prisma,
  Transaction,
  TransactionType,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { addMonths, endOfMonth, startOfMonth } from 'date-fns';
import { prisma } from '../../prisma';

type TransactionWithCategory = Transaction & {
  category: {
    name: string;
    group: string;
  } | null;
};

export class AlertsDetector {
  /**
   * Detecta transações duplicadas para uma empresa em um determinado período.
   */
  async detectDuplicateTransactions(
    companyId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Partial<Alert>[]> {
    const potentialDuplicates = await prisma.transaction.groupBy({
      by: ['description', 'amount', 'date', 'tipo_transacao'],
      where: {
        companyId,
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      _count: {
        id: true,
      },
      having: {
        id: {
          _count: {
            gt: 1,
          },
        },
      },
    });

    const alerts: Partial<Alert>[] = [];
    for (const group of potentialDuplicates) {
      const transactions = await prisma.transaction.findMany({
        where: {
          companyId,
          description: group.description,
          amount: group.amount,
          date: group.date,
          tipo_transacao: group.tipo_transacao, // CORREÇÃO: Usar 'tipo_transacao'
        },
        include: {
          category: {
            select: {
              name: true,
              group: true,
            },
          },
        },
      });

      const description = `Transação duplicada detectada: "${
        group.description
      }" no valor de ${group.amount.toFixed(
        2,
      )} em ${group.date.toLocaleDateString()}.`;

      const alert: Partial<Alert> = {
        companyId,
        type: 'DUPLICATE_TRANSACTION',
        description,
        severity: 'warning',
        status: 'new',
        relatedTransactionIds: transactions.map((t) => t.id),
        metadata: {
          transactions: transactions.map((t: TransactionWithCategory) => ({
            id: t.id,
            description: t.description,
            amount: t.amount,
            date: t.date,
            // CORREÇÃO: Acessar 'categoryId' e 'category.name'
            category: t.categoryId
              ? `${t.category?.group} > ${t.category?.name}`
              : 'Não categorizado',
          })),
        },
      };
      alerts.push(alert);
    }
    return alerts;
  }

  /**
   * Detecta transações de alto valor baseadas nas regras da empresa.
   */
  async detectHighValueTransactions(
    company: Company,
    startDate: Date,
    endDate: Date,
  ): Promise<Partial<Alert>[]> {
    const rules = await prisma.alertRule.findMany({
      where: {
        companyId: company.id,
        type: 'HIGH_VALUE_TRANSACTION',
        isActive: true,
      },
    });

    if (rules.length === 0) return [];

    const alerts: Partial<Alert>[] = [];
    for (const rule of rules) {
      const threshold = (rule.configuration as Prisma.JsonObject)
        ?.threshold as number;
      if (!threshold) continue;

      const transactions = await prisma.transaction.findMany({
        where: {
          companyId: company.id,
          date: { gte: startDate, lte: endDate },
          amount: { gte: threshold },
          // CORREÇÃO: Usar 'tipo_transacao'
          tipo_transacao:
            (rule.configuration as Prisma.JsonObject)?.transactionType === 'revenue'
              ? TransactionType.RECEITA
              : TransactionType.DESPESA,
        },
        include: {
          category: {
            select: {
              name: true,
              group: true,
            },
          },
        },
      });

      for (const transaction of transactions) {
        const description = `Transação de alto valor detectada: ${
          transaction.description
        } (${transaction.amount.toFixed(2)}) excede o limite de ${threshold}.`;
        alerts.push({
          companyId: company.id,
          type: 'HIGH_VALUE_TRANSACTION',
          description,
          severity: 'warning',
          status: 'new',
          relatedTransactionIds: [transaction.id],
          metadata: {
            transactionId: transaction.id,
            amount: transaction.amount,
            threshold,
            // CORREÇÃO: Acessar 'category.name'
            category: transaction.category?.name || 'Não categorizado',
          },
        });
      }
    }
    return alerts;
  }

  /**
   * Detecta anomalias em despesas mensais.
   */
  async detectExpenseAnomalies(
    companyId: string,
    currentMonth: Date,
  ): Promise<Partial<Alert>[]> {
    const rules = await prisma.alertRule.findMany({
      where: {
        companyId,
        type: 'EXPENSE_ANOMALY',
        isActive: true,
      },
    });

    if (rules.length === 0) return [];

    const alerts: Partial<Alert>[] = [];
    const periodMonths = 3; // Analisar os últimos 3 meses para a média

    for (const rule of rules) {
      const config = rule.configuration as Prisma.JsonObject;
      const percentageThreshold = (config?.percentageThreshold as number) || 20;
      const categoryId = config?.categoryId as string | undefined;

      if (!categoryId) continue;

      // Calcula a média dos últimos 'periodMonths'
      const historicalStart = startOfMonth(addMonths(currentMonth, -periodMonths));
      const historicalEnd = endOfMonth(addMonths(currentMonth, -1));

      const historicalExpenses = await prisma.transaction.aggregate({
        _sum: { amount: true },
        where: {
          companyId,
          categoryId,
          tipo_transacao: TransactionType.DESPESA,
          date: { gte: historicalStart, lte: historicalEnd },
        },
      });

      const averageExpense =
        (historicalExpenses._sum.amount?.toNumber() || 0) / periodMonths;
      if (averageExpense === 0) continue; // Não há base para comparação

      // Despesas do mês atual
      const currentMonthStart = startOfMonth(currentMonth);
      const currentMonthEnd = endOfMonth(currentMonth);
      const currentExpensesResult = await prisma.transaction.aggregate({
        _sum: { amount: true },
        where: {
          companyId,
          categoryId,
          tipo_transacao: TransactionType.DESPESA,
          date: { gte: currentMonthStart, lte: currentMonthEnd },
        },
      });
      const currentExpense = currentExpensesResult._sum.amount?.toNumber() || 0;

      const deviation =
        ((currentExpense - averageExpense) / averageExpense) * 100;

      if (deviation > percentageThreshold) {
        const category = await prisma.accountingCategory.findUnique({
          where: { id: categoryId },
        });
        const description = `Anomalia de despesa detectada na categoria "${
          category?.name
        }". O gasto de ${currentExpense.toFixed(
          2,
        )} está ${deviation.toFixed(
          0,
        )}% acima da média mensal de ${averageExpense.toFixed(2)}.`;

        alerts.push({
          companyId,
          type: 'EXPENSE_ANOMALY',
          description,
          severity: 'critical',
          status: 'new',
          metadata: {
            categoryId,
            categoryName: category?.name,
            currentExpense,
            averageExpense,
            deviation,
          },
        });
      }
    }
    return alerts;
  }

  /**
   * Executa todos os detectores de alerta para uma empresa.
   */
  async runAll(
    company: Company,
    startDate: Date,
    endDate: Date,
  ): Promise<Partial<Alert>[]> {
    const allAlerts: Partial<Alert>[] = [];

    const duplicateAlerts = await this.detectDuplicateTransactions(
      company.id,
      startDate,
      endDate,
    );
    const highValueAlerts = await this.detectHighValueTransactions(
      company,
      startDate,
      endDate,
    );
    const expenseAnomalyAlerts = await this.detectExpenseAnomalies(
      company.id,
      endDate, // Usar o fim do período como referência para o mês atual
    );

    allAlerts.push(...duplicateAlerts, ...highValueAlerts, ...expenseAnomalyAlerts);

    // Filtra alertas que já existem para as mesmas transações
    const existingAlerts = await prisma.alert.findMany({
      where: {
        companyId: company.id,
        relatedTransactionIds: {
          hasSome: allAlerts.flatMap((a) => a.relatedTransactionIds || []),
        },
      },
    });

    const newAlerts = allAlerts.filter((alert) => {
      // CORREÇÃO: Acessar 'tipo_transacao' em vez de 'type'
      if (alert.type === 'DUPLICATE_TRANSACTION') {
        return !existingAlerts.some(
          (existing) =>
            existing.type === 'DUPLICATE_TRANSACTION' &&
            JSON.stringify(existing.relatedTransactionIds.sort()) ===
              JSON.stringify(alert.relatedTransactionIds?.sort()),
        );
      }
      return !existingAlerts.some(
        (existing) =>
          existing.type === alert.type &&
          existing.relatedTransactionIds.includes(
            alert.relatedTransactionIds?.[0] || '',
          ),
      );
    });

    return newAlerts;
  }
}
