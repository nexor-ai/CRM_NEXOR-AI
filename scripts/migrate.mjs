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

  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: dbUrl,
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

    if (args.baseline !== undefined) {
      if (appliedRecords.length > 0) {
        console.error(
          "[migrate] --baseline só funciona com a tabela schema_migrations vazia. Esta instalação já tem registros — rode sem flags para aplicar o que estiver pendente.",
        );
        process.exitCode = 1;
        return;
      }
      const baselineFilenames = resolveBaselineSet(files, args.baseline);
      for (const filename of baselineFilenames) {
        const file = filesWithChecksum.find((f) => f.filename === filename);
        await client.query(
          "insert into public.schema_migrations (filename, checksum) values ($1, $2)",
          [file.filename, file.checksum],
        );
        console.log(`[migrate] baseline: ${file.filename}`);
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
