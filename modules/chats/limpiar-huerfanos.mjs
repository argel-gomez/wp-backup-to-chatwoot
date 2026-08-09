// Finds files in local staging that no longer have an ActiveStorage blob row.
// Dry-run by default. Use --delete (or legacy --borrar) to remove them.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ensureConfig, ask } from "../../lib/config.mjs";
import { WaError, printError } from "../../lib/errors.mjs";
import { banner, panel, ok, warn, info } from "../../lib/ui.mjs";

export async function limpiarHuerfanos({ borrar = false } = {}) {
  banner("Clean orphaned staging files", borrar ? "deletes files without a database row" : "dry run — nothing will be deleted");

  await ensureConfig(["DATABASE_URL", "STORAGE_ROOT"]);
  const staging = process.env.STORAGE_ROOT;
  if (!fs.existsSync(staging)) throw new WaError("ESTG", `Staging folder does not exist: ${staging}`);

  const filesOnDisk = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else filesOnDisk.push({ key: entry.name, full });
    }
  };
  walk(staging);
  info(`Files in staging: ${filesOnDisk.length.toLocaleString("en")}`);

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
  } catch (error) {
    throw new WaError("EDB", "Could not connect to PostgreSQL", `${error.message} — Is the SSH tunnel still open?`);
  }

  let orphans;
  try {
    const { rows } = await client.query("select key from active_storage_blobs");
    const referenced = new Set(rows.map((row) => row.key));
    info(`Keys referenced by the database: ${referenced.size.toLocaleString("en")}`);
    orphans = filesOnDisk.filter((file) => !referenced.has(file.key));
  } finally {
    await client.end();
  }

  if (!orphans.length) {
    ok("No orphaned files found. Every staging file is referenced.");
    return { huerfanos: 0, bytes: 0, borrados: 0 };
  }

  const bytes = orphans.reduce((sum, file) => {
    try { return sum + fs.statSync(file.full).size; } catch { return sum; }
  }, 0);
  const mb = (bytes / 1024 / 1024).toFixed(1);

  if (!borrar) {
    panel([
      "Orphaned files found",
      `Count: ${orphans.length}`,
      `Space: ${mb} MB`,
      "",
      "Nothing was deleted. To delete these files, run:",
      "  node modules/chats/limpiar-huerfanos.mjs --delete",
    ], "amber");
    return { huerfanos: orphans.length, bytes, borrados: 0 };
  }

  warn("\nOnly continue while attachment processing (step 2) is stopped.");
  warn("Files for a chat currently being processed do not have committed database rows yet.");
  const answer = await ask('\nIs attachment processing stopped? Type "yes" to delete: ');
  if (!/^(yes|si|sí)$/i.test(answer.trim())) {
    info("Cancelled. Run this command again after attachment processing has stopped.");
    return { huerfanos: orphans.length, bytes, borrados: 0 };
  }

  let deleted = 0;
  for (const file of orphans) {
    try { fs.unlinkSync(file.full); deleted++; } catch {}
  }
  const prune = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) prune(path.join(directory, entry.name));
    }
    if (directory !== staging && !fs.readdirSync(directory).length) fs.rmdirSync(directory);
  };
  try { prune(staging); } catch {}

  panel(["Orphaned files deleted", `Files deleted: ${deleted}`, `Space released: ${mb} MB`]);
  if (deleted !== orphans.length) warn(`${orphans.length - deleted} file(s) could not be deleted. They may be in use.`);
  return { huerfanos: orphans.length, bytes, borrados: deleted };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    await limpiarHuerfanos({ borrar: process.argv.includes("--delete") || process.argv.includes("--borrar") });
  } catch (error) {
    printError(error);
    process.exit(1);
  }
}
