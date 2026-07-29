// Testa a lógica pura de scripts/migrate.mjs (runner de migrations dos clones).
//
// O arquivo mora aqui, não ao lado de scripts/migrate.mjs, porque vitest.config.ts
// só coleta `src/**/*.test.ts(x)` (ver `include`) — um `scripts/migrate.test.mjs`
// nunca seria descoberto por `npm run test`. Import relativo para o .mjs real:
// nenhuma lógica é duplicada, isto testa o módulo que o runner de fato usa.
import { describe, expect, it } from "vitest";
import pg from "pg";
import {
  computeChecksum,
  computePendingSet,
  parseArgs,
  parseMigrationFilename,
  resolveBaselineSet,
  resolveForceChecksumUpdates,
  sanitizeConnectionString,
  shouldRefuseUnbaselinedExistingSchema,
  sortAndValidateMigrationFilenames,
} from "../../scripts/migrate.mjs";

describe("parseMigrationFilename", () => {
  it("extrai o prefixo numérico de um nome válido", () => {
    expect(parseMigrationFilename("001_initial_schema.sql")).toEqual({
      filename: "001_initial_schema.sql",
      prefix: 1,
    });
    expect(parseMigrationFilename("050_manual_assisted_channels.sql")).toEqual({
      filename: "050_manual_assisted_channels.sql",
      prefix: 50,
    });
  });

  it("retorna null para nomes fora do padrão", () => {
    expect(parseMigrationFilename("initial_schema.sql")).toBeNull();
    expect(parseMigrationFilename("1_schema.sql")).toBeNull();
    expect(parseMigrationFilename("001-schema.sql")).toBeNull();
    expect(parseMigrationFilename("001_schema.SQL")).toBeNull();
    expect(parseMigrationFilename("001_schema.txt")).toBeNull();
  });
});

describe("sortAndValidateMigrationFilenames", () => {
  it("ordena pelo prefixo numérico, não alfabeticamente", () => {
    const input = [
      "010_tenth.sql",
      "002_second.sql",
      "001_first.sql",
      "009_ninth.sql",
    ];
    // Numa ordenação alfabética de string, "010" viria entre "001" e "002".
    expect(sortAndValidateMigrationFilenames(input)).toEqual([
      "001_first.sql",
      "002_second.sql",
      "009_ninth.sql",
      "010_tenth.sql",
    ]);
  });

  it("lida com todo o intervalo real 001..050 sem intercalar mal os prefixos", () => {
    const input = Array.from({ length: 50 }, (_, i) => {
      const n = String(i + 1).padStart(3, "0");
      return `${n}_migration.sql`;
    }).reverse();
    const sorted = sortAndValidateMigrationFilenames(input);
    expect(sorted[0]).toBe("001_migration.sql");
    expect(sorted[8]).toBe("009_migration.sql");
    expect(sorted[9]).toBe("010_migration.sql");
    expect(sorted[49]).toBe("050_migration.sql");
  });

  it("lança erro nomeando o arquivo fora do padrão, sem silenciar", () => {
    expect(() =>
      sortAndValidateMigrationFilenames([
        "001_first.sql",
        "not-a-migration.sql",
      ]),
    ).toThrowError(/not-a-migration\.sql/);
  });
});

describe("computeChecksum", () => {
  it("é determinístico e sensível ao conteúdo em bytes", () => {
    const a = computeChecksum(Buffer.from("select 1;"));
    const b = computeChecksum(Buffer.from("select 1;"));
    const c = computeChecksum(Buffer.from("select 2;"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("computePendingSet", () => {
  const orderedFiles = [
    { filename: "001_a.sql", checksum: "checksum-a" },
    { filename: "002_b.sql", checksum: "checksum-b" },
    { filename: "003_c.sql", checksum: "checksum-c" },
  ];

  it("marca como pendente tudo que não está nos registros aplicados", () => {
    const { pending, divergent } = computePendingSet(orderedFiles, []);
    expect(pending).toEqual(["001_a.sql", "002_b.sql", "003_c.sql"]);
    expect(divergent).toEqual([]);
  });

  it("exclui do pendente o que já foi aplicado com o mesmo checksum", () => {
    const { pending, divergent } = computePendingSet(orderedFiles, [
      { filename: "001_a.sql", checksum: "checksum-a" },
    ]);
    expect(pending).toEqual(["002_b.sql", "003_c.sql"]);
    expect(divergent).toEqual([]);
  });

  it("detecta divergência de checksum num arquivo já aplicado", () => {
    const { pending, divergent } = computePendingSet(orderedFiles, [
      { filename: "002_b.sql", checksum: "checksum-editada-depois" },
    ]);
    expect(divergent).toEqual([
      {
        filename: "002_b.sql",
        expected: "checksum-editada-depois",
        actual: "checksum-b",
      },
    ]);
    // O divergente não deve aparecer como pendente — quem chama aborta antes
    // de olhar para `pending` quando `divergent` não está vazio.
    expect(pending).toEqual(["001_a.sql", "003_c.sql"]);
  });

  it("não reporta nada quando tudo já está aplicado e íntegro", () => {
    const { pending, divergent } = computePendingSet(
      orderedFiles,
      orderedFiles.map((f) => ({ filename: f.filename, checksum: f.checksum })),
    );
    expect(pending).toEqual([]);
    expect(divergent).toEqual([]);
  });
});

describe("resolveBaselineSet", () => {
  const files = [
    "001_a.sql",
    "002_b.sql",
    "009_c.sql",
    "010_d.sql",
    "043_e.sql",
    "050_f.sql",
  ];

  it("inclui apenas prefixos <= NNN", () => {
    expect(resolveBaselineSet(files, 43)).toEqual([
      "001_a.sql",
      "002_b.sql",
      "009_c.sql",
      "010_d.sql",
      "043_e.sql",
    ]);
  });

  it("cobre o caso real do plano: baseline 043 exclui 044+", () => {
    const result = resolveBaselineSet(files, 43);
    expect(result).not.toContain("050_f.sql");
  });

  it("com NNN 0 não inclui nada, e com NNN alto inclui tudo", () => {
    expect(resolveBaselineSet(files, 0)).toEqual([]);
    expect(resolveBaselineSet(files, 999)).toEqual(files);
  });
});

describe("shouldRefuseUnbaselinedExistingSchema", () => {
  // Guarda que impede o runner de rodar 001..050 do zero contra um banco que
  // já tem schema de aplicação aplicado à mão (VPS de produção, cópia do
  // notebook), o que reexecutaria DELETE/DROP de migrations antigas em cima
  // de dados reais. Estes testes cobrem a decisão pura; a query real
  // (pg_class/pg_namespace) mora em scripts/migrate.mjs e não é testável sem
  // banco — se a guarda for removida ou a condição enfraquecida, estes casos
  // falham.

  it("recusa: schema_migrations vazia, sem --baseline, com tabelas de aplicação presentes", () => {
    expect(
      shouldRefuseUnbaselinedExistingSchema({
        appliedRecordsCount: 0,
        baselineRequested: false,
        applicationTableCount: 1,
      }),
    ).toBe(true);
  });

  it("segue: schema_migrations vazia, sem --baseline, mas nenhuma tabela de aplicação (banco genuinamente zerado)", () => {
    expect(
      shouldRefuseUnbaselinedExistingSchema({
        appliedRecordsCount: 0,
        baselineRequested: false,
        applicationTableCount: 0,
      }),
    ).toBe(false);
  });

  it("segue: schema_migrations vazia, mas --baseline foi pedido agora (é o comando que resolve o caso)", () => {
    expect(
      shouldRefuseUnbaselinedExistingSchema({
        appliedRecordsCount: 0,
        baselineRequested: true,
        applicationTableCount: 5,
      }),
    ).toBe(false);
  });

  it("segue: schema_migrations já tem registros (runner já rodou nesta instalação antes)", () => {
    expect(
      shouldRefuseUnbaselinedExistingSchema({
        appliedRecordsCount: 43,
        baselineRequested: false,
        applicationTableCount: 5,
      }),
    ).toBe(false);
  });
});

describe("resolveForceChecksumUpdates", () => {
  // Válvula de escape para uma instalação travada por divergência de checksum
  // depois que uma migration já distribuída foi editada (README: "nunca edite
  // uma migration já publicada"; quando acontece mesmo assim, isto é o que
  // destrava sem exigir SQL manual do cliente).
  const orderedFiles = [
    { filename: "001_a.sql", checksum: "checksum-a-nova" },
    { filename: "002_b.sql", checksum: "checksum-b" },
  ];
  const appliedRecords = [
    { filename: "001_a.sql", checksum: "checksum-a-velha" },
  ];

  it("re-registra o checksum de um arquivo já aplicado e presente no diretório", () => {
    const { updates, errors } = resolveForceChecksumUpdates(
      orderedFiles,
      appliedRecords,
      ["001_a.sql"],
    );
    expect(errors).toEqual([]);
    expect(updates).toEqual([
      {
        filename: "001_a.sql",
        previousChecksum: "checksum-a-velha",
        newChecksum: "checksum-a-nova",
      },
    ]);
  });

  it("nomeia todos os arquivos pedidos numa chamada com mais de um nome", () => {
    const { updates, errors } = resolveForceChecksumUpdates(
      [...orderedFiles, { filename: "003_c.sql", checksum: "checksum-c-nova" }],
      [...appliedRecords, { filename: "003_c.sql", checksum: "checksum-c-velha" }],
      ["001_a.sql", "003_c.sql"],
    );
    expect(errors).toEqual([]);
    expect(updates.map((u) => u.filename)).toEqual(["001_a.sql", "003_c.sql"]);
  });

  it("recusa (sem atualizar nada) um arquivo que não existe em supabase/migrations/", () => {
    const { updates, errors } = resolveForceChecksumUpdates(
      orderedFiles,
      appliedRecords,
      ["999_nao_existe.sql"],
    );
    expect(updates).toEqual([]);
    expect(errors).toEqual([
      expect.stringContaining("999_nao_existe.sql"),
    ]);
  });

  it("recusa (sem atualizar nada) um arquivo que existe no disco mas nunca foi aplicado", () => {
    const { updates, errors } = resolveForceChecksumUpdates(
      orderedFiles,
      appliedRecords,
      ["002_b.sql"],
    );
    expect(updates).toEqual([]);
    expect(errors).toEqual([expect.stringContaining("002_b.sql")]);
  });

  it("um nome inválido na lista invalida a chamada inteira, mesmo com nomes válidos junto", () => {
    const { updates, errors } = resolveForceChecksumUpdates(
      orderedFiles,
      appliedRecords,
      ["001_a.sql", "999_nao_existe.sql"],
    );
    expect(updates).toEqual([]);
    expect(errors.length).toBe(1);
  });
});

describe("parseArgs — --force-checksum", () => {
  it("aceita ser repetido para corrigir mais de um arquivo numa chamada", () => {
    const args = parseArgs([
      "--force-checksum",
      "001_a.sql",
      "--force-checksum",
      "002_b.sql",
    ]);
    expect(args.forceChecksum).toEqual(["001_a.sql", "002_b.sql"]);
  });

  it("recusa ser combinado com --baseline", () => {
    expect(() =>
      parseArgs(["--force-checksum", "001_a.sql", "--baseline", "043"]),
    ).toThrowError(/--baseline/);
  });

  it("recusa ser combinado com --dry-run", () => {
    expect(() =>
      parseArgs(["--force-checksum", "001_a.sql", "--dry-run"]),
    ).toThrowError(/--dry-run/);
  });

  it("exige um nome de arquivo depois da flag", () => {
    expect(() => parseArgs(["--force-checksum"])).toThrowError(
      /--force-checksum requer um nome de arquivo/,
    );
  });
});

describe("sanitizeConnectionString", () => {
  const RAW = "postgres://user:pass@db.supabase.co:5432/postgres";

  it("passa uma connection string limpa sem alterações", () => {
    const result = sanitizeConnectionString(RAW);
    expect(result.removedParams).toEqual([]);
    // Comparamos via URL, não string crua: URL normaliza formatação (ex.
    // barra final) sem mudar o que o pg efetivamente recebe.
    expect(new URL(result.connectionString).toString()).toBe(
      new URL(RAW).toString(),
    );
  });

  it("rejeita sslmode=disable — pedido explícito de conexão em texto claro", () => {
    expect(() =>
      sanitizeConnectionString(`${RAW}?sslmode=disable`),
    ).toThrowError(/sslmode=disable/);
  });

  it("rejeita sslmode=no-verify — pedido explícito de pular verificação", () => {
    expect(() =>
      sanitizeConnectionString(`${RAW}?sslmode=no-verify`),
    ).toThrowError(/sslmode=no-verify/);
  });

  it("neutraliza sslmode=require removendo o parâmetro em vez de confiar nele", () => {
    // Este é o caso comum de string colada do painel do Supabase. Não é um
    // pedido de downgrade, mas o pg-connection-string ainda assim zera o
    // ssl explícito quando vê esse parâmetro — por isso precisa ser
    // removido, não apenas aceito.
    const result = sanitizeConnectionString(`${RAW}?sslmode=require`);
    expect(result.removedParams).toContain("sslmode");
    expect(new URL(result.connectionString).searchParams.has("sslmode")).toBe(
      false,
    );
  });

  it("neutraliza sslrootcert, sslcert e sslkey mesmo sem sslmode", () => {
    const result = sanitizeConnectionString(
      `${RAW}?sslrootcert=/tmp/ca.pem&sslcert=/tmp/c.pem&sslkey=/tmp/k.pem`,
    );
    expect(result.removedParams.sort()).toEqual([
      "sslcert",
      "sslkey",
      "sslrootcert",
    ]);
    const url = new URL(result.connectionString);
    expect(url.searchParams.has("sslrootcert")).toBe(false);
    expect(url.searchParams.has("sslcert")).toBe(false);
    expect(url.searchParams.has("sslkey")).toBe(false);
  });

  it("lança erro claro para uma string que não é uma URL válida", () => {
    expect(() => sanitizeConnectionString("isso não é uma url")).toThrow();
  });

  // Verificação empírica de ponta a ponta contra o próprio `pg`: constrói um
  // pg.Client (sem chamar connect(), então nenhuma rede é tocada) com a
  // connection string sanitizada e confere o `ssl` resultante em
  // client.connectionParameters — o objeto que de fato seria usado no
  // handshake TLS. Isto é o que prova que nenhuma entrada consegue produzir
  // uma conexão não verificada: se o sanitizer for removido ou quebrado,
  // estes casos voltam a mostrar `ssl` diferente do explícito.
  describe("integração com pg.Client (sem conectar)", () => {
    const explicitSsl = { rejectUnauthorized: true, marker: "explicito" };

    // `connectionParameters` é interno ao pg e não está em @types/pg — daí o
    // cast. É exatamente o que o construtor de fato monta a partir de
    // `Object.assign({}, config, parse(connectionString))`, então é o único
    // jeito de checar empiricamente qual `ssl` sobrevive sem chamar connect().
    function clientSsl(client: pg.Client): unknown {
      return (client as unknown as { connectionParameters: { ssl: unknown } })
        .connectionParameters.ssl;
    }

    function resolvedSsl(connectionString: string) {
      const sanitized = sanitizeConnectionString(connectionString);
      const client = new pg.Client({
        connectionString: sanitized.connectionString,
        ssl: explicitSsl,
      });
      return clientSsl(client);
    }

    it("sslmode=require sanitizado não sobrescreve o ssl explícito", () => {
      expect(resolvedSsl(`${RAW}?sslmode=require`)).toEqual(explicitSsl);
    });

    it("connection string limpa preserva o ssl explícito", () => {
      expect(resolvedSsl(RAW)).toEqual(explicitSsl);
    });

    it("prova o problema original: SEM sanitizar, sslmode=require zera o ssl explícito", () => {
      // Este teste falharia (corretamente) se alguém "consertasse" o pg — ele
      // documenta o comportamento de terceiro que motiva o sanitizer existir.
      const client = new pg.Client({
        connectionString: `${RAW}?sslmode=require`,
        ssl: explicitSsl,
      });
      expect(clientSsl(client)).not.toEqual(explicitSsl);
      expect(clientSsl(client)).toEqual({});
    });

    it("prova o problema original: SEM sanitizar, sslmode=disable derruba o TLS", () => {
      const client = new pg.Client({
        connectionString: `${RAW}?sslmode=disable`,
        ssl: explicitSsl,
      });
      expect(clientSsl(client)).toBe(false);
    });
  });
});
