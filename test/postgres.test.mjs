import test from "node:test";
import assert from "node:assert/strict";
import { deriveDatabaseSettings, parseKeyValueLines } from "../lib/postgres.mjs";

test("parsea valores que contienen signos igual", () => {
  assert.deepEqual(parseKeyValueLines("POSTGRES_PASSWORD=a=b=c\nPOSTGRES_DB=chatwoot\n"), {
    POSTGRES_PASSWORD: "a=b=c",
    POSTGRES_DB: "chatwoot",
  });
});

test("crea una URL local para el Docker Compose oficial", () => {
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

test("conserva parámetros y enruta una base administrada a través de SSH", () => {
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

test("rechaza un host Docker que no es alcanzable desde el servidor", () => {
  assert.throws(
    () => deriveDatabaseSettings({
      POSTGRES_HOST: "postgres",
      POSTGRES_USERNAME: "postgres",
      POSTGRES_PASSWORD: "secret",
    }),
    /no se encontró cómo alcanzarlo/i
  );
});
