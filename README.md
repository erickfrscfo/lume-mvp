# Esnork - Backend

## 📋 Visão Geral

Backend da plataforma Esnork, um sistema de inteligência financeira para PMEs. A API REST é responsável por autenticação, empresas, plano de contas, transações, importação CSV, OCR de documentos, conciliação, alertas, insights, relatórios e integrações com IA.

O servidor fica em `lume-mvp/server` e usa Node.js, Express, Prisma, PostgreSQL e OpenAI.

## 🚀 Quick Start

### Pré-requisitos

- Node.js 22+ recomendado
- npm 10+
- PostgreSQL 15+
- Chave da API OpenAI

### Instalação

```bash
cd lume-mvp/server
npm install
```

### Configuração

Copie `server/.env.example` para `server/.env` e preencha:

```env
DATABASE_URL="postgresql://usuario:senha@host:porta/nome_banco?sslmode=require"
JWT_SECRET="gere-uma-string-aleatoria-com-pelo-menos-32-caracteres-aqui"
JWT_EXPIRES_IN="7d"
OPENAI_API_KEY="sk-sua-chave-aqui"
PORT=3001
NODE_ENV="development"
CORS_ORIGIN="http://localhost:5173"
ADMIN_ONBOARDING_KEY="sua-chave-admin"
```

> `ADMIN_ONBOARDING_KEY` é exigida por `src/config/env.ts` e precisa existir mesmo em desenvolvimento.

### Banco de dados

```bash
cd lume-mvp/server
npm run db:generate
npm run db:migrate
npm run db:seed
```

### Rodar em desenvolvimento

```bash
npm run dev
```

Servidor padrão: `http://localhost:3001`.

### Build e produção

```bash
npm run build
npm start
```

## 📁 Estrutura do Projeto

```text
lume-mvp/
├── README.md
├── templates/                         # Modelos CSV para importação
│   ├── transacoes_modelo.csv
│   ├── faturas_pagar_modelo.csv
│   └── faturas_receber_modelo.csv
└── server/
    ├── prisma/
    │   ├── schema.prisma              # Modelos, enums e relações
    │   ├── seed.ts                    # Seed principal
    │   ├── seed-conciliation.ts       # Seed de conciliação
    │   └── migrations/                # Migrações Prisma
    ├── src/
    │   ├── config/
    │   │   └── env.ts                 # Validação de ambiente com Zod
    │   ├── modules/
    │   │   ├── ai/                    # Chat, explicações e classificação de custos
    │   │   ├── alerts/                # Alertas financeiros
    │   │   ├── auth/                  # Login, registro, sessão e senha
    │   │   ├── category/              # Plano de contas
    │   │   ├── counterparties/        # Clientes, fornecedores e contrapartes
    │   │   ├── documents/             # Documentos fiscais
    │   │   ├── financial/             # Dashboard, DRE, fluxo e transações
    │   │   ├── forecast/              # Projeções de caixa
    │   │   ├── insights/              # Insights de IA
    │   │   ├── ocr/                   # Extração de dados de PDF/imagem
    │   │   ├── reconciliations/       # Conciliação financeira
    │   │   ├── report/                # Relatórios e indicadores
    │   │   ├── scenarios/             # Cenários what-if
    │   │   ├── transactions/          # Operações de pagamento/recebimento
    │   │   └── upload/                # Importação CSV
    │   ├── shared/                    # Prisma, erros e utilitários compartilhados
    │   └── index.ts                   # Express app, middlewares e rotas
    ├── .env.example
    ├── package.json
    └── tsconfig.json
```

## 🔧 Funcionalidades

- Autenticação por JWT com login por usuário, senha e código da empresa.
- Onboarding administrativo com chave `X-Admin-Key`.
- Cadastro de empresa, usuário e plano de contas customizado.
- Dashboard financeiro com saldo, burn rate, runway, crescimento e métricas agregadas.
- Fluxo de caixa e DRE por período.
- CRUD de transações financeiras.
- Importação CSV com parsing, validação e histórico.
- Classificação de transações e custos com IA.
- OCR de PDFs e imagens com GPT-4o para extrair valores, datas, contraparte, categoria sugerida e itens.
- Confirmação de OCR com criação de documento, contraparte e transação.
- Alertas financeiros com severidade, leitura, dispensa e geração.
- Forecast de fluxo financeiro por cenário.
- Gestão de contrapartes.
- Gestão de documentos fiscais.
- Conciliação financeira em lote.
- Insights de IA com leitura e dispensa.
- Relatórios dinâmicos com indicadores padrão, customizados e template persistido.
- Cenários financeiros what-if com chat auxiliar.
- Plano de contas por empresa, com resolução de categorias customizadas quando existe código global equivalente.

## 📦 Dependências

Versões principais conforme `server/package.json`:

| Pacote | Versão | Uso |
| --- | --- | --- |
| `express` | `^4.21.0` | API HTTP. |
| `@prisma/client` / `prisma` | `5.22.0` | ORM, migrations e client. |
| `typescript` | `^5.6.3` | Tipagem e build. |
| `tsx` | `^4.19.2` | Execução TypeScript em desenvolvimento. |
| `openai` | `^4.104.0` | Chat, OCR e classificações com IA. |
| `jsonwebtoken` | `^9.0.2` | Tokens JWT. |
| `bcryptjs` | `^2.4.3` | Hash de senhas. |
| `zod` | `^3.23.8` | Validação de payloads e ambiente. |
| `multer` | `^1.4.5-lts.1` | Upload de arquivos. |
| `csv-parse` | `^5.6.0` | Parsing CSV. |
| `pdf-to-png-converter` | `^3.14.0` | Conversão de PDFs para OCR. |
| `helmet` | `^8.0.0` | Headers de segurança. |
| `cors` | `^2.8.5` | CORS para frontend. |
| `date-fns` | `^2.30.0` | Manipulação de datas. |

## 🔌 Integrations

### PostgreSQL

O banco é configurado por `DATABASE_URL`. O schema Prisma contém os principais modelos:

- `Company`, `User`, `CompanyCategory`, `Category`
- `Transaction`, `TransactionDetail`, `Upload`
- `Counterparty`, `Document`
- `Scenario`, `Alert`, `AiInsight`, `AiInteraction`
- `ReportTemplate`, `CustomIndicator`, `PromptTemplate`

### OpenAI

Usado nos módulos:

- `ai`: chat financeiro, explicação de indicadores e classificação de custos.
- `upload`: classificação de transações importadas por CSV.
- `ocr`: extração estruturada de documentos PDF/imagem.
- `alerts`: humanização de alertas.
- `report`: criação de indicadores customizados.

### Frontend

Configure `CORS_ORIGIN` com a URL do frontend:

```env
CORS_ORIGIN="http://localhost:5173"
```

Use `CORS_ORIGIN="*"` apenas em ambiente controlado de MVP.

## Endpoints

Todas as rotas abaixo são prefixadas por `/api`.

### Health

| Método | Rota | Auth | Descrição |
| --- | --- | --- | --- |
| `GET` | `/health` | Não | Status do servidor. |

### Auth

| Método | Rota | Auth | Descrição |
| --- | --- | --- | --- |
| `POST` | `/auth/validate-admin-key` | `X-Admin-Key` | Valida chave de onboarding administrativo. |
| `POST` | `/auth/register` | `X-Admin-Key` | Cria empresa, usuário e plano de contas. |
| `POST` | `/auth/login` | Não | Login e emissão de JWT. |
| `GET` | `/auth/me` | Sim | Dados do usuário autenticado. |
| `PATCH` | `/auth/change-password` | Sim | Alteração de senha. |

### Financial

| Método | Rota | Auth | Descrição |
| --- | --- | --- | --- |
| `GET` | `/financial/dashboard` | Sim | Indicadores gerais. |
| `GET` | `/financial/cashflow` | Sim | Fluxo de caixa por meses. |
| `GET` | `/financial/dre` | Sim | Demonstrativo de resultado. |
| `GET` | `/financial/sectors` | Sim | Setores suportados. |
| `GET` | `/financial/transactions` | Sim | Lista transações com filtros. |
| `POST` | `/financial/transactions` | Sim | Cria transação. |
| `PATCH` | `/financial/transactions/:id` | Sim | Atualiza transação. |
| `DELETE` | `/financial/transactions/:id` | Sim | Remove transação. |
| `GET` | `/financial/cost-breakdown` | Sim | Breakdown de custos fixos/variáveis. |
| `GET` | `/financial/pending-details` | Sim | Transações pendentes de detalhamento. |

### Upload CSV

| Método | Rota | Auth | Descrição |
| --- | --- | --- | --- |
| `POST` | `/upload/csv` | Sim | Importa arquivo CSV. |
| `GET` | `/upload/history` | Sim | Histórico de uploads. |
| `GET` | `/upload/template` | Sim | Template esperado para importação. |

### OCR

| Método | Rota | Auth | Descrição |
| --- | --- | --- | --- |
| `POST` | `/ocr/extract` | Sim | Extrai dados de PDF/imagem. |
| `GET` | `/ocr/history` | Sim | Histórico de documentos extraídos. |
| `GET` | `/ocr/document/:documentId` | Sim | Detalhes extraídos de um documento. |
| `POST` | `/ocr/confirm/:documentId` | Sim | Confirma OCR e cria transação. |

### AI

| Método | Rota | Auth | Descrição |
| --- | --- | --- | --- |
| `POST` | `/ai/chat` | Sim | Chat financeiro. |
| `POST` | `/ai/explain` | Sim | Explica indicador financeiro. |
| `POST` | `/ai/classify-cost-type` | Sim | Classifica custo fixo/variável. |
| `GET` | `/ai/pending-cost-classifications` | Sim | Lista transações pendentes de classificação. |
| `PUT` | `/ai/update-cost-type/:id` | Sim | Atualiza tipo de custo manualmente. |
| `GET` | `/ai/suggested-prompts` | Sim | Sugestões de prompts. |
| `GET` | `/ai/chat/history` | Sim | Histórico de interações. |

### Alertas e Insights

| Método | Rota | Auth | Descrição |
| --- | --- | --- | --- |
| `GET` | `/alerts` | Sim | Lista alertas. |
| `PATCH` | `/alerts/:id/read` | Sim | Marca alerta como lido. |
| `PATCH` | `/alerts/:id/dismiss` | Sim | Dispensa alerta. |
| `POST` | `/alerts/generate` | Sim | Gera alertas manualmente. |
| `GET` | `/insights` | Sim | Lista insights. |
| `PATCH` | `/insights/:id/read` | Sim | Marca insight como lido. |
| `PATCH` | `/insights/:id/dismiss` | Sim | Dispensa insight. |

### Cenários, Forecast e Relatórios

| Método | Rota | Auth | Descrição |
| --- | --- | --- | --- |
| `GET` | `/scenarios` | Sim | Lista cenários. |
| `POST` | `/scenarios` | Sim | Cria cenário. |
| `PUT` | `/scenarios/:id` | Sim | Atualiza cenário. |
| `PATCH` | `/scenarios/:id/toggle` | Sim | Ativa/desativa cenário. |
| `DELETE` | `/scenarios/:id` | Sim | Remove cenário. |
| `POST` | `/scenarios/ai-chat` | Sim | Chat auxiliar para cenários. |
| `GET` | `/forecast` | Sim | Gera forecast. |
| `GET` | `/report/indicators` | Sim | Lista indicadores disponíveis. |
| `GET` | `/report/template` | Sim | Busca template salvo. |
| `PUT` | `/report/template` | Sim | Salva template. |
| `POST` | `/report/generate` | Sim | Gera relatório. |
| `POST` | `/report/indicators/custom` | Sim | Cria indicador customizado. |
| `DELETE` | `/report/indicators/custom/:id` | Sim | Remove indicador customizado. |

### Operacional

| Método | Rota | Auth | Descrição |
| --- | --- | --- | --- |
| `GET` | `/transactions` | Sim | Lista transações operacionais. |
| `PATCH` | `/transactions/:id/mark-paid` | Sim | Marca despesa como paga. |
| `PATCH` | `/transactions/:id/mark-received` | Sim | Marca receita como recebida. |
| `GET` | `/counterparties` | Sim | Lista contrapartes. |
| `POST` | `/counterparties` | Sim | Cria contraparte. |
| `PUT` | `/counterparties/:id` | Sim | Atualiza contraparte. |
| `DELETE` | `/counterparties/:id` | Sim | Inativa/remove contraparte. |
| `GET` | `/documents` | Sim | Lista documentos. |
| `POST` | `/documents` | Sim | Cria documento. |
| `PUT` | `/documents/:id` | Sim | Atualiza documento. |
| `DELETE` | `/documents/:id` | Sim | Remove documento. |
| `GET` | `/reconciliations/dashboard` | Sim | Dashboard de conciliação. |
| `POST` | `/reconciliations/batch` | Sim | Conciliação em lote. |
| `GET` | `/categories` | Sim | Lista plano de contas. |

## Scripts

Todos os comandos abaixo devem ser executados em `lume-mvp/server`:

```bash
npm run dev          # Desenvolvimento com tsx watch
npm run build        # Build TypeScript para dist/
npm start            # Executa dist/index.js
npm run db:generate  # Gera Prisma Client
npm run db:push      # Aplica schema sem migration
npm run db:migrate   # Cria/aplica migration em desenvolvimento
npm run db:seed      # Roda seed principal
npm run db:studio    # Abre Prisma Studio
```

## 🐛 Troubleshooting

### Servidor encerra ao iniciar

Verifique as variáveis obrigatórias em `server/.env`. `JWT_SECRET` precisa ter pelo menos 32 caracteres e `ADMIN_ONBOARDING_KEY` precisa estar definida.

### Erro de conexão com banco

Confirme `DATABASE_URL`, acesso de rede ao PostgreSQL e se o banco exige `sslmode=require`.

### Prisma Client desatualizado

Execute:

```bash
npm run db:generate
```

### Migrações não aplicadas

Em desenvolvimento:

```bash
npm run db:migrate
```

Em ambientes controlados sem migration:

```bash
npm run db:push
```

### OCR falha com PDF ou imagem

Confirme `OPENAI_API_KEY`, tamanho/formato do arquivo e disponibilidade da API OpenAI. Para PDFs problemáticos, converter para JPG/PNG pode melhorar a extração.

### CORS bloqueando o frontend

Configure:

```env
CORS_ORIGIN="http://localhost:5173"
```

### Categorias customizadas não gravam na transação

`Transaction.categoryId` referencia a tabela global `Category`. Categorias customizadas são resolvidas por código; quando não existe código global equivalente, a transação permanece sem `categoryId` para evitar violação de chave estrangeira.

## 📝 Changelog

### 2026-06-02 — Correções funcionais

- `/api/categories` passou a resolver o plano de contas da empresa, incluindo categorias customizadas.
- Criação/edição manual de transações passou a aceitar `categoryCode` e resolver para `Category` global quando possível.
- OCR passou a sugerir e confirmar categorias usando o plano de contas da empresa.
- Geração de código da empresa no onboarding passou a verificar colisões antes de criar a empresa.
- README corrigido para indicar autenticação real dos controllers que usam `router.use(authMiddleware)`.

### 2026-06-02

- README atualizado para refletir a estrutura atual do backend.
- Documentados módulos adicionados desde a versão inicial: OCR, documentos, contrapartes, conciliação, insights, forecast, relatórios e categorias.
- Atualizadas dependências reais conforme `server/package.json`.
- Documentadas variáveis obrigatórias de ambiente, incluindo `ADMIN_ONBOARDING_KEY`.
- Documentados endpoints registrados em `src/index.ts` e controllers.
- Incluída observação de segurança sobre controllers sem `authMiddleware` direto.

### Histórico anterior

- API REST inicial com autenticação JWT.
- Dashboard financeiro, importação CSV e IA financeira.
- Alertas, cenários e classificação de transações.
