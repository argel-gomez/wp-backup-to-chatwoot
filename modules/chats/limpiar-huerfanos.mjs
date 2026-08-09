// limpiar-huerfanos.mjs — borra del staging local los archivos que quedaron sin fila en
// la base (residuo de una transacción cortada por una caída de conexión).
//
// Son peso muerto: el chat al que pertenecían se revirtió entero y, al rehacerse, sus
// archivos se vuelven a copiar con otra clave. Si no se limpian, se suben al servidor
// para nada.
//
//   node limpiar-huerfanos.mjs           -> solo informa, NO borra
//   node limpiar-huerfanos.mjs --borrar  -> borra de verdad
//
// Criterio: el nombre de cada archivo del staging ES su clave de ActiveStorage. Se borra
// solo si esa clave no existe en active_storage_blobs — se consulta la tabla ENTERA, sin
// filtrar por bandeja, para no borrar jamás algo que esté referenciado por otra corrida.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ensureConfig } from "../../lib/config.mjs";
import { WaError, printError } from "../../lib/errors.mjs";
import { banner, panel, ok, warn, info } from "../../lib/ui.mjs";

export async function limpiarHuerfanos({ borrar = false } = {}) {
  banner("Limpiar archivos huérfanos del staging",
    borrar ? "BORRA los archivos sin fila en la base" : "solo informa — no borra nada");

  await ensureConfig(["DATABASE_URL", "STORAGE_ROOT"]);
  const staging = process.env.STORAGE_ROOT;
  if (!fs.existsSync(staging)) {
    throw new WaError("ESTG", `No existe la carpeta de staging: ${staging}`);
  }

  // todos los archivos del staging (el nombre del archivo es la clave)
  const enDisco = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else enDisco.push({ key: e.name, full });
    }
  };
  walk(staging);
  info(`archivos en el staging: ${enDisco.length.toLocaleString("es")}`);

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
  } catch (e) {
    throw new WaError("EDB", "No se pudo conectar a Postgres", `${e.message} — ¿el túnel sigue abierto?`);
  }

  let huerfanos, referenciados;
  try {
    const { rows } = await client.query("select key from active_storage_blobs");
    referenciados = new Set(rows.map((r) => r.key));
    info(`claves referenciadas en la base: ${referenciados.size.toLocaleString("es")}`);
    huerfanos = enDisco.filter((f) => !referenciados.has(f.key));
  } finally {
    await client.end();
  }

  if (!huerfanos.length) {
    ok("No hay archivos huérfanos: todo lo del staging está referenciado.");
    return { huerfanos: 0, bytes: 0, borrados: 0 };
  }

  const bytes = huerfanos.reduce((a, f) => {
    try { return a + fs.statSync(f.full).size; } catch { return a; }
  }, 0);
  const mb = (bytes / 1024 / 1024).toFixed(1);

  if (!borrar) {
    panel([
      "Archivos huérfanos encontrados",
      `Cantidad: ${huerfanos.length}`,
      `Espacio:  ${mb} MB`,
      "",
      "No se borró nada. Para borrarlos:",
      "  node modules/chats/limpiar-huerfanos.mjs --borrar",
    ], "amber");
    return { huerfanos: huerfanos.length, bytes, borrados: 0 };
  }

  // NUNCA borrar con el PASO 2 en marcha: los archivos del chat que se está procesando
  // ya están en disco pero su transacción todavía no confirmó, así que se ven como
  // huérfanos sin serlo. Borrarlos dejaría ese chat con adjuntos rotos.
  warn("\nEsto solo es seguro con el PASO 2 (colgar adjuntos) DETENIDO.");
  warn("Si está corriendo, los archivos del chat en curso todavía no tienen fila y se");
  warn("borrarían por error.");
  const { ask } = await import("../../lib/config.mjs");
  const r = await ask('\n¿El PASO 2 está detenido? Escribí "si" para borrar: ');
  if (!/^s[ií]$/i.test(r.trim())) {
    info("Cancelado. Volvé a correrlo cuando el PASO 2 haya terminado.");
    return { huerfanos: huerfanos.length, bytes, borrados: 0 };
  }

  let borrados = 0;
  for (const f of huerfanos) {
    try { fs.unlinkSync(f.full); borrados++; } catch {}
  }
  // carpetas que quedaron vacías
  const podar = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) podar(path.join(d, e.name));
    }
    if (d !== staging && !fs.readdirSync(d).length) fs.rmdirSync(d);
  };
  try { podar(staging); } catch {}

  panel([
    "Huérfanos eliminados",
    `Archivos borrados: ${borrados}`,
    `Espacio liberado:  ${mb} MB`,
  ]);
  if (borrados !== huerfanos.length) {
    warn(`${huerfanos.length - borrados} archivo(s) no se pudieron borrar (¿en uso?).`);
  }
  return { huerfanos: huerfanos.length, bytes, borrados };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    await limpiarHuerfanos({ borrar: process.argv.includes("--borrar") });
  } catch (e) {
    printError(e);
    process.exit(1);
  }
}
