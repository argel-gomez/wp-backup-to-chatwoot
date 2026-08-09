import test from "node:test";
import assert from "node:assert/strict";
import { deriveDatabaseSettings, parseKeyValueLines } from "../lib/postgres.mjs";

test("parses values containing equal signs", () => {
  assert.deepEqual(parseKeyValueLines("POSTGRES_PASSWORD=a=b=c\nPOSTGRES_DB=chatwoot\n"), {
    POSTGRES_PASSWORD: "a=b=c",
    POSTGRES_DB: "chatwoot",
  });
});

test("creates a local URL for the official Docker Compose setup", () => {
  const result = deriveDatabaseSettings({
    POSTGRES_HOST: "postgres",
    POSTGRES_PORT: "5432",
    POSTGRES_DATABASE: "chatwoot",
    POSTGRES_USERNAME: "postgres",
    POSTGRES_PASSWORD: "p@ss#word",
    __PG_BIND__: "127.0.0.1:5432",
  });

  const url = new URL(result.DATABASE_URL);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "15432");
  assert.equal(decodeURIComponent(url.username), "postgres");
  assert.equal(decodeURIComponent(url.password), "p@ss#word");
  assert.equal(url.pathname, "/chatwoot");
  assert.equal(result.TUNNEL_REMOTE_HOST, "127.0.0.1");
  assert.equal(result.TUNNEL_REMOTE_PORT, "5432");
});

test("preserves parameters and routes a managed database through SSH", () => {
  const result = deriveDatabaseSettings({
    DATABASE_URL: "postgresql://chatwoot:secret@db.internal:5433/chatwoot_production?sslmode=require",
  }, { localPort: "25432" });

  const url = new URL(result.DATABASE_URL);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "25432");
  assert.equal(url.searchParams.get("sslmode"), "require");
  assert.equal(result.TUNNEL_REMOTE_HOST, "db.internal");
  assert.equal(result.TUNNEL_REMOTE_PORT, "5433");
});

test("rejects a Docker host that cannot be reached from the server", () => {
  assert.throws(
    () => deriveDatabaseSettings({
      POSTGRES_HOST: "postgres",
      POSTGRES_USERNAME: "postgres",
      POSTGRES_PASSWORD: "secret",
    }),
    /could not be reached from SSH/i
  );
});
