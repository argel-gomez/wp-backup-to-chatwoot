// subir-adjuntos.mjs — Sube los adjuntos ya generados en storage-staging/ al volumen
// de storage del servidor de Chatwoot.
//
// Por qué existe: el importador corre en la PC (por túnel SSH a Postgres), así que puede
// escribir las filas de la base pero no los archivos, que viven en el disco del servidor.
// El importador los deja en storage-staging/ con el layout de ActiveStorage (xx/yy/clave);
// este script los empaqueta, los sube en UN solo archivo y los descomprime en su lugar.
//
// Se empaqueta con tar en vez de mandar los 21.000 archivos sueltos por scp: scp abre una
// conexión por archivo y tardaría horas; un solo .tar va a velocidad de red.
//
//   node subir-adjuntos.mjs

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureConfig, ask, ROOT_DIR } from "../../lib/config.mjs";
import { WaError, printError } from "../../lib/errors.mjs";
import { banner, panel, ok, warn, info, fail, progressBar, endProgressBar } from "../../lib/ui.mjs";

// Qué lotes ya se subieron: permite retomar una subida cortada sin repetir lo hecho.
const PROGRESO = path.join(ROOT_DIR, "subida-adjuntos.json");

function cargarProgreso() {
  try {
    return new Set(JSON.parse(fs.readFileSync(PROGRESO, "utf8")).lotes || []);
  } catch {
    return new Set();
  }
}

function guardarProgreso(hechos) {
  fs.writeFileSync(PROGRESO, JSON.stringify({ lotes: [...hechos].sort() }, null, 2));
}

// Sube UNA subcarpeta del staging canalizando tar por ssh: el paquete viaja por la
// tubería y se descomprime del otro lado sin escribirse nunca en disco.
//
// La tubería se arma en Node, NO con `cmd /c ... | ...`, por dos motivos que costaron
// caro al probarlo:
//   1. Las rutas de Windows llevan "\" y al pasarlas por el shell hay que escaparlas;
//      cualquier error de comillas termina en un "could not chdir" silencioso. Con spawn
//      los argumentos van tal cual, sin shell de por medio.
//   2. En una tubería de cmd el código de salida es el del ÚLTIMO comando: si fallaba el
//      empaquetado local, la subida devolvía 0 y el lote quedaba marcado como hecho sin
//      haber subido nada. Acá se esperan y verifican los DOS procesos.
function subirLote(staging, lote, key, destino, remoteStorage) {
  return new Promise((resolve, reject) => {
    // el path remoto es de Linux: comillas simples alcanzan para el shell del servidor
    const remoto = `sudo tar -xf - -C '${remoteStorage.replace(/'/g, `'\\''`)}'`;

    const tar = spawn("tar", ["-cf", "-", "-C", staging, lote], { stdio: ["ignore", "pipe", "pipe"] });
    const ssh = spawn("ssh", [
      "-i", key, "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30",
      "-o", "StrictHostKeyChecking=accept-new", destino, remoto,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let errTar = "", errSsh = "";
    tar.stderr.on("data", (d) => (errTar += d));
    ssh.stderr.on("data", (d) => (errSsh += d));
    tar.stdout.pipe(ssh.stdin);

    let pendientes = 2, codTar = null, codSsh = null, fallo = null;
    const terminar = () => {
      if (--pendientes) return;
      if (fallo) return reject(fallo);
      const ultimas = (s) => s.trim().split("\n").slice(-3).join(" | ");
      if (codTar !== 0) {
        return reject(new WaError("ESSH", `Batch packaging failed (exit code ${codTar})`, ultimas(errTar)));
      }
      if (codSsh !== 0) {
        return reject(new WaError("ESSH", `Batch upload failed (exit code ${codSsh})`, ultimas(errSsh)));
      }
      resolve();
    };

    tar.on("error", (e) => { fallo = new WaError("ESSH", "Could not run tar", e.message); codTar = -1; terminar(); });
    ssh.on("error", (e) => { fallo = new WaError("ESSH", "Could not run ssh", e.message); codSsh = -1; terminar(); });
    tar.on("close", (c) => { if (codTar === null) { codTar = c; terminar(); } });
    ssh.on("close", (c) => { if (codSsh === null) { codSsh = c; terminar(); } });
  });
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

function run(cmd, args, { capture = false } = {}) {
  const res = spawnSync(cmd, args, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (res.error) throw new WaError("ESSH", `Could not run ${cmd}`, res.error.message);
  if (res.status !== 0) {
    throw new WaError(
      "ESSH", `${cmd} failed (exit code ${res.status})`,
      capture ? (res.stderr || "").trim() : "See the details above."
    );
  }
  return capture ? (res.stdout || "").trim() : "";
}

// Cuenta archivos y bytes de la carpeta de staging (recursivo).
function statStaging(dir) {
  let files = 0, bytes = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        files++;
        bytes += fs.statSync(full).size;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { files, bytes };
}

const gb = (b) => (b / 1024 / 1024 / 1024).toFixed(2);

export async function subirAdjuntos() {
  banner("Upload attachments to the server", "streams storage-staging/ into Chatwoot storage");

  await ensureConfig(["STORAGE_ROOT", "SSH_HOST", "SSH_USER", "SSH_KEY"]);
  const staging = process.env.STORAGE_ROOT;
  const host = process.env.SSH_HOST;
  const user = process.env.SSH_USER || "ubuntu";
  const key = process.env.SSH_KEY;
  const destino = `${user}@${host}`;

  const { files, bytes } = statStaging(staging);
  if (!files) {
    throw new WaError(
      "ESTG", `No files were found in ${staging}`,
      "Run step 2 first (attach files, option 6 in the chat importer)."
    );
  }
  info(`Staging: ${files} files, ${gb(bytes)} GB in ${staging}`);

  const ssh = (remoteCmd, opts) =>
    run("ssh", ["-i", key, "-o", "BatchMode=yes", destino, remoteCmd], opts);

  // El storage suele ser un volumen de Docker (/var/lib/docker/volumes/...), que solo root
  // puede tocar. La sesión no es interactiva, así que sudo tiene que funcionar sin pedir
  // contraseña: si pide, mejor cortar acá con un mensaje claro que fallar más adelante.
  try {
    ssh("sudo -n true", { capture: true });
  } catch {
    throw new WaError(
      "ESUDO", "sudo requires a password on the server",
      `Test it manually: ssh -i "${key}" ${destino} "sudo -n true"\n` +
      "Enable passwordless sudo for this user or run the upload manually using the README commands."
    );
  }

  // 1. Dónde está montado /app/storage en el host
  info("Locating the storage folder on the server...");
  const mounts = ssh(
    `docker inspect chatwoot-rails-1 --format '{{range .Mounts}}{{.Source}}|{{.Destination}}{{"\\n"}}{{end}}'`,
    { capture: true }
  );
  const linea = mounts.split("\n").map((l) => l.trim()).find((l) => l.endsWith("|/app/storage"));
  if (!linea) {
    throw new WaError(
      "ESTO", "Could not find the container's /app/storage volume",
      `Detected mounts:\n${mounts}`
    );
  }
  const remoteStorage = linea.split("|")[0];
  ok(`Server storage: ${remoteStorage}`);

  // Todo lo que toque esta carpeta va con sudo: es un volumen de Docker, colgado de
  // /var/lib/docker/volumes/, que solo root puede leer.
  // Dueño actual: hay que respetarlo o Chatwoot no va a poder leer los archivos.
  const owner = ssh(`sudo stat -c '%u:%g' ${JSON.stringify(remoteStorage)}`, { capture: true });
  info(`Folder owner: ${owner}`);

  const espacio = ssh(`sudo df -h ${JSON.stringify(remoteStorage)} | tail -1`, { capture: true });
  info(`Disk space: ${espacio}`);

  const confirmar = await ask(
    `\nUpload ${gb(bytes)} GB to ${remoteStorage}? (y/N): `
  );
  if (!/^(y|yes|s|si|sí)$/i.test(confirmar.trim())) {
    info("Cancelled.");
    return;
  }

  // 2..4. Subida POR LOTES y en streaming.
  //
  // ActiveStorage guarda los archivos en carpetas de dos caracteres (xx/yy/clave), así que
  // el primer nivel da hasta 256 lotes naturales de tamaño parejo. Se sube uno por uno
  // canalizando tar por ssh: el paquete nunca se escribe en disco, ni acá ni allá.
  //
  // Por qué en lotes y no un único paquete de 16 GB:
  //   - REANUDABLE: si se corta la conexión (o se cierra el túnel) al 80%, al volver a
  //     correr sigue desde el lote que faltaba en vez de empezar de cero.
  //   - El pico de disco en el servidor pasa de ~2x el total a apenas un lote.
  //   - Un lote que falla se reintenta solo, sin arrastrar a los demás.
  const lotes = fs.readdirSync(staging, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  if (!lotes.length) {
    throw new WaError("ESTG", `${staging} has no ActiveStorage-formatted subfolders`,
      "Check that STORAGE_ROOT points to the correct folder.");
  }

  const hechos = cargarProgreso();
  const pendientes = lotes.filter((l) => !hechos.has(l));
  if (hechos.size) {
    info(`Resuming: ${hechos.size} of ${lotes.length} batches were already uploaded.`);
  }
  info(`\nStreaming ${pendientes.length} batch(es) without intermediate archives.\n`);

  let subidos = 0, fallidos = 0;
  const errores = [];
  let consecutivos = 0;

  for (const [i, lote] of pendientes.entries()) {
    progressBar(i, pendientes.length, `batch ${lote}`);
    try {
      // tar local -> ssh -> tar remoto. Todo por la tubería, nada toca el disco.
      await subirLote(staging, lote, key, destino, remoteStorage);
      hechos.add(lote);
      guardarProgreso(hechos);
      subidos++;
      consecutivos = 0;
    } catch (e) {
      endProgressBar();
      fallidos++;
      consecutivos++;
      errores.push({ lote, error: e.message, detalle: e.detail });
      fail(`Batch ${lote}: ${e.message}`);
      // si se cayó la conexión, los siguientes van a fallar todos igual
      if (consecutivos >= 3) {
        warn("\nThree consecutive batches failed. Check the connection and run this option again.");
        warn("The upload will resume at the first pending batch.");
        break;
      }
    }
  }
  progressBar(pendientes.length, pendientes.length, "done");
  endProgressBar();

  // El dueño se ajusta una sola vez al final: es un chown recursivo, no hace falta por lote.
  if (subidos) {
    info("\nUpdating server permissions...");
    ssh(`sudo chown -R ${owner} ${JSON.stringify(remoteStorage)}`);
  }

  const total = ssh(`sudo find ${JSON.stringify(remoteStorage)} -type f | wc -l`, { capture: true });

  panel([
    fallidos ? "Upload incomplete" : "Attachments installed",
    `Batches uploaded: ${subidos} of ${lotes.length}`,
    `Files in staging: ${files}`,
    `Total storage files: ${total}`,
    `Server folder: ${remoteStorage}`,
  ], fallidos ? "amber" : "green");

  if (fallidos) {
    warn(`${fallidos} batch(es) failed. Run this option again to retry only those batches.`);
  } else {
    fs.rmSync(PROGRESO, { force: true }); // terminó todo: el registro ya no hace falta
    info("Refresh Chatwoot. Imported conversation images and audio should now be visible.");
  }
}

// Permite correrlo suelto: node subir-adjuntos.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    await subirAdjuntos();
  } catch (e) {
    printError(e);
    process.exit(1);
  }
}
