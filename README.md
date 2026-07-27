# Finanças

Controle de finanças pessoais com IA integrada. Uso pessoal, dados locais.

A IA não é enfeite: ela lança e edita dados por linguagem natural ("gastei 45 no
mercado ontem no crédito do nubank em 3x") e gera insights sobre os seus números
reais. Toda alteração que ela faz é auditada e reversível.

**Completo e funcionando.** Backend com 111 rotas e 364 testes, interface PC-98
ligada à API real, IA conversacional com confirmação e desfazer.
verificada. Falta o frontend.

## Requisitos

- Node 22 ou superior (testado no 24.16)
- Nada mais. O banco é um arquivo SQLite.

## Começando

```bash
npm install && npm run web:install
```

Copie `.env.example` para `.env` e preencha. Gere o segredo de sessão com:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Defina uma `APP_PASSWORD` de verdade — o servidor **recusa subir** com a senha de
exemplo enquanto a autenticação estiver ativa. Depois:

```bash
npm run db:migrate
```

Para experimentar com 12 meses de dados fictícios antes de usar de verdade:

```bash
npm run db:seed
```

E então converse com o assistente:

```bash
npm run chat
```

## Comandos

Duas partes: o servidor (API + IA) e a interface. Em desenvolvimento rodam
separados; em produção o servidor entrega os dois.

### Desenvolvimento (dois terminais)

```bash
npm run dev
```

```bash
npm run dev:web
```

A interface abre em **http://localhost:3000** com recarga automática. O Vite faz
proxy de `/api` para o servidor, então não há CORS nem configuração extra.

### Produção (um comando, uma porta)

```bash
npm run build
```

```bash
npm start
```

Tudo em **http://127.0.0.1:3333** — interface na raiz, API nas rotas, documentação
em `/docs`. É este o modo para acessar do celular.

### Todos os scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor (API + IA) em modo watch |
| `npm run dev:web` | Interface com recarga automática |
| `npm run build` | Compila servidor e interface |
| `npm start` | Sobe tudo numa porta só |
| `npm run chat` | Conversa com a IA no terminal |
| `npm test` | Suíte de testes |
| `npm run typecheck` | Checagem de tipos |
| `npm run db:migrate` | Aplica as migrations |
| `npm run db:seed` | 12 meses de dados de demonstração |
| `npm run web:install` | Instala as dependências da interface |

## A interface

**KAKEIBO.SYS** — estação de trabalho financeira em estilo NEC PC-9801, com
tipografia pixel (VT323, DotGothic16, Silkscreen), molduras biseladas, gráficos
desenhados em canvas sem antialiasing e mascotes animados. O design system está
documentado em [docs/DESIGN.md](docs/DESIGN.md).

Layout de três colunas: navegação à esquerda, área de trabalho no centro e o dock
da IA à direita, sempre presente. Tema claro e escuro (padrão claro), alternável na
barra de status. No celular a navegação colapsa em trilha de chips e o dock da IA
vira sobreposição.

Nada de dinheiro é calculado aqui: todo número exibido vem de um endpoint que o
backend calculou. A interface formata e desenha.

## O que dá para fazer

**Núcleo** — contas (corrente, poupança, dinheiro, carteira digital,
investimento, cartão), transações com rateio entre categorias e tags,
transferências entre contas próprias, categorias em dois níveis, favorecidos.

**Cartão de crédito** — ciclos de fatura com atribuição correta da compra ao
ciclo, parcelamentos que fecham no centavo, pagamento de fatura (total ou
parcial) modelado como transferência.

**Recorrências** — contas fixas e assinaturas materializadas como lançamentos
futuros, com valor fixo ou estimado, confirmação do valor real quando a conta
chega, e promoção automática na data.

**Planejamento** — orçamentos por categoria com rollover da sobra, metas de
economia (com conta própria ou como caixinha virtual), dívidas com amortização
SAC/Price e simulação de quitação antecipada.

**Investimentos** — carteira com quantidade exata até 8 casas decimais (cripto),
preço médio derivado do custo total, proventos e valorização por cotação manual.

**Importação** — extratos CSV (`;` ou `,`, datas em `DD/MM/AAAA` ou ISO, colunas
de débito/crédito separadas) e OFX, com deduplicação e reversão do lote inteiro.

**Regras** — auto-categorização que aprende do seu histórico: o sistema sugere
regras a partir dos padrões que você já categorizou consistentemente.

**Relatórios** — fluxo de caixa mensal, gasto por categoria com rollup,
comparação entre meses, tendências com mediana, projeção de saldo dia a dia,
comprometimento da renda futura, evolução patrimonial.

**IA** — 35 ferramentas sobre os mesmos serviços da API, chat com streaming,
lançamento por linguagem natural, e insights determinísticos narrados.

## Como a IA funciona

Ela recebe um retrato financeiro agregado (contas, saldos, mês corrente,
orçamentos, contas a vencer, projeção) e um conjunto de ferramentas que chamam os
**mesmos serviços** que a API HTTP usa. Não existe caminho pelo qual ela faça algo
que a interface não faria.

**Ela não faz conta.** Todo número vem de função determinística ou SQL; o modelo
escolhe ferramentas e escreve o texto. Datas relativas ("sexta passada") são
resolvidas por um parser em português, não pelo modelo — que erraria calendário de
forma plausível.

**Autonomia com trava.** Operações leves entram direto. Exclusões, alterações em
lote acima de N linhas e valores acima de um limite configurável **não são
executadas**: a IA devolve um resumo do que faria e espera sua confirmação.
Os limites ficam em `GET /settings` (padrão: R$ 500 e 5 linhas).

Uma ferramenta nova sem política de risco declarada cai automaticamente em
"pedir confirmação" — errar para o lado cauteloso é a única direção aceitável.
Há teste garantindo isso.

**Tudo reversível.** Cada escrita devolve um `changeSetId`. `GET /change-sets/{id}`
mostra o diff campo a campo; `POST /change-sets/{id}/undo` reverte. Desfazer um
undo refaz. `GET /ai/actions` lista tudo o que a IA já fez.

## Como o projeto é organizado

```
src/
  config/     Ambiente validado por zod, na partida
  core/       Dinheiro, datas, IDs, erros — sem dependência de banco
  db/         Schema Drizzle (31 tabelas), conexão, migrations, seed
  mutate/     O único caminho de escrita: auditoria + change set + undo
  services/   Regras de negócio — a única camada que toca o banco
  api/        Rotas Fastify, autenticação, OpenAPI
  ai/         Provider, contexto, ferramentas, classificação de risco, agente
  insights/   Analisadores determinísticos + narrador
  jobs/       Rotina diária e backup
  cli/        REPL de conversa
tests/
  unit/         Funções puras: dinheiro, datas, ciclo de fatura, amortização
  integration/  Serviços e API contra SQLite temporário
```

## As três regras de arquitetura

Detalhadas em [docs/DECISIONS.md](docs/DECISIONS.md):

1. **Só `services/` toca o banco.** API e IA são clientes dos mesmos serviços.
2. **Todo write passa por `mutate()`.** Não existe outro caminho, então é
   impossível esquecer de auditar.
3. **O LLM nunca faz conta.** Todo número vem de código determinístico.

## Verificação de integridade

`GET /integrity` confere as invariantes contábeis: saldo de cada conta bate com a
soma das transações, toda transferência tem duas pernas somando zero, todo rateio
fecha com o valor da transação, e o sinal do valor combina com o tipo. Se algo
aparecer aqui, existe escrita acontecendo fora do `mutate()`.

A rotina diária roda essa verificação e registra no log.

## Segurança dos seus dados

- `data/` e `.env` estão no `.gitignore`. Dado financeiro não entra em repositório.
- Autenticação não pode ser desligada com o servidor exposto na rede:
  `authConfig()` ignora `AUTH_DISABLED=true` se o `HOST` não for loopback.
- Senha verificada com `scrypt` em tempo constante, sessão em cookie assinado por
  HMAC, cinco tentativas de login por minuto.
- Backup com `VACUUM INTO` (cópia consistente mesmo com o servidor rodando),
  retenção de 30 dias, em `POST /system/backup`.

## Fases

- [x] 0 — Fundação: core, schema, migrations, `mutate()` com auditoria e undo
- [x] 1 — Núcleo transacional: contas, transações, transferências, rateios, saldos
- [x] 2 — Cartão de crédito: faturas, ciclos, parcelamentos
- [x] 3 — Recorrências e projeção de saldo
- [x] 4 — Orçamentos, metas e dívidas
- [x] 5 — Investimentos
- [x] 6 — Importação CSV/OFX e motor de regras
- [x] 7 — Relatórios
- [x] 8 — IA: agente, ferramentas, chat, autonomia com confirmação
- [x] 9 — IA: insights determinísticos e relatórios narrados
- [x] 10 — Endurecimento: autenticação, backup, seed, rede local
- [x] **Frontend** — interface PC-98 sobre a API real

## Acessando do celular

Mude o `HOST` no `.env` para `0.0.0.0`, garanta que `APP_PASSWORD` está definida,
e descubra o IP da máquina na rede:

```bash
ipconfig
```

No celular, acesse `http://SEU_IP:3333/docs`. Faça login em `POST /auth/login`
antes de usar as rotas de dados.
