// Aplica as migrations pendentes de supabase/migrations/ no Postgres do cliente.
//
// Cada instalação tem seu próprio Supabase (ver scripts/install.sh:34), então
// migration é responsabilidade de cada instalação — este runner é o que faltava
// para o schema acompanhar o código sozinho em vez de depender do cliente rodar
// SQL manualmente (o que ele nem tem autorização de saber fazer).
//
// A lógica pura (descoberta, ordenação, checksum, conjunto pendente, divergência,
// baseline) não toca banco nem processo — é testável por import direto. Tudo que
// fala com o Postgres fica abaixo do bloco "camada de banco" e é uma casca fina
// sobre essas funções.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(__dirname, "../supabase/migrations");

// Chave arbitrária fixa: só precisa ser a mesma em todas as execuções do runner
// para que pg_advisory_lock sirva de mutex entre updates simultâneos.
const ADVISORY_LOCK_KEY = 8291734;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_INTERVAL_MS = 500;

const MIGRATION_FILENAME_RE = /^(\d{3})_.+\.sql$/;

// ---------------------------------------------------------------------------
// Lógica pura — sem fs além do necessário para ler o próprio arquivo, sem rede,
// sem banco. Testável por import direto.
// ---------------------------------------------------------------------------

/** Extrai o prefixo numérico de um nome de migration, ou null se não casar. */
export function parseMigrationFilename(filename) {
  const match = MIGRATION_FILENAME_RE.exec(filename);
  if (!match) return null;
  return { filename, prefix: Number(match[1]) };
}

/**
 * Ordena pelo prefixo numérico (010 vem depois de 009, não entre 001 e 002 como
 * aconteceria numa ordenação alfabética de string). Lança erro nomeando o
 * primeiro arquivo fora do padrão `NNN_descricao.sql` — silenciar seria pior
 * que falhar, porque um arquivo mal nomeado nunca seria aplicado e ninguém
 * notaria.
 */
export function sortAndValidateMigrationFilenames(filenames) {
  const parsed = filenames.map((filename) => {
    const info = parseMigrationFilename(filename);
    if (!info) {
      throw new Error(
        `Arquivo de migration fora do padrão esperado (NNN_descricao.sql): ${filename}`,
      );
    }
    return info;
  });
  parsed.sort(
    (a, b) => a.prefix - b.prefix || a.filename.localeCompare(b.filename),
  );
  return parsed.map((info) => info.filename);
}

/** sha256 do conteúdo em bytes, hexadecimal. */
export function computeChecksum(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Dado o conjunto de arquivos atuais (em ordem, com checksum) e os registros já
 * aplicados no banco, separa o que está pendente do que diverge — um arquivo já
 * aplicado cujo conteúdo mudou desde então. Divergência é sinal de que a
 * migration aplicada foi editada depois; continuar produziria schema
 * imprevisível, então quem chama esta função deve abortar ao ver `divergent`
 * não vazio, sem tentar aplicar nada.
 */
export function computePendingSet(orderedFiles, appliedRecords) {
  const appliedChecksumByFilename = new Map(
    appliedRecords.map((record) => [record.filename, record.checksum]),
  );
  const pending = [];
  const divergent = [];
  for (const file of orderedFiles) {
    const appliedChecksum = appliedChecksumByFilename.get(file.filename);
    if (appliedChecksum === undefined) {
      pending.push(file.filename);
    } else if (appliedChecksum !== file.checksum) {
      divergent.push({
        filename: file.filename,
        expected: appliedChecksum,
        actual: file.checksum,
      });
    }
  }
  return { pending, divergent };
}

/**
 * Todas as migrations com prefixo <= baselineNNN, na mesma ordem numérica —
 * o conjunto que `--baseline NNN` registra como aplicado sem executar.
 */
export function resolveBaselineSet(orderedFilenames, baselineNNN) {
  return orderedFilenames.filter((filename) => {
    const info = parseMigrationFilename(filename);
    return info !== null && info.prefix <= baselineNNN;
  });
}

// Nomes de tabela criados por supabase/migrations/001_initial_schema.sql,
// específicos o bastante para não colidir com nada que um projeto Supabase
// zerado possa pré-criar em `public` por conta de uma extensão habilitada
// (ex.: PostGIS cria `spatial_ref_sys`) — por isso a checagem abaixo é "essas
// tabelas de aplicação existem", nunca "o schema public não está vazio", que
// daria falso positivo num projeto genuinamente zerado.
export const APPLICATION_TABLE_PROBE = [
  "contacts",
  "conversations",
  "messages",
  "profiles",
  "tags",
];

/**
 * Decide se o runner deve recusar rodar contra um banco que já tem schema de
 * aplicação, mas nenhum registro em `schema_migrations` (nem baseline sendo
 * feito agora) — é exatamente o cenário em que `pending` seria `001..050`
 * inteiro e o runner tentaria recriar/reprocessar tabelas que já têm dados
 * reais, incluindo os `DELETE`/`DROP` de migrations como `022` e `043`.
 *
 * Só recusa quando as três condições valem ao mesmo tempo:
 *   - `appliedRecordsCount === 0`: schema_migrations está vazia (banco nunca
 *     rodou o runner, ou rodou e não tem nada — mesma situação de risco).
 *   - `baselineRequested` é falso: se `--baseline` foi passado, é
 *     exatamente o comando que resolve esse caso — deixa passar.
 *   - `applicationTableCount > 0`: existe pelo menos uma das tabelas de
 *     `APPLICATION_TABLE_PROBE` em `public` — sinal de schema de aplicação
 *     já presente, aplicado por fora do runner.
 *
 * Lógica pura, sem tocar banco — o `count(*)` que alimenta
 * `applicationTableCount` é responsabilidade de quem chama (camada de
 * banco, abaixo).
 */
export function shouldRefuseUnbaselinedExistingSchema({
  appliedRecordsCount,
  baselineRequested,
  applicationTableCount,
}) {
  if (baselineRequested) return false;
  if (appliedRecordsCount > 0) return false;
  return applicationTableCount > 0;
}

/** Lê supabase/migrations/*.sql do disco, ordenado e validado. */
export function discoverMigrationFiles(dir) {
  const filenames = readdirSync(dir).filter((name) => name.endsWith(".sql"));
  return sortAndValidateMigrationFilenames(filenames);
}

/** Lê um arquivo de migration e calcula seu checksum. Conteúdo em bytes (Buffer). */
export function readMigrationFile(dir, filename) {
  const content = readFileSync(resolve(dir, filename));
  return { filename, content, checksum: computeChecksum(content) };
}

// ---------------------------------------------------------------------------
// Camada de banco — casca fina sobre a lógica pura acima.
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Monta a config TLS da conexão. Verificação de certificado fica sempre ligada
 * — não existe flag nem env var para desligar. Esta conexão carrega credencial
 * de superusuário do banco e executa DDL: aceitar certificado não verificado
 * permitiria que um atacante em posição de rede se passasse pelo banco do
 * cliente, capturasse a senha e injetasse SQL arbitrário na atualização.
 * SUPABASE_DB_CA_PATH existe só para instalações onde a CA própria do Supabase
 * não resolve pelo trust store do sistema — o caminho é fornecer a CA correta,
 * nunca ignorar a verificação.
 */
function buildSslConfig() {
  const config = { rejectUnauthorized: true };
  const caPath = process.env.SUPABASE_DB_CA_PATH;
  if (caPath) {
    config.ca = readFileSync(caPath, "utf8");
  }
  return config;
}

function isTlsError(err) {
  const code = err?.code ?? "";
  const message = err?.message ?? "";
  return (
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "CERT_HAS_EXPIRED" ||
    /certificate/i.test(message)
  );
}

// sslmode que desligam ou enfraquecem a verificação de certificado de propósito
// (não são "modo estrito não pedido", são pedido explícito de downgrade) — a
// única resposta aceitável é abortar, nunca seguir em frente calado.
const REJECTED_SSLMODES = new Set(["disable", "no-verify"]);

// Todo parâmetro que o pg-connection-string usa para decidir sozinho o valor de
// `config.ssl` (ver node_modules/pg-connection-string/index.js:74). O ponto
// crítico: `pg.Client` faz `Object.assign({}, config, parse(connectionString))`
// (node_modules/pg/lib/connection-parameters.js:59) — ou seja, o que a URL diz
// GANHA do objeto `ssl` explícito que passamos no construtor. Uma
// `SUPABASE_DB_URL` com `?sslmode=require` colada direto do painel do Supabase
// silenciosamente zera nosso `ssl: { rejectUnauthorized: true, ca: ... }` e
// troca por `ssl: {}` (descartando o CA de SUPABASE_DB_CA_PATH); com
// `?sslmode=disable` a conexão vira texto claro. Nenhum desses parâmetros pode
// sobreviver na connection string que chega ao pg — removê-los é a única forma
// de garantir que o `ssl` que construímos é o que de fato é usado.
const SSL_RELATED_PARAMS = [
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslpassword",
  "sslnegotiation",
  "ssl",
  "uselibpqcompat",
];

/**
 * Valida e limpa a connection string de parâmetros ssl* antes de entregá-la ao
 * `pg.Client`, para que o `ssl` explícito (rejectUnauthorized: true, + CA de
 * SUPABASE_DB_CA_PATH) seja sempre o que vale — nunca o que a URL diz.
 *
 * - `sslmode=disable` / `sslmode=no-verify` são pedidos explícitos de
 *   downgrade: aborta com erro em vez de neutralizar em silêncio.
 * - Qualquer outro parâmetro ssl* (incluindo `sslmode=require`, comum em
 *   strings coladas do painel do Supabase) é removido da URL. `removedParams`
 *   no retorno serve só para o runner poder avisar o operador do que ignorou.
 */
export function sanitizeConnectionString(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch (err) {
    throw new Error(
      `SUPABASE_DB_URL não é uma connection string válida (formato esperado: postgres://usuario:senha@host:porta/banco). Detalhe: ${err.message}`,
    );
  }

  const sslmode = url.searchParams.get("sslmode");
  if (sslmode && REJECTED_SSLMODES.has(sslmode)) {
    throw new Error(
      `SUPABASE_DB_URL contém sslmode=${sslmode}, que desliga ou desativa a verificação de certificado TLS. Este runner exige verificação de certificado sempre ligada (rejectUnauthorized: true) e não aceita esse parâmetro — remova sslmode da connection string. O runner já configura TLS verificado por conta própria; para CA própria use a variável SUPABASE_DB_CA_PATH.`,
    );
  }

  const removedParams = [];
  for (const param of SSL_RELATED_PARAMS) {
    if (url.searchParams.has(param)) {
      url.searchParams.delete(param);
      removedParams.push(param);
    }
  }

  return { connectionString: url.toString(), removedParams };
}

/**
 * Adquire pg_advisory_lock por polling (pg_try_advisory_lock a cada 500ms) até
 * 30s. Impede que duas execuções simultâneas do update.sh apliquem a mesma
 * migration duas vezes. O lock é de sessão: precisa ser adquirido e liberado na
 * mesma conexão (por isso o runner usa um Client único, nunca um Pool).
 */
async function acquireAdvisoryLock(client) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    const { rows } = await client.query(
      "select pg_try_advisory_lock($1) as locked",
      [ADVISORY_LOCK_KEY],
    );
    if (rows[0].locked) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Não foi possível obter o lock de migration (pg_advisory_lock ${ADVISORY_LOCK_KEY}) em ${LOCK_TIMEOUT_MS / 1000}s. Outra execução do runner provavelmente está em andamento — aguarde ela terminar e tente de novo.`,
      );
    }
    await sleep(LOCK_POLL_INTERVAL_MS);
  }
}

async function releaseAdvisoryLock(client) {
  await client
    .query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY])
    .catch(() => {});
}

async function ensureMigrationsTable(client) {
  await client.query(`
    create table if not exists public.schema_migrations (
      filename   text primary key,
      checksum   text not null,
      applied_at timestamptz not null default now()
    );
  `);
}

async function fetchAppliedRecords(client) {
  const { rows } = await client.query(
    "select filename, checksum from public.schema_migrations",
  );
  return rows;
}

/**
 * Conta quantas das tabelas de `APPLICATION_TABLE_PROBE` já existem em
 * `public`. Usa `pg_class`/`pg_namespace` (não `to_regclass`, que resolve
 * pelo `search_path`) para que uma tabela de mesmo nome em outro schema no
 * search_path do usuário de conexão não possa satisfazer a checagem —
 * queremos saber especificamente sobre `public`, o schema onde este runner
 * cria e altera objetos.
 */
async function countApplicationTables(client) {
  const { rows } = await client.query(
    `select count(*) as n
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r'
       and n.nspname = 'public'
       and c.relname = any($1::text[])`,
    [APPLICATION_TABLE_PROBE],
  );
  return Number(rows[0].n);
}

function parseArgs(argv) {
  const args = { dryRun: false, baseline: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--baseline") {
      const value = argv[++i];
      if (!value || !/^\d{1,3}$/.test(value)) {
        throw new Error(
          "--baseline requer um número de até 3 dígitos, ex: --baseline 043",
        );
      }
      args.baseline = Number(value);
    } else {
      throw new Error(`Argumento desconhecido: ${arg}`);
    }
  }
  if (args.dryRun && args.baseline !== undefined) {
    throw new Error("--dry-run e --baseline não podem ser usados juntos.");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error(
      "[migrate] SUPABASE_DB_URL não definida. Copie a connection string direta do Postgres em Supabase → Project Settings → Database → Connection string (não são as chaves NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, que falam com a API PostgREST e não executam DDL).",
    );
    process.exitCode = 1;
    return;
  }

  const files = discoverMigrationFiles(MIGRATIONS_DIR);
  const filesWithChecksum = files.map((filename) =>
    readMigrationFile(MIGRATIONS_DIR, filename),
  );

  let sanitized;
  try {
    sanitized = sanitizeConnectionString(dbUrl);
  } catch (err) {
    console.error(`[migrate] ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (sanitized.removedParams.length > 0) {
    console.log(
      `[migrate] ignorando parâmetro(s) de TLS na connection string (${sanitized.removedParams.join(", ")}) — o runner usa sua própria configuração de TLS verificado, veja SUPABASE_DB_CA_PATH se precisar de uma CA própria.`,
    );
  }

  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: sanitized.connectionString,
    ssl: buildSslConfig(),
  });

  try {
    await client.connect();
  } catch (err) {
    if (isTlsError(err)) {
      console.error(
        `[migrate] Falha na verificação do certificado TLS do banco. Baixe o certificado CA em Supabase → Project Settings → Database → SSL Configuration e aponte SUPABASE_DB_CA_PATH para o arquivo baixado. Detalhe: ${err.message}`,
      );
    } else {
      console.error(
        `[migrate] Falha ao conectar usando SUPABASE_DB_URL: ${err.message}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  try {
    await acquireAdvisoryLock(client);
    await ensureMigrationsTable(client);
    const appliedRecords = await fetchAppliedRecords(client);

    // Guarda de segurança: schema_migrations vazia (nunca rodou o runner) e
    // nenhum --baseline pedido agora é exatamente a situação em que uma
    // instalação com schema aplicado à mão (VPS de produção, cópia do
    // notebook, ou qualquer clone anterior a este runner) faria `pending`
    // virar 001..050 inteiro — reaplicando `create table` em objetos que já
    // existem e rodando de novo os `DELETE`/`DROP` de migrations como 022 e
    // 043 em cima de dados reais. Só entra em cena quando appliedRecords já
    // está vazia, então custa uma query extra apenas nesse caminho raro, não
    // em toda execução normal do runner.
    if (appliedRecords.length === 0 && args.baseline === undefined) {
      const applicationTableCount = await countApplicationTables(client);
      if (
        shouldRefuseUnbaselinedExistingSchema({
          appliedRecordsCount: appliedRecords.length,
          baselineRequested: args.baseline !== undefined,
          applicationTableCount,
        })
      ) {
        console.error(
          `[migrate] Este banco já tem tabelas de aplicação (${APPLICATION_TABLE_PROBE.join(", ")} — ` +
            "verificação encontrou ao menos uma) mas não tem a tabela de controle " +
            "public.schema_migrations preenchida. Isso indica uma instalação com " +
            "schema aplicado manualmente, de antes deste runner existir. Aplicar " +
            "001 em diante do zero seria destrutivo: recriaria tabelas existentes " +
            "e reexecutaria DELETE/DROP de migrations antigas em cima de dados " +
            "reais. Rode primeiro, com backup feito e o número certo confirmado " +
            "(ver README.md, seção \"Instalações com schema aplicado à mão " +
            '(--baseline)"):\n' +
            "  SUPABASE_DB_URL=... node scripts/migrate.mjs --baseline NNN\n" +
            "e só depois rode este comando de novo sem --baseline.",
        );
        process.exitCode = 1;
        return;
      }
    }

    if (args.baseline !== undefined) {
      if (appliedRecords.length > 0) {
        console.error(
          "[migrate] --baseline só funciona com a tabela schema_migrations vazia. Esta instalação já tem registros — rode sem flags para aplicar o que estiver pendente.",
        );
        process.exitCode = 1;
        return;
      }
      const baselineFilenames = resolveBaselineSet(files, args.baseline);
      // Uma transação só para o baseline inteiro: se a conexão cair no meio do
      // registro (ex.: arquivo 30 de 43), sem transação a tabela ficaria com 29
      // linhas — não mais vazia, então --baseline nunca mais rodaria (checagem
      // acima), e uma execução normal tentaria reaplicar 030..043 num schema
      // que já os tem, exatamente o cenário que a flag existe para evitar. Com
      // rollback em caso de erro, a tabela volta a ficar vazia e --baseline
      // pode ser tentado de novo.
      try {
        await client.query("begin");
        for (const filename of baselineFilenames) {
          const file = filesWithChecksum.find((f) => f.filename === filename);
          await client.query(
            "insert into public.schema_migrations (filename, checksum) values ($1, $2)",
            [file.filename, file.checksum],
          );
          console.log(`[migrate] baseline: ${file.filename}`);
        }
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        console.error(
          `[migrate] Falha ao registrar baseline: ${err.message}. Nada foi gravado (rollback) — schema_migrations continua vazia, pode tentar de novo.`,
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        `[migrate] baseline concluído: ${baselineFilenames.length} migration(ões) registrada(s) sem execução.`,
      );
      return;
    }

    const { pending, divergent } = computePendingSet(
      filesWithChecksum,
      appliedRecords,
    );

    if (divergent.length > 0) {
      const names = divergent.map((d) => d.filename).join(", ");
      console.error(
        `[migrate] Checksum divergente para migration(ões) já aplicada(s): ${names}. O arquivo foi editado depois de aplicado — continuar produziria um schema imprevisível. Corrija o arquivo (ou reverta a edição) antes de rodar de novo.`,
      );
      process.exitCode = 1;
      return;
    }

    if (pending.length === 0) {
      console.log("[migrate] Nada pendente — o banco já está atualizado.");
      return;
    }

    if (args.dryRun) {
      console.log(
        `[migrate] --dry-run: ${pending.length} migration(ões) seriam aplicadas:`,
      );
      for (const filename of pending) console.log(`  ${filename}`);
      return;
    }

    let appliedCount = 0;
    for (const filename of pending) {
      const file = filesWithChecksum.find((f) => f.filename === filename);
      try {
        await client.query("begin");
        await client.query(file.content.toString("utf8"));
        await client.query(
          "insert into public.schema_migrations (filename, checksum) values ($1, $2)",
          [file.filename, file.checksum],
        );
        await client.query("commit");
        appliedCount++;
        console.log(`[migrate] aplicada: ${file.filename}`);
      } catch (err) {
        await client.query("rollback").catch(() => {});
        console.error(
          `[migrate] Falha ao aplicar ${file.filename}: ${err.message}. Interrompido sem tentar as migrations seguintes.`,
        );
        process.exitCode = 1;
        return;
      }
    }
    console.log(
      `[migrate] concluído: ${appliedCount} migration(ões) aplicada(s).`,
    );
  } finally {
    await releaseAdvisoryLock(client);
    await client.end().catch(() => {});
  }
}

// Só executa o CLI quando chamado diretamente (`node scripts/migrate.mjs`).
// Importar o módulo para testar a lógica pura não deve abrir conexão nenhuma.
const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error(`[migrate] Erro fatal: ${err.message}`);
    process.exitCode = 1;
  });
}
