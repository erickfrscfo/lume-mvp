# Lume Backend (MVP)

**Backend do MVP Lume — CFO Virtual com IA.** API REST construída com Express + Prisma + PostgreSQL, com integração OpenAI para classificação de transações, chat financeiro, alertas inteligentes e reunião executiva.

---

## Stack Tecnológica

| Tecnologia | Versão | Uso |
|------------|--------|-----|
| **Node.js** | 22+ | Runtime |
| **TypeScript** | 5.6+ | Tipagem estática |
| **Express** | 4.21+ | Framework HTTP |
| **Prisma** | 5.22+ | ORM e migrações de banco |
| **PostgreSQL** | 15+ | Banco de dados relacional |
| **OpenAI** | 4.73+ | IA para classificação, chat e análises |
| **JSON Web Token** | 9+ | Autenticação JWT |
| **bcryptjs** | 2.4+ | Hash de senhas |
| **Multer** | 1.4+ | Upload de arquivos (CSV) |
| **csv-parse** | 5.6+ | Parsing de arquivos CSV |
| **Zod** | 3.23+ | Validação de schemas |
| **Helmet** | 8+ | Segurança HTTP headers |
| **CORS** | 2.8+ | Cross-Origin Resource Sharing |

---

## Estrutura de Pastas e Arquivos

```
lume-mvp/
├── server/
│   ├── prisma/
│   │   ├── schema.prisma              # Schema do banco (modelos, relações, enums)
│   │   └── seed.ts                    # Script de seed para dados iniciais
│   │
│   ├── src/
│   │   ├── config/
│   │   │   └── env.ts                 # Variáveis de ambiente tipadas (DATABASE_URL, JWT_SECRET, etc.)
│   │   │
│   │   ├── modules/
│   │   │   ├── ai/
│   │   │   │   ├── ai.controller.ts   # Endpoints de IA (chat, reunião executiva)
│   │   │   │   └── ai.service.ts      # Serviço OpenAI (classificação, chat, análise)
│   │   │   │
│   │   │   ├── alerts/
│   │   │   │   ├── alerts.controller.ts   # Endpoints de alertas financeiros
│   │   │   │   ├── alerts.detector.ts     # Lógica de detecção de alertas
│   │   │   │   ├── alerts.humanizer.ts    # Humanização de alertas com IA
│   │   │   │   └── alerts.templates.ts    # Templates de mensagens de alerta
│   │   │   │
│   │   │   ├── auth/
│   │   │   │   ├── auth.controller.ts     # Endpoints de autenticação (login, registro)
│   │   │   │   ├── auth.middleware.ts      # Middleware JWT (verificação de token)
│   │   │   │   └── auth.service.ts        # Serviço de autenticação (hash, token)
│   │   │   │
│   │   │   ├── financial/
│   │   │   │   └── financial.controller.ts # Endpoints do dashboard (indicadores, transações)
│   │   │   │
│   │   │   ├── scenarios/
│   │   │   │   └── scenarios.controller.ts # Endpoints de cenários financeiros (CRUD)
│   │   │   │
│   │   │   └── upload/
│   │   │       └── upload.controller.ts    # Endpoints de upload CSV (importação + classificação IA)
│   │   │
│   │   ├── shared/
│   │   │   ├── database.ts            # Instância do Prisma Client (singleton)
│   │   │   └── errors.ts             # Classes de erro customizadas (AppError, etc.)
│   │   │
│   │   └── index.ts                   # Entry point: Express app, rotas, middlewares
│   │
│   ├── .env.example                   # Exemplo de variáveis de ambiente
│   ├── package.json                   # Dependências e scripts npm
│   └── tsconfig.json                  # Configuração do TypeScript
│
├── templates/                         # Modelos CSV para importação
│   ├── faturas_pagar_modelo.csv       # Modelo de faturas a pagar
│   ├── faturas_receber_modelo.csv     # Modelo de faturas a receber
│   └── transacoes_modelo.csv          # Modelo de transações
│
├── shared/                            # Pasta compartilhada (vazia no momento)
├── .gitignore                         # Arquivos ignorados pelo Git
└── README.md                          # Este arquivo
```

---

## Módulos

### Auth (`modules/auth/`)

Módulo de autenticação com registro e login de usuários via JWT.

| Arquivo | Responsabilidade |
|---------|-----------------|
| **auth.controller.ts** | Endpoints `POST /api/auth/register` e `POST /api/auth/login`. Valida dados com Zod, cria usuário/empresa e retorna token JWT. |
| **auth.middleware.ts** | Middleware que extrai e valida o token JWT do header `Authorization: Bearer <token>`. Injeta `req.user` com `userId` e `companyId`. |
| **auth.service.ts** | Funções de hash de senha (bcrypt) e geração/verificação de tokens JWT. |

### Financial (`modules/financial/`)

Módulo principal do dashboard financeiro.

| Arquivo | Responsabilidade |
|---------|-----------------|
| **financial.controller.ts** | Endpoint `GET /api/financial/dashboard` — calcula Saldo de Caixa (todas as transações), Taxa de Queima (média 6 meses), Runway, variação percentual e crescimento de receita. Endpoint `GET /api/financial/transactions` — listagem paginada com filtros por tipo e período. |

### Upload (`modules/upload/`)

Módulo de importação de dados via CSV.

| Arquivo | Responsabilidade |
|---------|-----------------|
| **upload.controller.ts** | Endpoint `POST /api/upload/csv` — recebe arquivo CSV via Multer, parseia com csv-parse, valida e insere transações no banco. Após inserção, dispara classificação por IA em lotes de 20 transações. Endpoint `GET /api/upload/history` — histórico de uploads. |

### AI (`modules/ai/`)

Módulo de integração com OpenAI.

| Arquivo | Responsabilidade |
|---------|-----------------|
| **ai.controller.ts** | Endpoints de chat financeiro (`POST /api/ai/chat`), reunião executiva (`POST /api/ai/meeting`) e explicação de indicadores (`POST /api/ai/explain`). |
| **ai.service.ts** | Serviço que encapsula chamadas à API OpenAI. Funções: `classifyTransactions` (classificação de transações em categorias), `chat` (assistente financeiro), `generateMeetingReport` (relatório executivo), `explainMetric` (explicação de indicadores). |

### Alerts (`modules/alerts/`)

Módulo de alertas financeiros inteligentes.

| Arquivo | Responsabilidade |
|---------|-----------------|
| **alerts.controller.ts** | Endpoints `GET /api/alerts` (listar alertas) e `PATCH /api/alerts/:id/dismiss` (dispensar alerta). |
| **alerts.detector.ts** | Lógica de detecção automática de alertas: saldo negativo, burn rate elevado, runway curto, queda de receita, etc. |
| **alerts.humanizer.ts** | Usa IA para transformar alertas técnicos em mensagens compreensíveis para o usuário. |
| **alerts.templates.ts** | Templates de mensagens de alerta com placeholders para valores dinâmicos. |

### Scenarios (`modules/scenarios/`)

Módulo de cenários financeiros (what-if).

| Arquivo | Responsabilidade |
|---------|-----------------|
| **scenarios.controller.ts** | CRUD de cenários financeiros: `GET /api/scenarios`, `POST /api/scenarios`, `PUT /api/scenarios/:id`, `DELETE /api/scenarios/:id`, `PATCH /api/scenarios/:id/toggle`. Cada cenário pode ter ajustes mensais de receita/despesa e valores únicos. |

---

## Endpoints da API

### Autenticação

| Método | Rota | Descrição | Auth |
|--------|------|-----------|------|
| `POST` | `/api/auth/register` | Registrar usuário e empresa | Não |
| `POST` | `/api/auth/login` | Login (retorna JWT) | Não |

### Dashboard Financeiro

| Método | Rota | Descrição | Auth |
|--------|------|-----------|------|
| `GET` | `/api/financial/dashboard` | Indicadores: saldo, burn rate, runway, variações | Sim |
| `GET` | `/api/financial/transactions` | Transações paginadas com filtros | Sim |

### Upload de Dados

| Método | Rota | Descrição | Auth |
|--------|------|-----------|------|
| `POST` | `/api/upload/csv` | Upload e importação de CSV | Sim |
| `GET` | `/api/upload/history` | Histórico de uploads | Sim |

### Inteligência Artificial

| Método | Rota | Descrição | Auth |
|--------|------|-----------|------|
| `POST` | `/api/ai/chat` | Chat com assistente financeiro | Sim |
| `POST` | `/api/ai/meeting` | Gerar relatório de reunião executiva | Sim |
| `POST` | `/api/ai/explain` | Explicar indicador financeiro | Sim |

### Alertas

| Método | Rota | Descrição | Auth |
|--------|------|-----------|------|
| `GET` | `/api/alerts` | Listar alertas da empresa | Sim |
| `PATCH` | `/api/alerts/:id/dismiss` | Dispensar um alerta | Sim |

### Cenários

| Método | Rota | Descrição | Auth |
|--------|------|-----------|------|
| `GET` | `/api/scenarios` | Listar cenários | Sim |
| `POST` | `/api/scenarios` | Criar cenário | Sim |
| `PUT` | `/api/scenarios/:id` | Atualizar cenário | Sim |
| `DELETE` | `/api/scenarios/:id` | Deletar cenário | Sim |
| `PATCH` | `/api/scenarios/:id/toggle` | Ativar/desativar cenário | Sim |

---

## Variáveis de Ambiente

Crie um arquivo `.env` dentro da pasta `server/` com base no `.env.example`:

```env
DATABASE_URL=postgresql://usuario:senha@host:porta/banco
JWT_SECRET=sua_chave_secreta_jwt
OPENAI_API_KEY=sk-sua-chave-openai
PORT=3001
```

| Variável | Descrição |
|----------|-----------|
| `DATABASE_URL` | Connection string do PostgreSQL (Railway) |
| `JWT_SECRET` | Chave secreta para assinatura de tokens JWT |
| `OPENAI_API_KEY` | Chave da API OpenAI para classificação e chat |
| `PORT` | Porta do servidor (padrão: 3001) |

---

## Scripts Disponíveis

Todos os scripts devem ser executados dentro da pasta `server/`:

```bash
cd server

# Desenvolvimento (hot reload)
npm run dev

# Build para produção
npm run build

# Iniciar em produção
npm start

# Gerar Prisma Client
npm run db:generate

# Aplicar schema ao banco (sem migration)
npm run db:push

# Criar migration
npm run db:migrate

# Rodar seed (dados iniciais)
npm run db:seed

# Abrir Prisma Studio (UI visual do banco)
npm run db:studio
```

---

## Setup Local

**Passo 1 — Clone o repositório e instale dependências:**

```bash
cd ~/Desktop/lume-mvp/server
npm install
```

**Passo 2 — Configure as variáveis de ambiente:**

```bash
cp .env.example .env
# Edite o .env com suas credenciais
```

**Passo 3 — Configure o banco de dados:**

```bash
npm run db:generate
npm run db:push
npm run db:seed    # opcional: dados iniciais
```

**Passo 4 — Inicie o servidor:**

```bash
npm run dev
```

O servidor estará disponível em `http://localhost:3001`.

---

## Deploy (Railway)

O projeto está configurado para deploy automático no **Railway** via push para a branch `main`.

```bash
git add .
git commit -m "descrição da mudança"
git push origin main
```

O Railway detecta o push, executa `npm run build` e inicia com `npm start`. O banco PostgreSQL é provisionado como serviço separado no Railway.

**Configuração no Railway:**
- **Build Command:** `cd server && npm install && npm run db:generate && npm run build`
- **Start Command:** `cd server && npm start`
- **Variables:** Configurar `DATABASE_URL`, `JWT_SECRET`, `OPENAI_API_KEY` e `PORT` nas variáveis do serviço.

---

## Templates CSV

A pasta `templates/` contém modelos de CSV para importação de dados:

| Arquivo | Descrição |
|---------|-----------|
| **transacoes_modelo.csv** | Modelo padrão de transações (data, tipo, descrição, valor) |
| **faturas_pagar_modelo.csv** | Modelo de faturas a pagar |
| **faturas_receber_modelo.csv** | Modelo de faturas a receber |

---

## Banco de Dados

O schema Prisma (`server/prisma/schema.prisma`) define os seguintes modelos principais:

| Modelo | Descrição |
|--------|-----------|
| **User** | Usuários do sistema (email, senha hash, empresa) |
| **Company** | Empresa vinculada ao usuário |
| **Transaction** | Transações financeiras (data, tipo, valor, descrição, categoria) |
| **Category** | Categorias de transações (classificadas por IA) |
| **Upload** | Registro de uploads de CSV (status, total de linhas) |
| **Alert** | Alertas financeiros gerados automaticamente |
| **Scenario** | Cenários financeiros (what-if) com ajustes |

---

## Dependências Principais

```json
{
  "@prisma/client": "^5.22.0",
  "bcryptjs": "^2.4.3",
  "cors": "^2.8.5",
  "csv-parse": "^5.6.0",
  "express": "^4.21.0",
  "helmet": "^8.0.0",
  "jsonwebtoken": "^9.0.2",
  "multer": "^1.4.5-lts.1",
  "openai": "^4.73.0",
  "zod": "^3.23.8"
}
```
