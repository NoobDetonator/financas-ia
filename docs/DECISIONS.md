# Decisões de arquitetura

Registro do que foi decidido e **por quê**, para que a razão não se perca. O
critério declarado do projeto é manutenção e adição de funcionalidades a longo
prazo, não velocidade de escrita inicial.

---

## 1. Só a camada de serviços toca o banco

A API HTTP e as ferramentas da IA são clientes dos mesmos serviços.

**Por quê:** o app tem dois consumidores (você pela interface, e a IA por
linguagem natural) que precisam obedecer às mesmas regras. Se a IA escrevesse
direto no banco, cada regra nova teria que ser implementada duas vezes, e a
segunda implementação divergiria — é questão de tempo. Com um caminho único,
"não deixar transferência aparecer como receita" é escrito uma vez e vale para
os dois.

---

## 2. Todo write passa por `mutate()`

`src/mutate/index.ts` é o único caminho de escrita. Em troca de usar
`ctx.insert/update/remove` em vez do Drizzle direto, todo write ganha transação
atômica, registro em `audit_log` com a linha inteira antes e depois,
agrupamento em `change_set` (a unidade de undo) e rastreio de autor.

**Por quê:** é o que torna viável dar autonomia de escrita à IA. Sem auditoria e
undo, autonomia é aposta; com eles, qualquer coisa que a IA faça é inspecionável
e reversível. E a garantia tem que ser estrutural: se auditar fosse opcional,
alguém esqueceria exatamente no serviço que mais importa.

### Consequência: cascade não é auditado

`onDelete: 'cascade'` existe no schema como rede de segurança de integridade,
mas os serviços devem apagar os filhos **explicitamente** via `ctx.remove()`
antes do pai. Um cascade do SQLite não passa pelo audit log, e o `undo` não teria
como restaurar os filhos — o undo ficaria silenciosamente incompleto, que é pior
do que não ter undo.

### Consequência: undo restaura `updated_at`

Ao desfazer um update, a linha inteira do `before` é reaplicada, inclusive
`updated_at` (um valor explícito vence o `$onUpdateFn` do Drizzle). Assim
"desfazer" devolve o estado exato, e não algo *quase* igual. O fato de a
reversão ter acontecido fica registrado no próprio `audit_log`, que é o lugar
certo para isso. Há teste que compara a tabela inteira antes e depois — se
`updated_at` não fosse restaurado, ele falharia.

---

## 3. O LLM nunca faz conta

Todo número vem de função determinística ou query SQL. O modelo escolhe
ferramentas e escreve texto; os analisadores de insight produzem structs
tipados com os números e os IDs das transações que servem de evidência, e o LLM
apenas narra.

**Por quê:** LLM erra aritmética de forma plausível, que é o pior tipo de erro
num app de finanças — "você gastou R$ 3.000 em alimentação" soa igualmente
convincente estando certo ou errado. Como efeito colateral, o custo de token cai
muito (nada de despejar linhas cruas no prompt) e os insights ficam
reproduzíveis e auditáveis.

---

## 4. Dinheiro é inteiro em centavos, sempre

`core/money.ts`. Nunca float, em lugar nenhum: nem no banco, nem na API, nem nas
ferramentas da IA. A formatação também é feita a partir do inteiro, sem dividir
por 100 em float.

**Por quê:** `0.1 + 0.2 !== 0.3`. O erro não aparece no primeiro lançamento —
aparece meses depois, num relatório que não fecha por um centavo, e aí a causa
está espalhada por todo o histórico.

`splitEvenly` garante que a soma das parcelas é **exatamente** o total (R$ 100
em 3x = `[3334, 3333, 3333]`, não 3 × 33,33). Há teste de propriedade cobrindo
todas as combinações de total e número de parcelas.

---

## 5. Data civil é o tipo do domínio, não `Date`

`IsoDate` (`YYYY-MM-DD`) para competência, vencimento e dia de recorrência.
Aritmética interna via `Date.UTC`. O único ponto sensível a fuso é "que dia é
hoje", que usa `America/Sao_Paulo` explicitamente.

**Por quê:** competência de transação não tem hora. Tratada como `Date`, uma
transação do dia 1º vira dia 31 do mês anterior dependendo do fuso — e o gasto
migra de mês no relatório. Há teste que fixa o relógio em 02:00 UTC de 1º de
março e confirma que, em São Paulo, ainda é 28 de fevereiro.

O relógio é injetável (`setClock`) porque testar recorrência, fechamento de
fatura e projeção exige congelar o tempo.

---

## 6. A camada de serviços é síncrona

O driver `better-sqlite3` é síncrono, e isso foi mantido de propósito. Código
assíncrono fica restrito às bordas de IO: HTTP, chamadas de LLM e arquivos.

**Por quê:** transação síncrona não pode vazar por um `await` esquecido no meio.
Isso elimina de saída a classe de bug mais difícil de diagnosticar num sistema
financeiro — a transação que ficou aberta, ou que commitou pela metade porque
alguém colocou um `await` dentro do callback.

---

## 7. IDs são ULID, não UUID v4

`core/ids.ts`. 26 caracteres, Crockford base32, monotônicos dentro do mesmo
milissegundo.

**Por quê:** são ordenáveis por tempo de criação. O índice da chave primária não
fragmenta, `ORDER BY id` já dá ordem cronológica, paginação por cursor funciona
sem coluna extra, e ao depurar dá para saber quando a linha nasceu só de olhar o
ID. A monotonicidade mantém estável a ordem de duas linhas criadas no mesmo tick,
o que importa para a sequência do audit log.

Usam `Date.now()` real, não o relógio injetável: congelar o tempo em teste não
deve produzir IDs repetidos.

---

## 8. SQLite, com Drizzle e `casing: 'snake_case'`

Um arquivo, backup por cópia, zero infraestrutura, e rápido demais para um
usuário. O schema em TypeScript é a fonte única de verdade, e as migrations são
geradas a partir dele.

**Cuidado:** o `casing: 'snake_case'` precisa estar **igual** em
`src/db/client.ts` e em `drizzle.config.ts`. Se divergirem, as migrations criam
colunas com nome diferente do que o runtime consulta, e o erro aparece só na
primeira query.

O `PRAGMA foreign_keys = ON` é por conexão — sem ele o SQLite ignora as foreign
keys silenciosamente. Fica em `applyPragmas()`. `synchronous = FULL` porque o
volume de escrita é ínfimo e perder o último lançamento não vale a economia.

---

## 9. `better-sqlite3` fixado em `~12.6.2`

**Por quê:** esta máquina não compila addons nativos (node-gyp falha por falta de
MSVC build tools). A versão 13.0.1 não tem binário pré-compilado para Node 24 e
quebra o `npm install`, deixando `node_modules` vazio. A 12.6.2 tem prebuild e
funciona.

Antes de adicionar qualquer dependência nativa, verificar se há prebuild para
Node 24 — ou preferir alternativa em JS puro / do próprio Node.

---

## 10. Scalar em vez de `@fastify/swagger-ui` para o `/docs`

**Por quê:** `@fastify/swagger-ui` depende de `@fastify/static@^9`, que tem
vulnerabilidade high de bypass de autorização por path traversal (corrigida só
na 10.x, fora do range que o swagger-ui aceita). O `@scalar/fastify-api-reference`
serve a UI sozinho, sem `@fastify/static`, o que elimina o problema na raiz em
vez de contorná-lo com `overrides`. Importa porque este servidor fica exposto na
rede local.

`@fastify/swagger` continua gerando a especificação, e a rota `/openapi.json` é
registrada manualmente — a v9 não a expõe por conta própria.

Restam 4 vulnerabilidades moderate em `drizzle-kit → esbuild`: são
devDependency, e a falha é do dev-server do esbuild, que nunca roda aqui.

---

## 11. Autenticação não pode ser desligada com o servidor exposto

`authConfig()` em `src/config/env.ts` ignora `AUTH_DISABLED=true` quando `HOST`
não é loopback.

**Por quê:** o modo de uso previsto inclui lançar gastos pelo celular no Wi-Fi.
Uma configuração conveniente para desenvolvimento não pode, por descuido, deixar
as finanças abertas para qualquer dispositivo na rede — inclusive o da visita.

---

## 12. A IA não faz conta, e as datas não passam pelo modelo

Todo número que a IA apresenta vem de ferramenta. Os analisadores de insight são
funções TypeScript puras que devolvem structs com os valores **já formatados**; o
modelo apenas os organiza em texto.

Expressões de data em português ("ontem", "sexta passada", "dia 5") são resolvidas
por `ai/date-phrases.ts`, não pelo modelo.

**Por quê:** LLM erra aritmética de calendário de forma plausível. Perguntado que
dia foi "sexta passada", ele responde uma data que parece certa — e num lançamento
financeiro uma data errada é pior que nenhuma. O mesmo vale para somas: verificado
na prática, o modelo relatou "77% acima" com os números certos porque as duas
consultas vieram de ferramenta.

Efeito colateral valioso: os insights funcionam **sem chave de API**. Os
analisadores rodam sempre; a narração é um acréscimo.

---

## 13. Autonomia da IA por política explícita, com padrão seguro

`ai/risk.ts` classifica cada ferramenta de escrita: `always_auto`,
`amount_threshold`, `row_threshold` ou `always_confirm`. Uma ferramenta **sem
política declarada** cai em `confirm`.

**Por quê:** a autonomia precisa ser auditável numa tabela que se lê de cima a
baixo, não inferida de heurística espalhada. E o padrão tem que ser o seguro: uma
ferramenta nova que alguém esqueceu de classificar não pode ganhar poder de
escrita por omissão. Há teste que percorre as ferramentas de escrita e falha se
alguma estiver sem política — foi ele que pegou `create_goal` faltando.

Quando cai em `confirm`, a ferramenta **não executa**: devolve um resumo e um
token. Só com o token de volta a operação acontece. Verificado: uma compra de
R$ 2.800 não gravou nada até a confirmação.

---

## 14. `createdBy` vem do autor do change set

Descoberto em teste real contra a API: um lançamento feito pela IA aparecia como
`createdBy: 'user'`. O change set registrava `actor: 'ai'` corretamente, mas a
linha da transação usava o padrão da coluna.

**Por quê importa:** o filtro "o que a IA lançou?" mentiria — exatamente a
pergunta que se faz quando algo parece errado. Corrigido em `insertTransactionIn`,
que agora deriva `createdBy` de `ctx.actor`.

---

## 15. IDs de categoria ficam fora do retrato enviado à IA

O retrato lista as categorias por nome, não por ID.

**Por quê:** as ferramentas resolvem categoria por nome ("Mercado") ou caminho
("Alimentação > Mercado"), então os IDs eram peso morto. Medido: 99 ULIDs de 26
caracteres custavam **1.192 tokens por turno** — 94% do retrato. Removidos, os
tokens de entrada caíram de 27.935 para 15.190 numa mesma conversa (−46%).

---

## 16. Subquery correlacionada em SQL cru é armadilha no Drizzle

O Drizzle renderiza referência de coluna **sem qualificar a tabela** quando a
consulta tem uma única origem. Dentro de uma subquery, esse `"id"` solto passa a
apontar para a tabela interna.

Caso real: a verificação de integridade do rateio virou
`transaction_splits.transaction_id = transaction_splits.id`, que nunca casa — a
soma dava sempre zero e o verificador acusava erro onde não havia. Reescrito com
duas consultas e agregação em memória.

**Regra:** não usar subquery correlacionada com interpolação de coluna do Drizzle.
Ou qualificar explicitamente em SQL cru, ou fazer duas consultas.

---

## 17. Argumento de função não é lazy

`readDb(options, getDb())` avaliava `getDb()` **sempre**, mesmo quando um banco de
teste era passado — abrindo a conexão de produção e criando `data/finance.db` a
partir de teste. O fallback foi movido para dentro de `readDb`.

**Por quê importa:** um teste que toca o banco real pode corromper dados de
verdade. O sintoma era discreto: um arquivo aparecendo em `data/` depois de rodar
`npm test`.

---

## 18. O error handler respeita o status de erros do framework

Erros do Fastify e de plugins já trazem `statusCode`. Sem verificar isso, o
handler transformava o `429` do limitador de tentativas em `500`.

**Por quê importa:** um bloqueio por excesso de tentativas apareceria como falha
do servidor, e quem estivesse depurando procuraria o bug no lugar errado.

---

## 19. Pagamento de fatura vincula só a perna do cartão

`insertTransferIn` aceita `outLinks` e `inLinks` separados. No pagamento de
fatura, apenas a perna que entra no cartão recebe `cardInvoiceId`.

**Por quê:** vincular as duas pernas fazia o pagamento aparecer duas vezes na
fatura. As duas pernas de uma transferência são genuinamente assimétricas, e o
tipo passou a refletir isso.

---

## 20. O frontend reaproveita o protótipo trocando só a camada de dados

O protótipo PC-98 (`Design Systems/PC-98`) foi movido para `web/` com o design
system **intacto**: tokens, gráficos, mascotes, áudio e HTML vieram sem alteração
de estilo. O que mudou foi o `data.ts`, que era um arquivo de dados fictícios e
virou um store alimentado pela API.

O truque é *live binding* do ESM: o store exporta `export let ACCOUNTS`,
`TRANSACTIONS` etc. com **os mesmos nomes** que o protótipo usava, e reatribuí-los
dentro do módulo é visível para quem importou.

**Por quê:** reescrever 1.777 linhas de renderização para consumir uma API teria
alto risco de descaracterizar o visual, que já estava pronto e aprovado. Trocando
apenas a fonte dos dados, o design fica preservado por construção e o diff se
concentra onde o risco é gerenciável.

**Consequência:** `loadAll()` precisa terminar antes de `new KakeiboApp()`, porque
o app copia arrays em inicializadores de campo. É `main.ts` que garante a ordem.

Onde o formato do backend difere do que a interface espera, a conversão fica em
adaptadores no store — nunca espalhada pelas telas.

---

## 21. Proxy do Vite em vez de CORS

Em desenvolvimento o Vite serve a interface na 3000 e faz proxy de `/api` para o
backend na 3333. Em produção o Fastify serve `web/dist` e a API na mesma porta.

**Por quê:** nas duas situações o navegador vê **same-origin**, então o cookie de
sessão viaja normalmente e o backend não precisa de CORS — uma dependência e uma
superfície de configuração a menos. E o modo produção dá um endereço único para
acessar do celular.

O `notFoundHandler` é **um só** (o Fastify não aceita dois na mesma instância):
ele decide entre devolver o index da interface e um 404 em JSON. Caminho com
extensão de arquivo que não existe dá 404 — devolver HTML no lugar de um `.js`
produz o erro "Unexpected token '<'", que não diz nada sobre a causa real.

Path traversal foi testado (`/../.env`, `%2e%2e`, `%5C`, aninhado em `/assets`):
nada vaza. O `@fastify/static` está na versão 10, que corrigiu a falha das 9.x.

---

## 22. Orçamento com rollover mostra o limite efetivo

A tela exibia o limite **base** ao lado do percentual calculado sobre o limite
**efetivo**. Com rollover de −R$ 542,80 num orçamento de R$ 600, um gasto de
R$ 380,30 aparecia como "R$ 380,30 / R$ 600,00 (100%)" — parecendo exatamente no
teto, quando era 665% do que de fato sobrou para o mês.

Agora exibe o limite efetivo, o percentual real (sem travar em 100) e um chip
`[ROLLOVER -R$ 542,80]` explicando de onde veio o ajuste. A barra continua saturando
em 100%, porque uma trilha não preenche mais que isso — mas o texto conta a verdade.

**Por quê importa:** o caso enganoso escondia um problema. Esconder problema é o
pior modo de falhar numa tela de finanças.

---

## 23. Insights vêm dos analisadores ao vivo

A interface consulta `/insights/analyze` (roda os analisadores agora) em vez de
`/insights` (tabela persistida).

**Por quê:** a tabela só tem conteúdo depois de alguém chamar a detecção. Na
primeira abertura o painel aparecia vazio, dando a impressão de que não havia nada
a observar — quando havia nove achados, incluindo duas faturas vencidas.

---

## 24. `chatStream` precisava coletar as confirmações pendentes

O caminho sem streaming extraía as pendências de `result.steps`. O `chatStream`
não coletava nada: o modelo avisava que precisava de confirmação, mas a interface
nunca recebia o token — e o usuário entrava num laço, pedindo uma aprovação que o
sistema não sabia receber.

Corrigido com `onStepFinish`, que inspeciona `needsConfirmation` nos resultados de
ferramenta. Há teste garantindo que o handler continua lá.

---

## 25. Gráfico não mede a própria altura

Os renderers de radar e medidor liam `host.clientHeight` para definir
`canvas.height` e depois aplicavam `style.height: 100%`. Isso fecha um laço de
realimentação: o canvas empurra a altura do container, que na medição seguinte
devolve um valor maior.

No desktop o container tem altura limitada e o laço não fecha. Empilhado no
celular, o gráfico crescia a cada re-render — foi observado em 573px de altura
quando o previsto era 260.

A altura passou a ser derivada da **largura**, por proporção, com piso e teto.
Verificado: seis eventos de resize seguidos e as dimensões não mudam.

---

## 26. Markdown da IA é renderizado, com escape antes

O modelo escreve em markdown por natureza (`**R$ 32,50**`). Mostrar os asteriscos
crus fica amador, então há um renderizador mínimo (negrito, itálico, código,
título, quebra de linha).

O HTML é escapado **antes** de aplicar as marcas: a resposta do modelo é conteúdo
não confiável. Testado com `<script>`, `<img onerror>` e tag dentro de negrito —
tudo sai neutralizado.
