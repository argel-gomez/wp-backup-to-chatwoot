// config.mjs — configuración compartida de TODO el programa en un solo .env (en la
// raíz del proyecto). Si falta un dato se pregunta por consola una vez, se guarda,
// y la próxima corrida ya no molesta. Lo usan los tres módulos y el menú principal.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { WaError } from "./errors.mjs";

// Raíz del programa (la carpeta que contiene run.bat, menu.mjs y .env)
export const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ENV_PATH = path.join(ROOT_DIR, ".env");

// Carpetas de ENTRADA: el usuario solo tiene que soltar sus archivos ahí y el
// programa los encuentra solo (el menú las crea si no existen).
export const DROP_DIRS = {
  backup: path.join(ROOT_DIR, "PLACE-HERE-1-ANDROID-BACKUP"),
  contactos: path.join(ROOT_DIR, "PLACE-HERE-2-CONTACTS"),
  exportChats: path.join(ROOT_DIR, "PLACE-HERE-3-CHATWOOT-EXPORT"),
};

try {
  process.loadEnvFile(ENV_PATH);
} catch {
  // .env no existe todavía: se crea al guardar la primera respuesta
}

export function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// Entrada oculta para tokens y contraseñas. Solo se usa después de comprobar que
// hay una terminal interactiva; nunca imprime el valor ni lo agrega a logs.
export function askHidden(question) {
  return new Promise((resolve) => {
    const { stdin } = process;
    process.stdout.write(question);
    let value = "";

    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(value.trim());
    };

    const onData = (chunk) => {
      // Al pegar un valor, Windows Terminal puede entregar texto + Enter en el
      // mismo chunk. Se procesa carácter por carácter para no guardar el CR.
      for (const char of chunk.toString("utf8")) {
        const code = char.charCodeAt(0);
        if (code === 10 || code === 13) {
          finish();
          return;
        }
        if (code === 3) {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(1);
        }
        if (code === 8 || code === 127) {
          if (value.length) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else {
          value += char;
          process.stdout.write("*");
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

// Lee el .env como objeto { CLAVE: valor }. Existe porque process.loadEnvFile NO pisa
// variables que ya están en el entorno: el menú corre los módulos como procesos hijos
// que heredan su entorno, así que si un módulo guarda un dato nuevo en .env, el menú
// tiene que re-aplicarse el archivo a mano (ver menu.mjs) o el hijo siguiente vería
// el valor viejo heredado en vez del recién guardado.
export function readEnvFile() {
  const values = {};
  let text;
  try {
    text = fs.readFileSync(ENV_PATH, "utf8");
  } catch {
    return values;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    // mismas reglas de comillas que process.loadEnvFile: un valor entre comillas
    // (típico al pegar rutas con espacios en el bloc de notas) se usa sin ellas
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

// Un "#" sin comillas corta el valor al releer el .env (process.loadEnvFile lo trata
// como comentario, incluso pegado al texto — ej. una contraseña con "#" dentro de
// DATABASE_URL). Se escribe entre comillas en esos casos; loadEnvFile las quita solo.
function envSerialize(value) {
  const s = String(value);
  return s.includes("#") || /^\s|\s$/.test(s) ? `"${s}"` : s;
}

export function saveToEnvFile(newValues) {
  let lines = [];
  try {
    lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
  } catch {
    lines = [];
  }

  const seen = new Set();
  lines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (match && Object.prototype.hasOwnProperty.call(newValues, match[1])) {
      seen.add(match[1]);
      return `${match[1]}=${envSerialize(newValues[match[1]])}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(newValues)) {
    if (!seen.has(key)) lines.push(`${key}=${envSerialize(value)}`);
  }

  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n");
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch {
    // Windows administra los permisos con ACL; chmod puede no estar disponible.
  }
}

// ---------- Búsqueda de la llave .pem ----------

// Busca *.pem dentro de una carpeta, incluyendo subcarpetas (hasta 3 niveles, salteando
// node_modules/.git). Así el usuario puede pegar "C:\Carpeta" sin saber la ruta exacta.
export function findPemFiles(dir, depth = 3) {
  const found = [];
  const walk = (d, left) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return; // carpeta sin permiso de lectura: se ignora
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (left > 0 && e.name !== "node_modules" && e.name !== ".git") walk(full, left - 1);
      } else if (e.name.toLowerCase().endsWith(".pem")) {
        found.push(full);
      }
    }
  };
  walk(dir, depth);
  return found;
}

// Acepta la ruta de un archivo .pem O de una carpeta donde buscarlo.
// Devuelve la ruta final del archivo, o null si hay que volver a preguntar.
export async function resolvePemLocation(raw) {
  // Windows pega la ruta entre comillas al usar "Copiar como ruta de acceso"
  const input = raw.replace(/^"(.*)"$/, "$1").trim();
  if (!input) return null;

  let st = null;
  try {
    st = fs.statSync(input);
  } catch {}

  if (st?.isFile()) {
    if (!input.toLowerCase().endsWith(".pem")) {
      console.log("  Warning: the file does not end in .pem; it will still be used.");
    }
    return input;
  }

  if (st?.isDirectory()) {
    const pems = findPemFiles(input);
    if (!pems.length) {
      console.log(`  No .pem file was found in ${input} (subdirectories were also searched).`);
      return null;
    }
    if (pems.length === 1) {
      console.log(`  Key found: ${pems[0]}`);
      return pems[0];
    }
    console.log(`  Found ${pems.length} .pem files in that directory:`);
    pems.forEach((p, i) => console.log(`    ${i + 1}) ${p}`));
    const n = Number(await ask(`  Which one should be used? (1-${pems.length}): `));
    if (Number.isInteger(n) && pems[n - 1]) return pems[n - 1];
    console.log("  Invalid option.");
    return null;
  }

  console.log(`  Path does not exist: ${input}`);
  return null;
}

// ---------- Campos conocidos ----------

// Busca el export de chats (chatwoot_export.json) en la carpeta de entrada
// PLACE-HERE-3-CHATWOOT-EXPORT: directo o un nivel adentro (ej. export_chatwoot/).
function findExportDir() {
  const base = DROP_DIRS.exportChats;
  const candidatos = [base];
  try {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (e.isDirectory()) candidatos.push(path.join(base, e.name));
    }
  } catch {}
  for (const d of candidatos) {
    if (fs.existsSync(path.join(d, "chatwoot_export.json"))) return d;
  }
  return null;
}

const esNumero = (v) => (/^\d+$/.test(v) ? true : "must be a number");

function normalizeBaseUrl(raw) {
  try {
    const value = raw.includes("://") ? raw : `https://${raw}`;
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function normalizeAccountId(raw) {
  return raw.match(/\/accounts\/(\d+)/)?.[1] || raw.match(/\d+/)?.[0] || raw;
}

const FIELDS = {
  CHATWOOT_BASE_URL: {
    question: "Chatwoot base URL",
    hint: "example: https://chatwoot.example.com or https://app.chatwoot.com",
    normalize: normalizeBaseUrl,
    validate: (v) => (/^https?:\/\/[^/]+$/i.test(v) ? true : "must be a valid HTTP(S) URL"),
  },
  CHATWOOT_ACCOUNT_ID: {
    question: "Chatwoot account ID",
    hint: "the number shown in /app/accounts/123/...",
    normalize: normalizeAccountId,
    validate: esNumero,
  },
  CHATWOOT_TOKEN: {
    question: "Chatwoot profile access token",
    hint: "Chatwoot > Profile settings > Access Token",
    secret: true,
  },
  DEFAULT_COUNTRY_CODE: {
    question: "Default international calling code",
    hint: "example: +55 for Brazil, +34 for Spain, +52 for Mexico",
    default: "+55",
    normalize: (v) => `+${v.replace(/\D/g, "")}`,
    validate: (v) => (/^\+[1-9]\d{0,2}$/.test(v) ? true : "use the format +55, +34, +52, etc."),
  },
  EXPORT_DIR: {
    question: "WhatsApp export directory (the one containing chatwoot_export.json)",
    hint: String.raw`place it in PLACE-HERE-3-CHATWOOT-EXPORT for automatic detection, or enter its path`,
    preset: findExportDir,
    validate: (v) =>
      fs.existsSync(path.join(v, "chatwoot_export.json"))
        ? true
        : "chatwoot_export.json was not found there; check the path",
  },
  DATABASE_URL: {
    question: "Chatwoot PostgreSQL connection URL",
    hint: "example: postgres://chatwoot:password@127.0.0.1:15432/chatwoot_production (with the SSH tunnel open)",
    secret: true,
    validate: (v) => (/^postgres(ql)?:\/\//i.test(v) ? true : "must start with postgres://"),
  },
  ACCOUNT_ID: {
    question: "ACCOUNT_ID — Chatwoot account number",
    hint: "listed by database reconnaissance (chat importer option 2)",
    hintOptional: "listed by database reconnaissance (option 2); press Enter to complete later",
    validate: esNumero,
  },
  INBOX_ID: {
    question: "INBOX_ID — destination WhatsApp inbox",
    hint: "listed by database reconnaissance (chat importer option 2)",
    hintOptional: "listed by database reconnaissance (option 2); press Enter to complete later",
    validate: esNumero,
  },
  AGENT_USER_ID: {
    question: "AGENT_USER_ID — user assigned to historical outgoing messages",
    hint: "listed by database reconnaissance (chat importer option 2)",
    hintOptional: "listed by database reconnaissance (option 2); press Enter to complete later",
    validate: esNumero,
  },
  STORAGE_ROOT: {
    question: "LOCAL attachment staging directory",
    hint: String.raw`example: C:\Backup\storage-staging; it is created automatically and STEP 3 uploads it`,
    // Sin esto, un "4" tecleado por error (creyendo que era una opción del menú) se
    // aceptaba como carpeta y el staging terminaba en un directorio llamado "4".
    validate: (v) =>
      /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(v)
        ? true
        : String.raw`must be an absolute path, example: C:\Backup\storage-staging`,
  },
  SSH_HOST: {
    question: "Chatwoot server hostname or IP address",
    hint: "the server's public IP or domain, example: chatwoot.example.com",
    validate: (v) => (/^[a-zA-Z0-9.-]+$/.test(v) ? true : "use only a domain name or IPv4 address"),
  },
  SSH_USER: {
    question: "Server SSH user (Enter = ubuntu)",
    default: "ubuntu",
    validate: (v) => (/^[a-zA-Z0-9._-]+$/.test(v) ? true : "the username contains unsupported characters"),
  },
  SSH_KEY: {
    question: "Server .pem key — path to the FILE or a DIRECTORY to search",
    hint: String.raw`example: C:\Keys\server.pem or C:\Keys (searches subdirectories for *.pem)`,
    resolve: resolvePemLocation,
  },
};

// Pregunta por consola los campos pedidos que falten en .env y los guarda.
// Sin terminal interactiva no puede preguntar: corta con instrucciones claras.
//
// opts.optional: claves de esta llamada que se pueden dejar en blanco con Enter
// (ej. al arrancar el menú, antes de correr el reconocimiento) — igual quedan
// SIN completar, así que una llamada posterior sin marcarlas opcionales
// (ej. al importar de verdad) las vuelve a pedir y ahí sí son obligatorias.
export async function ensureConfig(keys, opts = {}) {
  const optionalHere = new Set(opts.optional || []);
  let missing = keys.filter((k) => !process.env[k]);
  if (!missing.length) return;

  // Campos que se detectan solos desde las carpetas PLACE-HERE: si el archivo
  // esperado ya está ahí, ni se pregunta. Va antes del chequeo de TTY para que
  // también funcione en corridas sin consola (automatizadas).
  const preSave = {};
  for (const key of missing) {
    const field = FIELDS[key];
    if (field?.preset) {
      const detected = await field.preset();
      if (detected) {
        console.log(`  ${key} detected automatically: ${detected}`);
        process.env[key] = detected;
        preSave[key] = detected;
      }
    }
  }
  if (Object.keys(preSave).length) saveToEnvFile(preSave);
  missing = missing.filter((k) => !process.env[k]);
  if (!missing.length) return;

  if (!process.stdin.isTTY) {
    const trulyMissing = missing.filter((k) => !optionalHere.has(k));
    if (!trulyMissing.length) return;
    throw new WaError(
      "ECFG", `Missing configuration: ${trulyMissing.join(", ")}`,
      "No interactive terminal is available; complete .env (see .env.example)."
    );
  }

  console.log("\nConfiguration is missing. It will be requested once and saved in .env.\n");
  const toSave = {};

  for (const key of missing) {
    const field = FIELDS[key] || { question: key };
    const isOptional = field.optional || optionalHere.has(key);
    while (true) {
      const hint = isOptional && field.hintOptional ? field.hintOptional : field.hint;
      if (hint) console.log(`  ${hint}`);
      let value = field.secret
        ? await askHidden(`${field.question}: `)
        : await ask(`${field.question}: `);

      if (!value && field.default) value = field.default;

      if (!value) {
        if (isOptional) break;
        console.log("  This value is required.\n");
        continue;
      }

      if (field.resolve) {
        const resolved = await field.resolve(value);
        if (!resolved) {
          console.log("");
          continue;
        }
        value = resolved;
      }

      if (field.normalize) value = field.normalize(value);

      const check = field.validate ? field.validate(value) : true;
      if (check !== true) {
        console.log(`  ${check}\n`);
        continue;
      }
      if (key === "STORAGE_ROOT" && !fs.existsSync(value)) {
        console.log("  Warning: that directory does not exist yet; it is created with the first attachment.");
      }

      process.env[key] = value;
      toSave[key] = value;
      break;
    }
    console.log("");
  }

  if (Object.keys(toSave).length) {
    saveToEnvFile(toSave);
    console.log("Saved to .env.\n");
  }
}
