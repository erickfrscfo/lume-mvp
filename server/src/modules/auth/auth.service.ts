import bcrypt from "bcryptjs";
import jwt, { Secret, SignOptions } from "jsonwebtoken";
import { prisma } from "../../shared/database.js";
import { env } from "../../config/env.js";
import { AppError, UnauthorizedError } from "../../shared/errors.js";

interface RegisterInput {
  name: string;
  username: string;
  email: string;
  password: string;
  company: {
    name: string;
    cnpj: string;
    sector: string;
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

  // Criar empresa e usuário em transação
  const result = await prisma.$transaction(async (tx) => {
    const company = await tx.company.create({
      data: {
        name: input.company.name,
        cnpj: input.company.cnpj,
        sector: input.company.sector,
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

  // Gerar token
  const token = jwt.sign(
    {
      userId: result.user.id,
      companyId: result.company.id,
      role: result.user.role,
    },
<<<<<<< HEAD
    env.JWT_SECRET as Secret,
=======
        env.JWT_SECRET as Secret,
>>>>>>> bde7c7e08c9c73dc6eb38192318c40e75949981b
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
<<<<<<< HEAD
    env.JWT_SECRET as Secret,
=======
        env.JWT_SECRET as Secret,
>>>>>>> bde7c7e08c9c73dc6eb38192318c40e75949981b
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
    },
  };
}
