# Runner de Migrations para Clones — Plano de Implementação

Complementa `2026-07-27-canal-atualizacao-clones-plano.md`. Aquele plano entregou o
canal que avisa e troca o código. Este entrega a parte que falta: **o banco do
cliente acompanhar o código**, sem intervenção manual.

## Problema

`scripts/update.sh:150` apenas imprime "aplique as migrations no Supabase". O cliente
não tem autorização nem conhecimento para fazer isso. Resultado: atualiza o código,
o código novo espera schema novo, o CRM quebra e o cliente liga para o Anderson.

As migrations `044→050` já estão nessa situação — a primeira distribuição cai nela.

## Arquitetura assumida (confirmada em `scripts/install.sh:34`)

**Um banco Supabase por cliente.** Cada instalação preenche o próprio `.env` com as
credenciais do Supabase dela. Logo, migration é por instalação, e é isso que precisa
ser automatizado.

## Restrições Globais

- Node `>=20.0.0`. Runner em ESM (`.mjs`), mesmo padrão de `scripts/build.mjs`.
- Todo texto de saída em **português do Brasil**.
- Testes com **Vitest** (`npm run test`), arquivos `*.test.*` ao lado do código.
- Nunca commitar `.env`. Apenas `.env.local.example` é versionado.
- **Não rodar migration contra banco de produção durante o desenvolvimento.**
  A pasta é produção (`wacrm.service` na porta 3010). Nenhuma task deste plano
  executa o runner contra o Supabase real.
- `npm ci` em `install.sh:46` e `update.sh:138` instala devDependencies também,
  então `pg` pode entrar em `dependencies` sem risco de faltar.
- Todas as 50 migrations foram verificadas: **nenhuma** usa `CONCURRENTLY` e
  **nenhuma** abre transação própria (`BEGIN`/`COMMIT`). Portanto cada arquivo pode
  ser aplicado dentro de uma transação, sem exceções a tratar.
- Nenhuma tabela de controle de migrations existe hoje no schema.

---

### Task 1: `scripts/migrate.mjs` — o runner

Criar o aplicador de migrations e cobrir com testes unitários.

**Dependência nova:** `pg` (node-postgres) em `dependencies` do `package.json`.

**Variável de ambiente nova:** `SUPABASE_DB_URL` — string de conexão direta do
Postgres (Supabase → Project Settings → Database → Connection string). As chaves
atuais (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) falam com a API
PostgREST, que não executa DDL. Por isso a variável é nova e não reaproveitável.

**TLS: verificação de certificado sempre ligada.** `ssl: { rejectUnauthorized:
true }`, sem exceção e sem flag para desligar. Esta conexão carrega credencial de
superusuário do banco e executa DDL: aceitar certificado não verificado permitiria
que um atacante em posição de rede se passasse pelo banco do cliente, capturasse a
senha e injetasse SQL arbitrário na atualização.

A conexão direta do Supabase usa CA própria. Para instalações onde a cadeia não
resolve pelo trust store do sistema, aceitar `SUPABASE_DB_CA_PATH` apontando para
o arquivo de CA baixado do painel do Supabase, carregado em `ssl.ca`. Quando o
handshake TLS falhar, a mensagem de erro deve nomear essa variável e dizer onde
baixar o certificado — o caminho de saída é fornecer o CA correto, nunca ignorar
a verificação.

**Tabela de controle**, criada pelo próprio runner:

```sql
create table if not exists public.schema_migrations (
  filename   text primary key,
  checksum   text not null,
  applied_at timestamptz not null default now()
);
```

**Comportamento:**

1. Adquirir `pg_advisory_lock(8291734)` antes de qualquer coisa e liberar no fim.
   Impede que duas execuções simultâneas do `update.sh` apliquem a mesma migration
   duas vezes. Se o lock não vier em 30s, abortar com mensagem clara.
2. Criar a tabela de controle se não existir.
3. Descobrir os arquivos em `supabase/migrations/*.sql`. Ordenar pelo **prefixo
   numérico** (`NNN_`), não por ordenação alfabética de string. Arquivo que não
   casar com `^\d{3}_.*\.sql$` aborta a execução com erro nomeando o arquivo —
   silenciar seria pior que falhar.
4. Para cada arquivo **já registrado**: conferir o checksum. Divergência aborta
   tudo, nomeando o arquivo. Significa que uma migration já aplicada foi editada
   depois — cenário em que continuar produz schema imprevisível.
5. Para cada arquivo **pendente**, em ordem: abrir transação, executar o SQL,
   inserir o registro em `schema_migrations` **dentro da mesma transação**,
   commitar. Falha faz rollback daquela migration e encerra o processo com código
   diferente de zero, sem tentar as seguintes.
6. Checksum é `sha256` do conteúdo em bytes, hexadecimal.

**Flags de linha de comando:**

- `--dry-run` — lista o que seria aplicado, não aplica, sai com 0.
- `--baseline NNN` — registra como aplicadas, **sem executar**, todas as migrations
  com prefixo `<= NNN`. Só funciona com a tabela de controle vazia; caso contrário
  aborta. Existe porque instalações atuais (a VPS do Anderson, a cópia do notebook)
  já têm o schema `043` aplicado à mão e nenhuma tabela de controle — sem baseline,
  o runner tentaria reaplicar `001→043` e destruiria a instalação.
- Sem flags: aplica o que estiver pendente.

**Saída:** uma linha por migration aplicada, e um resumo final com a contagem.
Quando não há nada pendente, dizer isso explicitamente e sair com 0.

**Testes (Vitest):** cobrir a lógica pura, sem banco — descoberta e ordenação de
arquivos (incluindo o caso `010` vir depois de `009` e não entre `001` e `002`),
rejeição de nome fora do padrão, cálculo de checksum, cálculo do conjunto pendente
dado um conjunto já aplicado, detecção de divergência de checksum, e resolução do
conjunto de baseline dado um `NNN`. Estruturar o módulo de forma que essas funções
sejam exportáveis e testáveis sem conexão.

**Fora de escopo:** teste de integração contra Postgres real. Depende de Docker,
indisponível na máquina atual. Fica registrado como portão de validação para o
Anderson rodar no notebook (ver "Validação pendente" no fim deste plano).

---

### Task 2: Ligar o runner no `scripts/update.sh`

Duas mudanças, uma delas corrigindo contradição com o requisito do produto.

**2a. Remover o bloqueio por alteração local.** `update.sh:41-46` hoje aborta a
atualização se o cliente tiver modificado qualquer arquivo versionado. O requisito
do produto é o oposto: o cliente **não tem autorização de modificar o código**, e
toda modificação dele deve ser sobrescrita para o padrão voltar. Com o guard atual,
um cliente que encostar num arquivo trava e nunca mais atualiza — o `checkout
--force` da linha 137, que já faz a sobrescrita correta, nunca é alcançado.

Trocar o `exit 1` por um aviso: listar o que será sobrescrito e prosseguir. Manter
o `git status --short` na saída, agora como registro do que se perdeu, não como
motivo de parada. Não adicionar `git clean`: apagaria `.env` e `backups/`, que são
arquivos não versionados e legítimos da instalação do cliente.

**2b. Inserir a etapa de migrations.** Hoje a etapa 3 (`update.sh:69`) calcula
`NEW_MIGRATIONS` e a etapa final (`:150`) só imprime um aviso. Substituir o aviso
pela execução real, posicionada **depois** de `npm ci` e **antes** de `npm run
build` e do restart — o código novo não pode subir contra schema velho.

Falha do runner entra no caminho de `rollback` que já existe (`update.sh:96`),
voltando o código para `$PREVIOUS_SHA`. A mensagem de erro precisa dizer com todas
as letras que **o código voltou mas o banco não**, porque rollback de código não
desfaz DDL, e o operador precisa saber disso para agir.

Se `SUPABASE_DB_URL` não estiver definida e houver migrations pendentes, abortar
antes de tocar em qualquer coisa, explicando qual variável falta e onde obtê-la.

---

### Task 3: Instalação limpa e documentação

**3a. `scripts/install.sh`:** após o `npm ci` (`:46`) e antes do `npm run build`
(`:48`), executar o runner para aplicar `001→050` num banco zerado. Como o
`install.sh` só chega nesse ponto quando o `.env` já foi preenchido, a variável
`SUPABASE_DB_URL` deve ser validada ali, com mensagem clara se faltar.

**3b. `.env.local.example`:** acrescentar `SUPABASE_DB_URL` com comentário
explicando de onde tirar o valor no painel do Supabase e por que ela é diferente
das chaves de API já presentes.

**3c. `README.md`:** documentar na seção de instalação a variável nova; e, na seção
de atualização, registrar que migrations agora são aplicadas automaticamente. Incluir
o procedimento de `--baseline` para instalações que já existem com schema aplicado à
mão — é o caso da VPS de produção e da cópia do notebook, e sem isso ambas quebram
na primeira execução do runner.

---

## Validação pendente (portão do Anderson, fora deste plano)

O runner não pode ser exercitado contra Postgres real nesta máquina: Docker
indisponível, e a pasta é produção. Antes de distribuir, precisa rodar no notebook:

1. `scripts/migration-check/run.sh` adaptado para aplicar via runner em vez do laço
   de `psql`, provando que `001→050` sobem limpas num banco zerado.
2. Um teste de `--baseline 043` seguido de aplicação de `044→050`, que é exatamente
   o caminho que a VPS de produção vai percorrer.
