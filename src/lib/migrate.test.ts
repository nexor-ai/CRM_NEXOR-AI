// Testa a lógica pura de scripts/migrate.mjs (runner de migrations dos clones).
//
// O arquivo mora aqui, não ao lado de scripts/migrate.mjs, porque vitest.config.ts
// só coleta `src/**/*.test.ts(x)` (ver `include`) — um `scripts/migrate.test.mjs`
// nunca seria descoberto por `npm run test`. Import relativo para o .mjs real:
// nenhuma lógica é duplicada, isto testa o módulo que o runner de fato usa.
import { describe, expect, it } from "vitest";
import {
  computeChecksum,
  computePendingSet,
  parseMigrationFilename,
  resolveBaselineSet,
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
