import bcrypt from "bcryptjs";
import jwt, { Secret, SignOptions } from "jsonwebtoken";
import { prisma } from "../../shared/database.js";
import { env } from "../../config/env.js";
import { AppError, UnauthorizedError } from "../../shared/errors.js";
import { CompanySector } from "@prisma/client";

const VALID_SECTORS: CompanySector[] = ["VAREJO", "SERVICOS", "INDUSTRIA", "SAAS", "ECOMMERCE", "MISTO"];

interface RegisterInput {
  name: string;
  username: string;
  email: string;
  password: string;
  company: {
    name: string;
    cnpj: string;
    sector: string;
    activity?: string;
    useCustomChart?: boolean;
  };
}

interface LoginInput {
  username: string;
  password: string;
  companyCode: string;
}

function generateCompanyCode(companyName: string): string {
  const prefix = companyName
    .replace(/[^a-zA-Z]/g, "")
    .substring(0, 4)
    .toUpperCase();
  const suffix = Math.floor(100 + Math.random() * 900);
  return `${prefix}${suffix}`;
}

/**
 * Copia o plano de contas padrão (tabela Category global) para a tabela CompanyCategory
 * da empresa recém-criada. Usado quando useCustomChart = true e o admin quer partir
 * do plano padrão como base para customizar.
 */
async function copyDefaultChartToCompany(companyId: string): Promise<void> {
  const globalCategories = await prisma.category.findMany({
    orderBy: { code: "asc" },
  });

  for (const cat of globalCategories) {
    // Determinar parentCode a partir do parent global
    let parentCode: string | null = null;
    if (cat.parentId) {
      const parent = globalCategories.find((c) => c.id === cat.parentId);
      parentCode = parent?.code || null;
    }

    await prisma.companyCategory.create({
      data: {
        companyId,
        code: cat.code,
        name: cat.name,
        type: cat.type,
        parentCode,
        isActive: true,
      },
    });
  }
}

export async function register(input: RegisterInput) {
  // Verificar se username já existe
  const existingUser = await prisma.user.findUnique({
    where: { username: input.username },
  });
  if (existingUser) {
    throw new AppError("Nome de usuário já está em uso", 409);
  }

  // Verificar se email já existe
  const existingEmail = await prisma.user.findUnique({
    where: { email: input.email },
  });
  if (existingEmail) {
    throw new AppError("E-mail já está em uso", 409);
  }

  // Verificar se CNPJ já existe
  const existingCompany = await prisma.company.findUnique({
    where: { cnpj: input.company.cnpj },
  });
  if (existingCompany) {
    throw new AppError("CNPJ já cadastrado no sistema", 409);
  }

  // Hash da senha
  const hashedPassword = await bcrypt.hash(input.password, 12);

  // Gerar código da empresa
  const companyCode = generateCompanyCode(input.company.name);

  const useCustomChart = input.company.useCustomChart ?? false;

  // Criar empresa e usuário em transação
  const result = await prisma.$transaction(async (tx) => {
    const company = await tx.company.create({
      data: {
        name: input.company.name,
        cnpj: input.company.cnpj,
        sector: (VALID_SECTORS.includes(input.company.sector as CompanySector)
          ? input.company.sector
          : "MISTO") as CompanySector,
        activity: input.company.activity || null,
        useCustomChart,
        code: companyCode,
      },
    });

    const user = await tx.user.create({
      data: {
        name: input.name,
        username: input.username,
        email: input.email,
        password: hashedPassword,
        role: "ADMIN",
        companyId: company.id,
      },
    });

    return { user, company };
  });

  // Se useCustomChart = true, copiar plano padrão como base
  if (useCustomChart) {
    await copyDefaultChartToCompany(result.company.id);
  }

  // Gerar token
  const token = jwt.sign(
    {
      userId: result.user.id,
      companyId: result.company.id,
      role: result.user.role,
    },
    env.JWT_SECRET as Secret,
    { expiresIn: env.JWT_EXPIRES_IN } as SignOptions
  );

  return {
    token,
    user: {
      id: result.user.id,
      name: result.user.name,
      username: result.user.username,
      email: result.user.email,
      role: result.user.role,
    },
    company: {
      id: result.company.id,
      name: result.company.name,
      code: result.company.code,
      sector: result.company.sector,
      activity: result.company.activity,
      useCustomChart: result.company.useCustomChart,
    },
  };
}

export async function login(input: LoginInput) {
  // Buscar empresa pelo código
  const company = await prisma.company.findUnique({
    where: { code: input.companyCode },
  });
  if (!company) {
    throw new UnauthorizedError("Código da empresa inválido");
  }

  // Buscar usuário
  const user = await prisma.user.findUnique({
    where: { username: input.username },
  });
  if (!user || user.companyId !== company.id) {
    throw new UnauthorizedError("Usuário ou senha inválidos");
  }

  // Verificar senha
  const validPassword = await bcrypt.compare(input.password, user.password);
  if (!validPassword) {
    throw new UnauthorizedError("Usuário ou senha inválidos");
  }

  // Gerar token
  const token = jwt.sign(
    {
      userId: user.id,
      companyId: company.id,
      role: user.role,
    },
    env.JWT_SECRET as Secret,
    { expiresIn: env.JWT_EXPIRES_IN } as SignOptions
  );

  return {
    token,
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: user.role,
    },
    company: {
      id: company.id,
      name: company.name,
      code: company.code,
      sector: company.sector,
    },
  };
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { company: true },
  });
  if (!user) {
    throw new UnauthorizedError("Usuário não encontrado");
  }
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    role: user.role,
    company: {
      id: user.company.id,
      name: user.company.name,
      code: user.company.code,
      sector: user.company.sector,
      activity: user.company.activity,
      useCustomChart: user.company.useCustomChart,
    },
  };
}

/**
 * Altera a senha do usuário autenticado.
 * Valida a senha atual antes de permitir a troca.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new AppError("Usuário não encontrado", 404);
  }

  // Verifica se a senha atual está correta
  const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
  if (!isCurrentPasswordValid) {
    throw new AppError("Senha atual incorreta", 400);
  }

  // Verifica se a nova senha é diferente da atual
  const isSamePassword = await bcrypt.compare(newPassword, user.password);
  if (isSamePassword) {
    throw new AppError("A nova senha deve ser diferente da senha atual", 400);
  }

  // Hash da nova senha
  const hashedPassword = await bcrypt.hash(newPassword, 12);

  // Atualiza no banco
  await prisma.user.update({
    where: { id: userId },
    data: { password: hashedPassword },
  });
}
