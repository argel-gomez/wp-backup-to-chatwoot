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
  backup: path.join(ROOT_DIR, "PONER-AQUI-1-respaldo-celular"),
  contactos: path.join(ROOT_DIR, "PONER-AQUI-2-contactos"),
  exportChats: path.join(ROOT_DIR, "PONER-AQUI-3-export-chats"),
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
      console.log("  Aviso: el archivo no termina en .pem — se usa igual.");
    }
    return input;
  }

  if (st?.isDirectory()) {
    const pems = findPemFiles(input);
    if (!pems.length) {
      console.log(`  No encontré ningún .pem dentro de ${input} (busqué también en subcarpetas).`);
      return null;
    }
    if (pems.length === 1) {
      console.log(`  Encontré la llave: ${pems[0]}`);
      return pems[0];
    }
    console.log(`  Encontré ${pems.length} archivos .pem en esa carpeta:`);
    pems.forEach((p, i) => console.log(`    ${i + 1}) ${p}`));
    const n = Number(await ask(`  ¿Cuál uso? (1-${pems.length}): `));
    if (Number.isInteger(n) && pems[n - 1]) return pems[n - 1];
    console.log("  Opción inválida.");
    return null;
  }

  console.log(`  No existe esa ruta: ${input}`);
  return null;
}

// ---------- Campos conocidos ----------

// Busca el export de chats (chatwoot_export.json) en la carpeta de entrada
// PONER-AQUI-3-export-chats: directo o un nivel adentro (ej. export_chatwoot/).
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

const esNumero = (v) => (/^\d+$/.test(v) ? true : "tiene que ser un número");

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
    question: "URL base de Chatwoot",
    hint: "ej: https://chatwoot.example.com o https://app.chatwoot.com",
    normalize: normalizeBaseUrl,
    validate: (v) => (/^https?:\/\/[^/]+$/i.test(v) ? true : "tiene que ser una URL http(s) válida"),
  },
  CHATWOOT_ACCOUNT_ID: {
    question: "Account ID de Chatwoot",
    hint: "es el número visible en /app/accounts/123/...",
    normalize: normalizeAccountId,
    validate: esNumero,
  },
  CHATWOOT_TOKEN: {
    question: "Token de acceso del perfil de Chatwoot",
    hint: "Chatwoot > Configuración del perfil > Token de acceso",
    secret: true,
  },
  DEFAULT_COUNTRY_CODE: {
    question: "Código telefónico internacional predeterminado",
    hint: "ej: +55 para Brasil, +34 para España, +52 para México",
    default: "+55",
    normalize: (v) => `+${v.replace(/\D/g, "")}`,
    validate: (v) => (/^\+[1-9]\d{0,2}$/.test(v) ? true : "usá el formato +55, +34, +52, etc."),
  },
  EXPORT_DIR: {
    question: "Carpeta del export de WhatsApp (la que contiene chatwoot_export.json)",
    hint: String.raw`dejalo en la carpeta PONER-AQUI-3-export-chats y se detecta solo — o pegá la ruta`,
    preset: findExportDir,
    validate: (v) =>
      fs.existsSync(path.join(v, "chatwoot_export.json"))
        ? true
        : "ahí no encuentro chatwoot_export.json — revisá la ruta",
  },
  DATABASE_URL: {
    question: "URL de conexión a la base Postgres de Chatwoot",
    hint: "ej: postgres://chatwoot:clave@127.0.0.1:15432/chatwoot_production (con el túnel SSH del menú principal abierto)",
    secret: true,
    validate: (v) => (/^postgres(ql)?:\/\//i.test(v) ? true : "tiene que empezar con postgres://"),
  },
  ACCOUNT_ID: {
    question: "ACCOUNT_ID — número de cuenta de Chatwoot",
    hint: "lo lista el reconocimiento (opción 2 del importador de chats)",
    hintOptional: "lo lista el reconocimiento (opción 2 del importador de chats) — Enter para completarlo después",
    validate: esNumero,
  },
  INBOX_ID: {
    question: "INBOX_ID — inbox del canal WhatsApp destino",
    hint: "lo lista el reconocimiento (opción 2 del importador de chats)",
    hintOptional: "lo lista el reconocimiento (opción 2 del importador de chats) — Enter para completarlo después",
    validate: esNumero,
  },
  AGENT_USER_ID: {
    question: "AGENT_USER_ID — usuario que firma los mensajes salientes históricos",
    hint: "lo lista el reconocimiento (opción 2 del importador de chats)",
    hintOptional: "lo lista el reconocimiento (opción 2 del importador de chats) — Enter para completarlo después",
    validate: esNumero,
  },
  STORAGE_ROOT: {
    question: "Carpeta de staging LOCAL para los adjuntos",
    hint: String.raw`ej: C:\Backup\storage-staging — se crea sola; el PASO 3 la sube entera al servidor`,
    // Sin esto, un "4" tecleado por error (creyendo que era una opción del menú) se
    // aceptaba como carpeta y el staging terminaba en un directorio llamado "4".
    validate: (v) =>
      /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(v)
        ? true
        : String.raw`tiene que ser una ruta completa, ej: C:\Backup\storage-staging`,
  },
  SSH_HOST: {
    question: "IP o host del servidor de Chatwoot",
    hint: "la IP pública o el dominio del servidor, ej: chatwoot.example.com",
    validate: (v) => (/^[a-zA-Z0-9.-]+$/.test(v) ? true : "usá solamente un dominio o una dirección IPv4"),
  },
  SSH_USER: {
    question: "Usuario SSH del servidor (Enter = ubuntu)",
    default: "ubuntu",
    validate: (v) => (/^[a-zA-Z0-9._-]+$/.test(v) ? true : "el usuario contiene caracteres no permitidos"),
  },
  SSH_KEY: {
    question: "Llave .pem del servidor — ruta del ARCHIVO o de una CARPETA donde buscarla",
    hint: String.raw`ej: C:\Carpeta\llave.pem  o  C:\Carpeta  (busca *.pem adentro, subcarpetas incluidas)`,
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

  // Campos que se detectan solos desde las carpetas PONER-AQUI: si el archivo
  // esperado ya está ahí, ni se pregunta. Va antes del chequeo de TTY para que
  // también funcione en corridas sin consola (automatizadas).
  const preSave = {};
  for (const key of missing) {
    const field = FIELDS[key];
    if (field?.preset) {
      const detected = await field.preset();
      if (detected) {
        console.log(`  ${key} detectado automáticamente: ${detected}`);
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
      "ECFG", `Falta configuración: ${trulyMissing.join(", ")}`,
      "No hay terminal interactiva para preguntar — completá .env (ver .env.example)."
    );
  }

  console.log("\nFalta configuración — se pregunta una vez y se guarda en .env.\n");
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
        console.log("  Es obligatorio.\n");
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
        console.log("  Aviso: esa carpeta no existe todavía — se crea sola al colgar el primer adjunto.");
      }

      process.env[key] = value;
      toSave[key] = value;
      break;
    }
    console.log("");
  }

  if (Object.keys(toSave).length) {
    saveToEnvFile(toSave);
    console.log("Guardado en .env.\n");
  }
}
