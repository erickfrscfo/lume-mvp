# Lume — CFO Virtual com IA para PMEs

**Lume** é uma plataforma SaaS que funciona como um CFO virtual inteligente para pequenas e médias empresas brasileiras. Utilizando Inteligência Artificial, a Lume automatiza a gestão financeira, classifica transações, projeta fluxo de caixa e traduz dados complexos em decisões simples.

## Stack Tecnológica

| Camada | Tecnologia |
|--------|-----------|
| **Frontend** | React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui + Recharts |
| **Backend** | Node.js + Express + TypeScript |
| **Banco de Dados** | PostgreSQL + Prisma ORM |
| **IA** | OpenAI GPT-4o-mini |
| **Hospedagem** | Vercel (frontend) + Railway (backend + banco) |

## Estrutura do Projeto

```
lume-mvp/
├── server/                    # Backend (API)
│   ├── prisma/
│   │   ├── schema.prisma      # Modelagem do banco de dados
│   │   └── seed.ts            # Script para popular categorias
│   ├── src/
│   │   ├── config/            # Configurações (env, etc.)
│   │   ├── modules/
│   │   │   ├── auth/          # Autenticação (login, registro, JWT)
│   │   │   ├── ai/            # Integração com OpenAI
│   │   │   ├── financial/     # Dashboard, fluxo de caixa, DRE
│   │   │   ├── upload/        # Upload e processamento de CSV
│   │   │   └── scenarios/     # Cenários financeiros
│   │   ├── shared/            # Utilitários compartilhados
│   │   └── index.ts           # Servidor principal
│   ├── package.json
│   └── tsconfig.json
├── templates/                 # Templates CSV para download
│   ├── transacoes_modelo.csv
│   ├── faturas_receber_modelo.csv
│   └── faturas_pagar_modelo.csv
└── README.md
```

## Endpoints da API

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/auth/register` | Cadastrar empresa e usuário |
| POST | `/api/auth/login` | Fazer login |
| GET | `/api/auth/me` | Dados do usuário logado |
| GET | `/api/financial/dashboard` | Métricas do dashboard |
| GET | `/api/financial/cashflow` | Dados do fluxo de caixa |
| GET | `/api/financial/dre` | Dados da DRE |
| GET | `/api/financial/transactions` | Listar transações |
| POST | `/api/financial/transactions` | Criar transação manual |
| POST | `/api/upload/csv` | Upload de arquivo CSV |
| GET | `/api/upload/history` | Histórico de uploads |
| POST | `/api/ai/chat` | Chat com IA (Reunião Executiva) |
| POST | `/api/ai/explain` | Explica pra Mim (métricas) |
| GET | `/api/scenarios` | Listar cenários |
| POST | `/api/scenarios` | Criar cenário |
| PATCH | `/api/scenarios/:id/toggle` | Ativar/desativar cenário |
| DELETE | `/api/scenarios/:id` | Remover cenário |

## Como Rodar Localmente

### Pré-requisitos
- Node.js 22+
- PostgreSQL (local ou Docker)

### Backend
```bash
cd server
npm install
cp .env.example .env  # Edite com seus dados
npx prisma generate
npx prisma db push
npx tsx prisma/seed.ts  # Popular categorias
npm run dev
```

### Frontend (wireframe existente)
O frontend já está implementado como wireframe no projeto `cfo-ai-wireframe`.

## Licença
Proprietário — Todos os direitos reservados.
