// import-contacts.mjs — Importador de contactos a Chatwoot
//
// Uso:
//   node import-contacts.mjs                  -> abre el menú interactivo
//   node import-contacts.mjs contactos.csv     -> importa ese archivo directo (sin menú, para automatizar)
//   node import-contacts.mjs contactos.vcf     -> también acepta vCard (.vcf), export de celular
//   node import-contacts.mjs https://.../c.csv -> también acepta una URL
//
// Configuración: si falta CHATWOOT_TOKEN, CHATWOOT_ACCOUNT_ID o CHATWOOT_BASE_URL
// (en .env o como variable de entorno), el script los pregunta por consola y los
// guarda en .env para la próxima vez.
//
// CSV esperado (encabezados en cualquier orden, todos opcionales excepto name o first_name/last_name):
//   first_name, last_name, email, phone_number, city, country,
//   bio, company_name, linkedin, facebook, instagram, telegram, tiktok, twitter, github
//
// - El CSV se lee como UTF-8 si es válido; si no (ej. exportado como Latin-1/Windows-1252
//   desde Excel), se decodifica automáticamente como Latin-1 para no corromper acentos (Ç, Ã, etc.).
// - phone_number: acepta E.164 y usa DEFAULT_COUNTRY_CODE para números nacionales.
//   Con +55 conserva validaciones adicionales del plan brasileño (DDD real + celular de
//   11 dígitos con 9, o línea fija de 10). Números que ya traen + se respetan tal cual.
// - Si el número no es usable:
//     · es un servicio de la operadora ("Siga me" 21100, TIM 144, 0800...) -> NO se sube
//     · cualquier otro caso (mal escrito, truncado) -> se crea SIN teléfono y queda en
//       sin-telefono.json para arreglarlo a mano. En un .vcf casi nadie tiene email, así
//       que descartar por número ilegible perdería personas reales.
// - Los contactos que se suben sin teléfono se buscan antes por email y por nombre, con
//   coincidencia EXACTA, para no duplicar ni pisar la ficha de otro al re-correr.
// - PLACEHOLDER_NAMES (ej. "CONSUMIDOR", "TESTE") se excluyen del import y quedan en excluidos.json.
// - Si el mismo teléfono aparece dos veces en el CSV (ej. familiares compartiendo un fijo), la
//   segunda fila se crea sin teléfono. Si el teléfono ya existía en Chatwoot de una corrida
//   anterior, se actualiza (PUT) ese contacto en vez de fallar.
// - Los reportes (errores/sin-telefono/excluidos/telefonos-reconstruidos) se borran al empezar
//   cada corrida y se van acumulando entre lotes, así reflejan esta corrida y solo esta.
//
// VCF (vCard 2.1/3.0, típico export de Android/iPhone): no trae ciudad, así que al importar
// un .vcf el script pregunta la ciudad (y el país) una vez y los aplica a TODO el archivo.
// Cada agenda es de una unidad distinta, así que estar en el archivo es la prueba de a qué
// ciudad pertenece el contacto: la ciudad se corrige incluso en los que YA existen en
// Chatwoot con otra. Al actualizar se fusionan los atributos existentes, así no se pierde
// nada de lo que el contacto ya tuviera cargado; los cambios quedan en ciudad-actualizada.json.
// Un contacto vCard con varios TEL usa el que mejor valida (prefiere el que vino completo y
// el celular). Contactos sin ningún TEL ni EMAIL (solo nombre, ej. "favoritos" del celular)
// se saltean automáticamente.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync"; // npm i csv-parse

// El .env es COMPARTIDO por todo el programa: vive en la raíz (junto a run.bat)
const ENV_PATH = new URL("../../.env", import.meta.url);

// Carpeta de entrada: el usuario deja ahí su .vcf o .csv y se ofrece solo
const DROP_DIR = fileURLToPath(new URL("../../PLACE-HERE-2-CONTACTS", import.meta.url));

try {
  process.loadEnvFile(ENV_PATH);
} catch {
  // .env no existe: seguimos con variables de entorno ya definidas en la shell (export/set/$env:)
}

// ---------- Entrada de consola ----------

// Una sola interfaz readline reutilizada entre preguntas: crear y cerrar una nueva en cada
// pregunta puede perder líneas de entrada ya bufferizadas (ej. cuando llegan varias respuestas
// juntas), dejando preguntas posteriores sin nada que leer. Se cierra solo antes de un prompt
// oculto (para que el modo raw tenga control exclusivo de stdin) y al final de main().
let sharedRl = null;

function getSharedRl() {
  if (!sharedRl) {
    sharedRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return sharedRl;
}

function closeSharedRl() {
  if (sharedRl) {
    sharedRl.close();
    sharedRl = null;
  }
}

async function promptVisible(question) {
  // node:readline/promises' question() puede colgarse en la 2da pregunta seguida cuando
  // stdin es un pipe no interactivo (visto en Node 24 / Windows) — el readline clásico
  // con callback no tiene ese problema, así que se envuelve a mano en una Promise.
  return new Promise((resolve) => getSharedRl().question(question, resolve));
}

// Códigos de byte de teclas especiales (más portable/legible que caracteres de control literales).
const KEY_ENTER = [10, 13]; // \n, \r
const KEY_CTRL_C = 3;
const KEY_BACKSPACE = [8, 127]; // backspace, DEL

function promptHidden(question) {
  closeSharedRl(); // libera stdin para leerlo en modo raw sin que el readline compartido interfiera
  return new Promise((resolve) => {
    const { stdin } = process;
    process.stdout.write(question);
    let value = "";

    const onData = (chunk) => {
      const code = chunk[0];

      if (KEY_ENTER.includes(code)) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(value);
      } else if (code === KEY_CTRL_C) {
        process.stdout.write("\n");
        process.exit(1);
      } else if (KEY_BACKSPACE.includes(code)) {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else {
        value += chunk.toString("utf8");
        process.stdout.write("*");
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

// ---------- Configuración (.env) ----------

// Un "#" sin comillas corta el valor al releer el .env (process.loadEnvFile lo trata
// como comentario) — ej. un token que contenga "#". Se escribe entre comillas en esos
// casos; loadEnvFile las quita solo. (Mismo criterio que lib/config.mjs.)
function envSerialize(value) {
  const s = String(value);
  return s.includes("#") || /^\s|\s$/.test(s) ? `"${s}"` : s;
}

function saveToEnvFile(newValues) {
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
}

// Si el usuario pega la URL completa del panel en vez de solo el account id, o pega una
// URL con ruta en vez del origin, esto lo corrige solo en vez de guardar el dato roto.
function sanitizeAccountId(raw) {
  const fromUrl = raw.match(/\/accounts\/(\d+)/);
  if (fromUrl) return fromUrl[1];
  const digits = raw.match(/\d+/);
  return digits ? digits[0] : raw.trim();
}

function sanitizeBaseUrl(raw) {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return `${url.protocol}//${url.host}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

const CONFIG_FIELDS = [
  {
    key: "CHATWOOT_BASE_URL",
    question: "Chatwoot base URL (for example, https://chatwoot.example.com): ",
    sanitize: sanitizeBaseUrl,
  },
  {
    key: "CHATWOOT_ACCOUNT_ID",
    question: "Chatwoot account ID — number only (shown in /app/accounts/{id}/...): ",
    sanitize: sanitizeAccountId,
  },
  {
    key: "CHATWOOT_TOKEN",
    question: "Chatwoot access token (Profile > Access Token): ",
    secret: true,
  },
];

async function ensureConfig() {
  const missing = CONFIG_FIELDS.filter((f) => !process.env[f.key]);
  if (!missing.length) return;

  if (!process.stdin.isTTY) {
    console.error(
      `Missing configuration: ${missing.map((f) => f.key).join(", ")}.\n` +
      "No interactive terminal is available. Complete .env (see .env.example) or define the environment variables."
    );
    process.exit(1);
  }

  console.log("Chatwoot configuration is incomplete. Your answers will be saved in .env.\n");

  const toSave = {};
  for (const field of missing) {
    const raw = field.secret ? await promptHidden(field.question) : await promptVisible(field.question);
    const trimmed = raw.trim();
    if (!trimmed) {
      console.error(`${field.key} is required.`);
      process.exit(1);
    }
    const value = field.sanitize ? field.sanitize(trimmed) : trimmed;
    process.env[field.key] = value;
    toSave[field.key] = value;
  }

  saveToEnvFile(toSave);
  console.log("\nSaved in .env.\n");
}

async function reconfigure() {
  console.log("\nCurrent configuration:");
  console.log(`  CHATWOOT_BASE_URL   = ${process.env.CHATWOOT_BASE_URL || "(not set)"}`);
  console.log(`  CHATWOOT_ACCOUNT_ID = ${process.env.CHATWOOT_ACCOUNT_ID || "(not set)"}`);
  console.log(`  CHATWOOT_TOKEN      = ${process.env.CHATWOOT_TOKEN ? "********" : "(not set)"}\n`);

  const toSave = {};
  for (const field of CONFIG_FIELDS) {
    const label = `${field.question}(Enter = keep current value) `;
    const raw = field.secret ? await promptHidden(label) : await promptVisible(label);
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const value = field.sanitize ? field.sanitize(trimmed) : trimmed;
    process.env[field.key] = value;
    toSave[field.key] = value;
  }

  if (Object.keys(toSave).length) {
    saveToEnvFile(toSave);
    console.log("\nConfiguration updated in .env.\n");
  } else {
    console.log("\nNo changes.\n");
  }
}

// ---------- Lectura de CSV ----------

// Lista los archivos importables que el usuario dejó en PLACE-HERE-2-CONTACTS.
// También detecta Excel sin convertir para avisar (el importador lee CSV, no .xlsx).
function listFilesIn(dir) {
  try {
    const all = fs.readdirSync(dir);
    return {
      usable: all.filter((f) => /\.(vcf|csv)$/i.test(f)).sort().map((f) => path.join(dir, f)),
      excel: all.filter((f) => /\.xlsx?$/i.test(f)),
    };
  } catch {
    return { usable: [], excel: [] };
  }
}

function listDropFiles() {
  return listFilesIn(DROP_DIR);
}

async function resolveCsvSource(promptText) {
  // Primero ofrece lo que haya en la carpeta de entrada (elegible por número);
  // si no hay nada, pide la ruta y la valida: si no existe, avisa y la vuelve a
  // pedir (en vez de tirar un error críptico más adelante). Las URLs se validan
  // al descargar.
  //
  // Además de un archivo, se puede pegar una CARPETA: las agendas suelen vivir
  // juntas y separadas por unidad (sucursal-a.csv, sucursal-b.csv,
  // sucursal-c.csv en la misma carpeta), y obligar a copiarlas
  // de a una a PLACE-HERE-2 es un paso al pedo — se listan ahí mismo y se elige.
  let carpeta = DROP_DIR;

  while (true) {
    const esDrop = carpeta === DROP_DIR;
    const donde = esDrop ? "PLACE-HERE-2-CONTACTS" : carpeta;
    const drop = listFilesIn(carpeta);

    if (drop.excel.length) {
      console.log(
        `\nExcel files were found in ${donde} (${drop.excel.join(", ")}); the importer cannot read .xlsx.` +
        "\nOpen each file in Excel and save it as CSV (File > Save As > CSV) in the same folder."
      );
    }
    if (drop.usable.length) {
      console.log(`\nFiles found in ${donde}:`);
      drop.usable.forEach((p, i) => console.log(`  ${i + 1}) ${path.basename(p)}`));
    } else if (!esDrop) {
      console.log(`\nNo .csv or .vcf files were found in ${donde}.`);
    }

    const label = drop.usable.length
      ? `${promptText} — list number, another path/URL, or Enter = 1: `
      : `${promptText} (file path, FOLDER path, or URL — or place it in PLACE-HERE-2-CONTACTS): `;

    // Windows a veces pega la ruta entre comillas al usar "Copiar como ruta de acceso".
    const answer = (await promptVisible(label)).trim().replace(/^"(.*)"$/, "$1");

    if (!answer && drop.usable.length) return drop.usable[0];
    if (/^\d+$/.test(answer) && drop.usable[Number(answer) - 1]) return drop.usable[Number(answer) - 1];
    if (/^https?:\/\//i.test(answer)) return answer;

    if (answer && fs.existsSync(answer)) {
      // Si es carpeta, no se puede importar: se pasa a listar SU contenido y se
      // vuelve a preguntar (así se elige por número, igual que en PLACE-HERE-2).
      let esCarpeta = false;
      try { esCarpeta = fs.statSync(answer).isDirectory(); } catch {}
      if (!esCarpeta) return answer;
      carpeta = answer;
      continue;
    }

    console.log(`\nNot found: ${answer || "(empty)"}`);
    console.log(
      `Copy your .vcf or .csv file to ${DROP_DIR}\n` +
      "or enter the full file path (for example, C:\\Backup\\WhatsApp\\contacts.vcf),\n" +
      "or enter its folder (for example, C:\\Contacts) and choose from the list.\n"
    );
  }
}

// Decodifica como UTF-8 si es válido; si no (CSV exportado como Latin-1/Windows-1252 desde
// Excel, típico con nombres con Ç/Ã/Á), cae a Latin-1 en vez de corromper los acentos.
function decodeCsvBuffer(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("latin1").decode(buffer);
  }
}

async function readCsvSource(source) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Could not download the CSV (${res.status})`);
    return decodeCsvBuffer(Buffer.from(await res.arrayBuffer()));
  }
  return decodeCsvBuffer(fs.readFileSync(source));
}

// ---------- Lectura de VCF (vCard) ----------

// Decodifica una propiedad codificada en Quoted-Printable (ej. "=4D=69=6C"), común en vCard
// 2.1 exportado de Android/iPhone para nombres con acentos o emoji. charset default UTF-8.
function decodeQuotedPrintable(value, charset = "utf-8") {
  const bytes = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(value.charCodeAt(i));
    }
  }
  try {
    return new TextDecoder(charset).decode(Uint8Array.from(bytes));
  } catch {
    return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
  }
}

function parseVcfProperty(line) {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return null;
  const propPart = line.slice(0, colonIdx);
  let value = line.slice(colonIdx + 1);
  const [name, ...params] = propPart.split(";");

  if (params.some((p) => /^ENCODING=QUOTED-PRINTABLE$/i.test(p))) {
    const charsetParam = params.find((p) => /^CHARSET=/i.test(p));
    value = decodeQuotedPrintable(value, charsetParam ? charsetParam.split("=")[1] : "utf-8");
  }

  return { name: name.toUpperCase(), params, value };
}

// Junta líneas: primero el "unfolding" estándar de vCard (línea siguiente que arranca con
// espacio/tab es continuación), después los saltos de línea "blandos" de Quoted-Printable
// (línea que termina en "=" dentro de una propiedad ENCODING=QUOTED-PRINTABLE).
function joinVcfLines(text) {
  const raw = text.split(/\r\n|\r|\n/);
  const unfolded = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }

  const merged = [];
  for (const line of unfolded) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && /ENCODING=QUOTED-PRINTABLE/i.test(prev) && prev.endsWith("=")) {
      merged[merged.length - 1] = prev.slice(0, -1) + line;
    } else {
      merged.push(line);
    }
  }
  return merged;
}

// Quita emojis/pictogramas de un nombre (comunes en contactos de celular, ej. "María 🌸").
function stripEmoji(str) {
  return str
    .replace(/[\u{1F1E6}-\u{1FFFF}]/gu, "") // emoji, símbolos, banderas
    .replace(/[☀-➿]/gu, "") // misc symbols & dingbats
    .replace(/[\u{FE0F}\u{200D}]/gu, "") // variation selector, zero-width joiner
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Los contactos de celular de Brasil a veces guardan el número sin el DDD (2 dígitos, ej.
// "44"), o incluso sin el DDD y sin el "9" que se agregó a todos los celulares en 2016.
//
// El primer dígito dice de qué tipo de línea se trata, y hay que respetarlo:
//   8 dígitos que empiezan con 2-5  -> FIJO ("3521-5000")  -> solo falta el DDD
//   8 dígitos que empiezan con 6-9  -> celular viejo        -> faltan el DDD y el 9
//   9 dígitos                        -> celular actual      -> solo falta el DDD
// Agregar un "9" a TODO número de 8 dígitos convertiría líneas fijas en celulares
// inexistentes y podría hacer que un número fabricado gane sobre el número verdadero.
// Otras longitudes se dejan tal cual (ya vienen completas, o son basura que la validación
// posterior va a rechazar igual).
function reconstructVcfPhone(raw, assumedAreaCode, defaultCountryCode) {
  if (defaultCountryCode.replace(/\D/g, "") !== "55" || !assumedAreaCode) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 9) return `${assumedAreaCode}${digits}`;
  if (digits.length === 8) {
    return /^[2-5]/.test(digits)
      ? `${assumedAreaCode}${digits}`      // fijo: DDD + 8 dígitos
      : `${assumedAreaCode}9${digits}`;    // celular viejo: DDD + 9 + 8 dígitos
  }
  return raw;
}

// Convierte un bloque BEGIN:VCARD..END:VCARD ya "desdoblado" en una fila del mismo formato
// que usan las filas de CSV, o null si no tiene nada útil para importar (ni TEL ni EMAIL).
function vcfBlockToRow(lines, defaultCountryCode, assumedAreaCode) {
  let fn = "";
  const telValues = [];
  const emailValues = [];
  let org = "";
  let note = "";

  for (const line of lines) {
    const prop = parseVcfProperty(line);
    if (!prop) continue;
    if (prop.name === "FN" && !fn) fn = prop.value.trim();
    else if (prop.name === "TEL" && prop.value.trim()) telValues.push(prop.value.trim());
    else if (prop.name === "EMAIL" && prop.value.trim()) emailValues.push(prop.value.trim());
    else if (prop.name === "ORG" && prop.value.trim() && !org) {
      // ORG puede traer "Empresa;Departamento" — se unen con coma en vez del ";" literal.
      org = prop.value.split(";").map((s) => s.trim()).filter(Boolean).join(", ");
    }
    else if (prop.name === "NOTE" && prop.value.trim() && !note) note = prop.value.trim();
  }

  const name = stripEmoji(fn) || emailValues[0] || "";

  if (!telValues.length && !emailValues.length) {
    return { row: null, skip: { nombre: name || "(unnamed)", motivo: "vCard has no phone number or email" } };
  }

  // Si hay varios TEL (típico: el mismo número duplicado con/sin el 9 del celular, o el
  // fijo y el celular de la misma persona), se elige por prioridad:
  //   1. que valide
  //   2. que haya venido COMPLETO en la agenda (no reconstruido a fuerza de suponer el DDD)
  //   3. que sea celular (WhatsApp vive ahí; un fijo no sirve para conversar)
  //   4. el más largo/completo
  // El punto 2 importa: un fijo al que le adivinamos el DDD no debe ganarle al celular
  // real que estaba en la misma ficha.
  let bestRaw = "";
  let bestCandidate = "";
  let bestScore = -1;
  for (const raw of telValues) {
    const candidate = reconstructVcfPhone(raw, assumedAreaCode, defaultCountryCode);
    const check = normalizePhone(candidate, defaultCountryCode);
    const countryLength = defaultCountryCode.replace(/\D/g, "").length;
    const nacional = check.value ? check.value.replace(/\D/g, "").slice(countryLength) : "";
    const score =
      (check.value ? 10000 : 0) +
      (candidate === raw ? 1000 : 0) +               // vino completo, no lo adivinamos
      (nacional.length === 11 && nacional[2] === "9" ? 100 : 0) + // es celular
      (check.value ? check.value.length : 0);
    if (score > bestScore) {
      bestScore = score;
      bestRaw = raw;
      bestCandidate = candidate;
    }
  }

  const reconstruido = bestCandidate !== bestRaw ? { original: bestRaw, reconstruido: bestCandidate } : null;

  return {
    row: {
      name,
      email: emailValues[0] || "",
      phone_number: bestCandidate,
      company_name: org,
      bio: note,
    },
    skip: null,
    reconstruido: reconstruido ? { nombre: name || "(unnamed)", ...reconstruido } : null,
  };
}

function parseVcf(text, defaultCountryCode, assumedAreaCode) {
  const lines = joinVcfLines(text);
  const rows = [];
  const skipped = [];
  const reconstruidos = [];

  let current = null;
  const flush = () => {
    if (!current) return;
    const { row, skip, reconstruido } = vcfBlockToRow(current, defaultCountryCode, assumedAreaCode);
    if (row) rows.push(row);
    else if (skip) skipped.push(skip);
    if (reconstruido) reconstruidos.push(reconstruido);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^BEGIN:VCARD$/i.test(trimmed)) {
      current = [];
    } else if (/^END:VCARD$/i.test(trimmed)) {
      flush();
      current = null;
    } else if (current) {
      current.push(line);
    }
  }
  // Archivo cortado sin END:VCARD final (visto en exports reales) — igual procesamos lo que haya.
  flush();

  return { rows, skipped, reconstruidos };
}

// Pide una vez ciudad/país/empresa/DDD para aplicar a TODO el archivo VCF (que no trae esos
// campos). Recuerda la última respuesta en .env — Enter para reusarla.
async function promptWithSavedDefault(envKey, question) {
  const saved = process.env[envKey] || "";
  // Sin consola interactiva (corrida automatizada: node import-contacts.mjs archivo.vcf)
  // no hay a quién preguntarle: se usa lo que haya guardado en .env en vez de quedarse
  // esperando una respuesta que nunca llega.
  if (!process.stdin.isTTY) {
    if (saved) console.log(`${question}: ${saved} (from .env; no interactive terminal)`);
    return saved;
  }
  const label = saved ? `${question} (Enter = "${saved}"): ` : `${question}: `;
  const input = (await promptVisible(label)).trim();
  const value = input || saved;
  if (input && input !== saved) {
    process.env[envKey] = input;
    saveToEnvFile({ [envKey]: input });
  }
  return value;
}

// La ciudad se escribe SIEMPRE a mano, a propósito: cada agenda es de una unidad distinta
// (sucursal A, sucursal B, sucursal C...) y ofrecer la última respuesta con Enter haría que un
// Enter distraído marcara todo un archivo con la ciudad del anterior — que es justamente
// el error que este campo viene a corregir. La anterior se muestra solo como referencia.
async function promptCiudad() {
  const anterior = process.env.DEFAULT_CITY || "";

  if (!process.stdin.isTTY) {
    if (anterior) console.log(`City: ${anterior} (from .env; no interactive terminal)`);
    return anterior;
  }

  console.log("\nCity for every contact in this file.");
  console.log("It is assigned to new contacts and corrects existing Chatwoot contacts.");
  if (anterior) console.log(`  (last imported city: ${anterior})`);

  const input = (await promptVisible('City — enter the full name, or "-" to leave city unchanged: ')).trim();
  if (input === "-" || input === "") return "";

  if (input !== anterior) {
    process.env.DEFAULT_CITY = input;
    saveToEnvFile({ DEFAULT_CITY: input });
  }
  return input;
}

async function promptVcfDefaults(defaultCountryCode) {
  // Un .vcf no trae ciudad: se pregunta una vez y se aplica a TODO el archivo. La agenda
  // de cada unidad se exporta por separado, así que estar en este archivo ES la prueba de
  // a qué ciudad pertenece el contacto — por eso la ciudad se pisa aunque el contacto ya
  // exista en Chatwoot con otra (ver aplicarCiudad en el import).
  console.log("\nOnly name, phone number, and city are imported.");
  const isBrazil = defaultCountryCode.replace(/\D/g, "") === "55";
  let areaCode = "";
  if (isBrazil) {
    console.log("Brazilian numbers without +55 receive it automatically. Enter the area code used when DDD is missing:");
    areaCode = await promptWithSavedDefault(
      "DEFAULT_AREA_CODE",
      "Area code (DDD) for phone numbers without one (Enter = 44)"
    ) || "44";
  } else {
    console.log(`National numbers without a prefix will use ${defaultCountryCode}.`);
  }

  const city = await promptCiudad();
  const country = city
    ? await promptWithSavedDefault(
      "DEFAULT_COUNTRY",
      isBrazil ? "Country (Enter = BR)" : "Country (ISO code, Enter = leave unset)"
    ) || (isBrazil ? "BR" : "")
    : "";

  if (city) console.log(`\nContacts will be marked as: ${city}${country ? ` (${country})` : ""}`);
  console.log("");
  return { areaCode, city, country, company: "" };
}

async function loadRows(source) {
  const isVcf = /\.vcf($|\?)/i.test(source);
  console.log(`\nLoading ${isVcf ? "VCF" : "CSV"} from: ${source}`);

  if (isVcf) {
    const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || "+55";
    const { areaCode, city, country, company } = await promptVcfDefaults(DEFAULT_COUNTRY_CODE);
    const text = await readCsvSource(source);
    const { rows, skipped, reconstruidos } = parseVcf(text, DEFAULT_COUNTRY_CODE, areaCode);

    if (reconstruidos.length) {
      fs.writeFileSync("telefonos-reconstruidos.json", JSON.stringify(reconstruidos, null, 2));
      console.log(
        `${reconstruidos.length} phone number(s) reconstructed with area code ${areaCode} ` +
        "(and a mobile 9 when required). Review telefonos-reconstruidos.json."
      );
    }
    if (skipped.length) {
      console.log(`${skipped.length} contact(s) have no phone number or email and will be skipped. See excluidos.json.`);
    }

    const rowsConDefaults = rows.map((r) => ({
      ...r,
      city: city || r.city,
      country: country || r.country,
      company_name: company || r.company_name,
    }));
    return { rows: rowsConDefaults, skipped };
  }

  const text = await readCsvSource(source);
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
  return { rows, skipped: [] };
}

// ---------- Construcción de payload ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Nombres que no son contactos reales (genéricos / de prueba) — se excluyen del import.
const PLACEHOLDER_NAMES = new Set(["CONSUMIDOR", "TESTE", "TEST", "SEM NOME", "CLIENTE"]);

// DDDs que existen de verdad en Brasil (Anatel). Sirven para distinguir un teléfono
// de un código de servicio o un 0800: "80" nunca fue un DDD.
const DDD_VALIDOS = new Set([
  "11", "12", "13", "14", "15", "16", "17", "18", "19",
  "21", "22", "24", "27", "28",
  "31", "32", "33", "34", "35", "37", "38",
  "41", "42", "43", "44", "45", "46", "47", "48", "49",
  "51", "53", "54", "55",
  "61", "62", "63", "64", "65", "66", "67", "68", "69",
  "71", "73", "74", "75", "77", "79",
  "81", "82", "83", "84", "85", "86", "87", "88", "89",
  "91", "92", "93", "94", "95", "96", "97", "98", "99",
]);

// Devuelve { value } si el teléfono es válido, o { invalidReason } si no se puede usar.
function normalizePhone(raw, defaultCountryCode) {
  if (!raw || !raw.trim()) return { invalidReason: "empty value" };
  const trimmed = raw.trim();

  // Excel convierte números largos a notación científica al exportar a CSV (ej. 5.545E+12),
  // truncando los dígitos reales — irrecuperable desde el CSV.
  if (/\d[eE]\+?\d+$/.test(trimmed)) {
    return { invalidReason: `notación científica de Excel, dígitos perdidos (${trimmed})` };
  }

  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return { invalidReason: `contains no digits (${trimmed})` };

  const countryDigits = defaultCountryCode.replace(/\D/g, "");

  // Cualquier número que ya esté en formato internacional (+ o prefijo 00) se
  // respeta sin importar el país.
  if (trimmed.startsWith("+") || /^00/.test(trimmed.replace(/[\s().-]/g, ""))) {
    const internationalDigits = trimmed.startsWith("+") ? digits : digits.replace(/^00/, "");
    return /^[1-9]\d{7,14}$/.test(internationalDigits)
      ? { value: `+${internationalDigits}` }
      : { invalidReason: `invalid international number (${trimmed})` };
  }

  // Fuera de Brasil no inventamos reglas nacionales: quitamos el cero de troncal,
  // anteponemos el código configurado y validamos solamente el largo E.164. Si el
  // país. Los números internacionales deben venir con + o 00 para evitar la
  // ambigüedad entre un código de país y los primeros dígitos de un número local.
  if (countryDigits !== "55") {
    const withoutTrunk = digits.replace(/^0+/, "");
    const international = `${countryDigits}${withoutTrunk}`;
    return /^[1-9]\d{7,14}$/.test(international)
      ? { value: `+${international}` }
      : { invalidReason: `not a valid E.164 phone number (${trimmed})` };
  }

  // Un nacional válido es DDD real + número de línea:
  //   11 dígitos -> celular: el dígito después del DDD es siempre 9
  //   10 dígitos -> fijo (2-5) o celular viejo sin el 9 (6-9); nunca 0 ni 1
  // Con esto los códigos de servicio (21100, 2020, 1010, 50050) y los 0800/0300
  // quedan afuera: "80" no es un DDD que exista.
  const esNacional = (d) => {
    if (d.length !== 10 && d.length !== 11) return false;
    if (!DDD_VALIDOS.has(d.slice(0, 2))) return false;
    return d.length === 11 ? d[2] === "9" : /[2-9]/.test(d[2]);
  };

  // Se prueba el número tal cual y también sin el "0" de troncal (forma común de
  // agendar en Brasil: "044 997-478670"), en ambos casos con o sin código de país.
  let national = null;
  for (const cand of [digits, digits.replace(/^0+/, "")]) {
    if (esNacional(cand)) {
      national = cand;
      break;
    }
    if (cand.startsWith(countryDigits) && esNacional(cand.slice(countryDigits.length))) {
      national = cand.slice(countryDigits.length);
      break;
    }
  }

  if (!national) {
    return { invalidReason: `not a valid phone number: ${digits.length} digits (${trimmed})` };
  }

  return { value: `${defaultCountryCode}${national}` };
}

// Servicios de la operadora y números de emergencia que vienen grabados en el chip.
// No son personas: no tiene sentido crearles una ficha en Chatwoot.
//
// No alcanza con mirar el largo del número: una exportación puede dejar teléfonos
// truncados. Esas fichas pueden representar personas y hay que conservarlas sin teléfono.
// Por eso se pide número corto Y (código de 3 dígitos — ningún teléfono brasileño los
// tiene — O un nombre que delate al servicio).
const NOMBRES_DE_SERVICIO =
  /^(siga.?-?me|caixa.?postal|tim|vivo|claro|oi|nextel|meu.?plano|recarga|saldo|disque|central|policia|polícia|bombeiros?|ambul[aâ]ncia|defesa.?civil|samu)\b/i;

function esCodigoDeServicio(raw, nombre = "") {
  const d = String(raw || "").replace(/\D/g, "");
  if (!d) return false;
  // 0800 / 0300 / 0500 / 3003 / 4004: atención al cliente de empresas
  if (/^0?(800|300|500|3003|4004)/.test(d)) return true;
  if (d.length > 7) return false;
  // el "1" final que agregan algunas agendas al copiar del chip: "TIM1", "Caixa Postal1"
  const limpio = String(nombre || "").trim().replace(/\s*\d+$/, "");
  return d.length === 3 || NOMBRES_DE_SERVICIO.test(limpio);
}

function buildSocialProfiles(row) {
  const fields = ["linkedin", "facebook", "instagram", "telegram", "tiktok", "twitter", "github"];
  const social = {};
  for (const f of fields) {
    if (row[f]) social[f] = row[f];
  }
  return Object.keys(social).length ? social : undefined;
}

function buildPayload(row, phoneValue) {
  const name = row.name || [row.first_name, row.last_name].filter(Boolean).join(" ").trim();

  const additional_attributes = {
    city: row.city || undefined,
    country: row.country || undefined,
    description: row.bio || undefined,
    company_name: row.company_name || undefined,
    social_profiles: buildSocialProfiles(row),
  };

  Object.keys(additional_attributes).forEach(
    (k) => additional_attributes[k] === undefined && delete additional_attributes[k]
  );

  return {
    name: name || undefined,
    email: row.email || undefined,
    phone_number: phoneValue,
    additional_attributes,
  };
}

// ---------- Generar .vcf de nombres (para el export del módulo 1) ----------

// `wa_archive.py --contacts` le pone nombre a los chats del export, pero su parser
// SOLO entiende vCard (load_contacts -> ContactIndex.from_vcf): no lee CSV. Las
// agendas completas suelen estar en CSV (name/phone_number/city), así que esto
// las convierte a un .vcf mínimo — nombre y teléfono, nada más — para poder usarlas
// ahí. No importa nada a Chatwoot: solo escribe un archivo local.
function escapeVcf(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/([,;])/g, "\\$1");
}

async function generarVcfDeNombres(source) {
  if (/\.vcf($|\?)/i.test(source)) {
    console.log("This is already a .vcf file. Use it directly in module 1; no conversion is needed.");
    return;
  }

  const text = await readCsvSource(source);
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || "+55";

  const porTelefono = new Map();
  const conflictos = [];
  let sinNombre = 0;
  let telefonoInvalido = 0;

  for (const row of rows) {
    const nombre = (row.name || [row.first_name, row.last_name].filter(Boolean).join(" ")).trim();
    if (!nombre) { sinNombre++; continue; }

    const check = normalizePhone(row.phone_number, DEFAULT_COUNTRY_CODE);
    if (!check.value) { telefonoInvalido++; continue; }

    // Gana el primero. Si el mismo número aparece con dos nombres distintos no se
    // inventa un ganador: se anota el caso para revisarlo a mano, que es justo el
    // tipo de duda que no conviene resolver sola.
    const previo = porTelefono.get(check.value);
    if (previo === undefined) porTelefono.set(check.value, nombre);
    else if (previo.toUpperCase() !== nombre.toUpperCase()) {
      conflictos.push({ telefono: check.value, se_uso: previo, tambien_aparece: nombre });
    }
  }

  const lineas = [];
  for (const [telefono, nombre] of porTelefono) {
    lineas.push(
      "BEGIN:VCARD",
      "VERSION:3.0",
      `FN:${escapeVcf(nombre)}`,
      `N:${escapeVcf(nombre)};;;;`,
      `TEL;TYPE=CELL:${telefono}`,
      "END:VCARD"
    );
  }

  const base = path.basename(source).replace(/\.[^.]+$/, "");
  const destino = path.join(DROP_DIR, `${base}-nombres.vcf`);
  fs.writeFileSync(destino, lineas.join("\r\n") + "\r\n", "utf8");

  console.log(`\n${porTelefono.size} contact(s) written to:`);
  console.log(`  ${destino}`);
  if (sinNombre) console.log(`  (${sinNombre} unnamed row(s) skipped)`);
  if (telefonoInvalido) console.log(`  (${telefonoInvalido} row(s) with invalid phone numbers skipped)`);
  if (conflictos.length) {
    appendReporte("nombres-en-conflicto.json", conflictos, "  Number(s) assigned to more than one name");
  }
  console.log("\nTo use this file when exporting chats (module 1):");
  console.log(`  python modules/backup/wa_archive.py export --contacts "${destino}"`);
  console.log("The wizard also detects it automatically in PLACE-HERE-2-CONTACTS.");
}

// ---------- Reportes de la corrida ----------

const ARCHIVOS_REPORTE = [
  "errores.json", "sin-telefono.json", "excluidos.json", "telefonos-reconstruidos.json",
  "ciudad-actualizada.json", "atributos-no-leidos.json",
];

// Al arrancar una corrida se borran los reportes viejos: si no, un archivo de una corrida
// anterior (o de la muestra de prueba) queda en disco y la opción 3 lo muestra como si
// fuera de esta.
function resetReportes() {
  for (const f of ARCHIVOS_REPORTE) {
    try { fs.unlinkSync(f); } catch {}
  }
}

// Suma al reporte en vez de pisarlo (la corrida de la muestra y la del resto son dos
// llamadas distintas y las dos tienen cosas que contar).
function appendReporte(archivo, items, etiqueta) {
  if (!items.length) return;
  let previos = [];
  try {
    previos = JSON.parse(fs.readFileSync(archivo, "utf8"));
    if (!Array.isArray(previos)) previos = [];
  } catch {}
  const total = [...previos, ...items];
  fs.writeFileSync(archivo, JSON.stringify(total, null, 2));
  console.log(`${etiqueta} in ${archivo} (${total.length})`);
}

// ---------- Import ----------

function chatwootClient() {
  const BASE_URL = process.env.CHATWOOT_BASE_URL;
  const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
  const TOKEN = process.env.CHATWOOT_TOKEN;

  // Reintenta ante 429 (límite de tasa) o errores 5xx en vez de tratarlos como respuesta
  // definitiva — importante en lotes grandes, donde un 429 tratado como "no existe" puede
  // llevar a crear un contacto duplicado en vez de actualizar el que ya existía.
  async function chatwootFetch(path, options, attempt = 1) {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        api_access_token: TOKEN,
        ...(options?.headers || {}),
      },
    });

    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 1000;
      await sleep(waitMs);
      return chatwootFetch(path, options, attempt + 1);
    }

    return res;
  }

  // Devuelven el CONTACTO entero, no solo el id: sus additional_attributes se necesitan
  // para actualizarlo sin borrarle lo que ya tenía (ver atributosFusionados).
  async function findExistingContact(query) {
    if (!query) return null;
    const res = await chatwootFetch(
      `/api/v1/accounts/${ACCOUNT_ID}/contacts/search?q=${encodeURIComponent(query)}`,
      { method: "GET" }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.payload?.[0] ?? null;
  }

  // Para contactos SIN teléfono válido no hay número por el cual buscar, así que se
  // busca por email o por nombre y se exige coincidencia EXACTA en ese campo: la
  // búsqueda de Chatwoot es parcial ("ana@example.com" también puede coincidir con
  // "otra.ana@example.com"), y quedarse con
  // el primer resultado haría un PUT sobre la ficha de otra persona. Evita además que
  // re-correr la prueba o el archivo cree el mismo contacto sin número una y otra vez.
  async function findByExactField(campo, valor) {
    const objetivo = String(valor || "").trim();
    if (!objetivo) return null;
    const res = await chatwootFetch(
      `/api/v1/accounts/${ACCOUNT_ID}/contacts/search?q=${encodeURIComponent(objetivo)}`,
      { method: "GET" }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const match = (data?.payload || []).find(
      (c) => String(c[campo] || "").trim().toLowerCase() === objetivo.toLowerCase()
    );
    return match ?? null;
  }

  // Atributos que el contacto tiene HOY en Chatwoot. Normalmente vienen en la respuesta de
  // la búsqueda (sin costo); si esa respuesta no los trae, se pide la ficha completa.
  // Devuelve null si no se pudieron averiguar: quien llama entonces NO manda el campo, para
  // no arriesgarse a pisar datos que no pudo leer.
  async function atributosActuales(contacto) {
    if (contacto?.additional_attributes && typeof contacto.additional_attributes === "object") {
      return contacto.additional_attributes;
    }
    const res = await chatwootFetch(
      `/api/v1/accounts/${ACCOUNT_ID}/contacts/${contacto.id}`,
      { method: "GET" }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const attrs = data?.payload?.additional_attributes;
    return attrs && typeof attrs === "object" ? attrs : {};
  }

  return { chatwootFetch, findExistingContact, findByExactField, atributosActuales, ACCOUNT_ID };
}

// entries: [{ row, fila }] — la fila ORIGINAL del archivo viaja con cada contacto,
// así la muestra aleatoria y los reportes (errores.json, sin-telefono.json...)
// siempre apuntan a la fila real aunque el orden de importación sea otro.
async function importRows(entries, preExcluidos = []) {
  const { chatwootFetch, findExistingContact, findByExactField, atributosActuales, ACCOUNT_ID } = chatwootClient();
  const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || "+55"; // Brasil, por defecto en el formulario

  let creados = 0;
  let actualizados = 0;
  const errores = [];
  const subidos = []; // lo que efectivamente entró a Chatwoot, con id para verificar
  const ciudadActualizada = []; // contactos que ya existían y les cambió la ciudad
  const atributosNoLeidos = []; // no se pudieron leer sus atributos: se los dejó intactos
  // placeholders (CSV) + vCards sin teléfono ni email: no se crean
  const excluidos = preExcluidos.map((s) => ({ nombre: s.nombre, motivo: s.motivo }));
  const sinTelefono = []; // se crean, pero sin teléfono válido o duplicado dentro del lote

  const telefonosUsadosEnEsteLote = new Set();

  for (const { row, fila } of entries) {
    const rawName = (row.name || [row.first_name, row.last_name].filter(Boolean).join(" ")).trim();

    if (PLACEHOLDER_NAMES.has(rawName.toUpperCase())) {
      excluidos.push({ fila, nombre: rawName, motivo: "placeholder name" });
      console.log(`- Row ${fila} (${rawName}): excluded (placeholder)`);
      continue;
    }

    const phoneCheck = normalizePhone(row.phone_number, DEFAULT_COUNTRY_CODE);
    let phoneValue = phoneCheck.value;
    let phoneSkipReason = phoneCheck.invalidReason;

    if (phoneValue && telefonosUsadosEnEsteLote.has(phoneValue)) {
      phoneSkipReason = "duplicate phone number in the CSV (already used by another contact in this run)";
      phoneValue = undefined;
    }

    const payload = buildPayload(row, phoneValue);
    const label = payload.name || row.email || row.phone_number || `row ${fila}`;

    // Códigos de servicio de la operadora que vienen en el chip ("Siga me CP ati" con
    // el 21100, atajos de 2-7 dígitos): no son personas, no se suben.
    //
    // Ojo con no pasarse de listo acá: en un .vcf de celular casi nadie tiene email, así
    // que excluir todo lo que no valide dejaría afuera a gente real con el número
    // simplemente mal escrito (un ramal pegado, dos números en el mismo campo, un dígito
    // de más). Esos SÍ se crean —sin teléfono— y quedan en sin-telefono.json para
    // arreglarlos a mano, que era el comportamiento de siempre.
    if (phoneSkipReason && esCodigoDeServicio(row.phone_number, rawName) && !row.email) {
      excluidos.push({ fila, nombre: label, telefono_original: row.phone_number || "", motivo: `carrier service code, not a contact (${row.phone_number})` });
      console.log(`- Row ${fila} (${label}): excluded (service code ${row.phone_number})`);
      continue;
    }

    if (phoneSkipReason) {
      sinTelefono.push({ fila, nombre: label, telefono_original: row.phone_number || "", motivo: phoneSkipReason });
    }

    try {
      // Primero exige coincidencia exacta E.164: esto funciona con cualquier país y evita
      // elegir el primer resultado parcial. Solo como compatibilidad para contactos viejos
      // del país predeterminado se intenta después una búsqueda sin código de país.
      let existente = null;
      if (phoneValue) {
        const countryDigits = DEFAULT_COUNTRY_CODE.replace(/\D/g, "");
        const phoneDigits = phoneValue.replace(/\D/g, "");
        existente = await findByExactField("phone_number", phoneValue);
        if (!existente && phoneDigits.startsWith(countryDigits)) {
          const nationalDigits = phoneDigits.slice(countryDigits.length);
          existente = await findExistingContact(nationalDigits);
        }
      } else {
        // Sin teléfono no hay número por el cual buscar: se busca por email y por
        // nombre, en ambos casos exigiendo coincidencia EXACTA — así re-correr la
        // prueba o el archivo no crea duplicados. La coincidencia exacta es
        // imprescindible: la búsqueda de Chatwoot es parcial, y quedarse con el primer
        // resultado haría un PUT sobre la ficha de otra persona (ej. "ana@example.com"
        // también puede traer "otra.ana@example.com").
        existente = await findByExactField("email", row.email);
        if (!existente) existente = await findByExactField("name", payload.name);
      }

      // Al ACTUALIZAR se manda el bloque de atributos completo y fusionado: lo que el
      // contacto ya tenía + lo que trae el archivo (ciudad/país). Sin esto, mandar solo lo
      // nuestro le borraría empresa, descripción y todo lo cargado a mano; y mandarlo
      // vacío —como hacía antes— se lo borraba TODO.
      async function payloadParaActualizar(contacto) {
        const actuales = await atributosActuales(contacto);
        if (actuales === null) {
          // no se pudieron leer: mejor no tocar los atributos que arriesgarse a pisarlos
          const { additional_attributes, ...resto } = payload;
          atributosNoLeidos.push({ fila, nombre: label, id: contacto.id });
          return resto;
        }
        const fusionados = { ...actuales, ...payload.additional_attributes };
        const ciudadAntes = actuales.city || "";
        const ciudadDespues = fusionados.city || "";
        if (ciudadDespues && ciudadAntes !== ciudadDespues) {
          ciudadActualizada.push({
            fila, nombre: label, telefono: phoneValue || null, id: contacto.id,
            ciudad_anterior: ciudadAntes || "(no city)", ciudad_nueva: ciudadDespues,
          });
        }
        return { ...payload, additional_attributes: fusionados };
      }

      let res = existente
        ? await chatwootFetch(`/api/v1/accounts/${ACCOUNT_ID}/contacts/${existente.id}`, {
            method: "PUT",
            body: JSON.stringify(await payloadParaActualizar(existente)),
          })
        : await chatwootFetch(`/api/v1/accounts/${ACCOUNT_ID}/contacts`, {
            method: "POST",
            body: JSON.stringify(payload),
          });

      if (!existente && res.status === 422) {
        // La búsqueda por teléfono no encontró nada, pero igual hay conflicto (ej. mismo email).
        const fallback = await findExistingContact(row.email || phoneValue);
        if (fallback) {
          existente = fallback;
          res = await chatwootFetch(`/api/v1/accounts/${ACCOUNT_ID}/contacts/${fallback.id}`, {
            method: "PUT",
            body: JSON.stringify(await payloadParaActualizar(fallback)),
          });
        }
      }
      const existingId = existente?.id ?? null;

      if (!res.ok) {
        const detalle = await res.text();
        errores.push({ fila, contacto: label, status: res.status, detalle });
        console.log(`✗ Row ${fila} (${label}): ${res.status}`);
      } else if (existingId) {
        actualizados++;
        if (phoneValue) telefonosUsadosEnEsteLote.add(phoneValue);
        subidos.push({ fila, nombre: label, telefono: phoneValue || null, id: existingId, accion: "updated" });
        console.log(`~ Row ${fila} (${label}${phoneValue ? `, ${phoneValue}` : ""}): updated (id ${existingId})${phoneSkipReason ? " [no phone number]" : ""}`);
      } else {
        creados++;
        // el id del contacto recién creado sale de la respuesta de la API — sirve para
        // armar el enlace directo a la ficha y verificar a ojo que subió bien
        let nuevoId = null;
        try {
          const data = await res.json();
          nuevoId = data?.payload?.contact?.id ?? data?.payload?.id ?? data?.id ?? null;
        } catch {}
        if (phoneValue) telefonosUsadosEnEsteLote.add(phoneValue);
        subidos.push({ fila, nombre: label, telefono: phoneValue || null, id: nuevoId, accion: "created" });
        console.log(`✓ Row ${fila} (${label}${phoneValue ? `, ${phoneValue}` : ""})${phoneSkipReason ? " [no phone number]" : ""}`);
      }
    } catch (e) {
      errores.push({ fila, contacto: label, detalle: String(e) });
      console.log(`✗ Row ${fila} (${label}): ${e}`);
    }

    await sleep(200); // evita saturar la instancia
  }

  console.log(
    `\nDone. Created: ${creados} | Updated: ${actualizados} | ` +
    `No valid phone number: ${sinTelefono.length} | Excluded: ${excluidos.length} | ` +
    `Errors: ${errores.length} / ${entries.length} rows in this batch.`
  );
  if (ciudadActualizada.length) {
    console.log(`City corrected for ${ciudadActualizada.length} existing contact(s).`);
  }

  // Los reportes se ACUMULAN: la opción 1 llama a importRows dos veces (muestra y resto),
  // y sobrescribir sin más borraba del reporte lo de la primera pasada — incluidos los
  // vCards sin teléfono ni email, que solo llegan en la muestra. resetReportes() los
  // limpia al empezar cada corrida, así nunca se mezclan dos corridas distintas.
  appendReporte("errores.json", errores, "Error details");
  appendReporte("sin-telefono.json", sinTelefono, "Contacts created without a valid phone number (review manually)");
  appendReporte("excluidos.json", excluidos, "Contacts not uploaded (placeholders and service codes)");
  appendReporte("ciudad-actualizada.json", ciudadActualizada, "Existing contacts whose city was corrected");
  appendReporte("atributos-no-leidos.json", atributosNoLeidos, "Contacts whose attributes could not be read (left unchanged)");

  return { creados, actualizados, sinTelefono: sinTelefono.length, excluidos: excluidos.length, errores: errores.length, subidos };
}

// Numera cada fila con su posición original en el archivo (1 = encabezado).
const conFilaOriginal = (rows) => rows.map((row, i) => ({ row, fila: i + 2 }));

async function runFullImport(source) {
  resetReportes();
  const { rows, skipped } = await loadRows(source);
  console.log(`${rows.length} row(s) found.\n`);
  await importRows(conFilaOriginal(rows), skipped);
}

// Muestra ALEATORIA para la prueba, con preferencia por contactos que van a subir
// con teléfono válido: probar siempre con las primeras filas del archivo tocaba
// justo los contactos de servicio del chip ("Siga me CP ati"). Al azar la muestra
// es representativa y distinta en cada corrida.
function elegirMuestraAleatoria(entries, n) {
  const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || "+55";
  const nombreDe = (row) =>
    (row.name || [row.first_name, row.last_name].filter(Boolean).join(" ")).trim();

  const importables = entries.filter((e) => !PLACEHOLDER_NAMES.has(nombreDe(e.row).toUpperCase()));
  const conTelefono = importables.filter(
    (e) => normalizePhone(e.row.phone_number, DEFAULT_COUNTRY_CODE).value
  );

  // Preferencia: con teléfono válido -> cualquiera importable -> el archivo entero
  // (último caso solo si TODO son placeholders, para no quedarse sin muestra).
  const pool = conTelefono.length >= n ? conTelefono
    : importables.length ? importables
    : entries;

  const elegidos = new Set();
  while (elegidos.size < Math.min(n, pool.length)) {
    elegidos.add(pool[Math.floor(Math.random() * pool.length)]);
  }
  return [...elegidos].sort((a, b) => a.fila - b.fila);
}

// Enlace directo a la ficha del contacto en Chatwoot, para verificar a ojo.
function linkContacto(id) {
  return `${process.env.CHATWOOT_BASE_URL}/app/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/contacts/${id}`;
}

function mostrarSubidos(subidos) {
  if (!subidos?.length) return;
  console.log("\nReview the test contacts by opening each link in your browser:");
  for (const s of subidos) {
    const detalle = s.telefono ? s.telefono : "no phone number";
    console.log(`  ${s.accion === "updated" ? "~" : "✓"} ${s.nombre} — ${detalle} (${s.accion})`);
    console.log(`    ${s.id ? linkContacto(s.id) : "(the response had no id; search by name in Contacts)"}`);
  }
}

async function runSampleThenMaybeFull(source, sampleSize = 2) {
  resetReportes();
  const { rows, skipped } = await loadRows(source);
  const entries = conFilaOriginal(rows);
  const sample = elegirMuestraAleatoria(entries, sampleSize);
  const enMuestra = new Set(sample);
  const resto = entries.filter((e) => !enMuestra.has(e));

  console.log(
    `${rows.length} total row(s). Testing ${sample.length} random contact(s) ` +
    `(row ${sample.map((e) => e.fila).join(" and row ")})...\n`
  );
  const resultado = await importRows(sample, skipped);
  mostrarSubidos(resultado.subidos);

  if (resto.length) {
    const confirm = await promptVisible(
      `\nDo the ${sample.length} test contact(s) look correct in Chatwoot? ` +
      `Continue with the remaining ${resto.length} contacts? (y/N): `
    );
    if (/^(y|yes|s|si|sí)$/i.test(confirm.trim())) {
      // sin preExcluidos: los vCards vacíos ya los reportó la pasada de la muestra y
      // los reportes se acumulan (appendReporte), así que no se pierden ni se duplican
      await importRows(resto);
    } else {
      console.log("The remaining import was cancelled. You may run it again later.");
    }
  }
}

// ---------- Reportes ----------

function showLastRunSummary() {
  const reports = [
    { file: "errores.json", label: "Errors" },
    { file: "sin-telefono.json", label: "Contacts without a valid phone number" },
    { file: "excluidos.json", label: "Contacts not uploaded (placeholders, services, empty vCards)" },
    { file: "telefonos-reconstruidos.json", label: "Phone numbers reconstructed with DDD (review)" },
    { file: "ciudad-actualizada.json", label: "Existing contacts whose city was corrected" },
    { file: "atributos-no-leidos.json", label: "Contacts whose city was left unchanged" },
  ];

  console.log("");
  let any = false;
  for (const { file, label } of reports) {
    if (!fs.existsSync(file)) continue;
    any = true;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(`${label}: ${data.length} (${file})`);
    for (const item of data.slice(0, 5)) {
      const ubicacion = item.fila ? `row ${item.fila}` : "vCard";
      const detalle = item.motivo || item.detalle || item.status ||
        (item.ciudad_nueva ? `${item.ciudad_anterior} -> ${item.ciudad_nueva}` : "") ||
        (item.original ? `${item.original} -> ${item.reconstruido}` : "");
      console.log(`  - ${ubicacion}: ${item.contacto || item.nombre} — ${detalle}`);
    }
    if (data.length > 5) console.log(`  ... and ${data.length - 5} more`);
  }
  if (!any) console.log("No run reports are available yet.");
  console.log("");
}

// ---------- Menú ----------

async function showMenu() {
  console.log("=== Chatwoot Contact Importer ===");
  console.log(`Connected to: ${process.env.CHATWOOT_BASE_URL} (account ${process.env.CHATWOOT_ACCOUNT_ID})\n`);
  console.log("1) Test 1-2 randomly selected contacts");
  console.log("2) Import a complete CSV or VCF file without a test");
  console.log("3) Show the latest run summary");
  console.log("4) Generate a name .vcf from CSV for module 1");
  console.log("5) Change configuration (URL / account / token)");
  console.log("6) Exit\n");
  const choice = await promptVisible("Choose an option (1-6): ");
  return choice.trim();
}

async function menuLoop() {
  while (true) {
    const choice = await showMenu();
    console.log("");

    try {
      if (choice === "1") {
        const source = await resolveCsvSource("Contact file (CSV or VCF)");
        await runSampleThenMaybeFull(source);
      } else if (choice === "2") {
        const source = await resolveCsvSource("Contact file (CSV or VCF)");
        await runFullImport(source);
      } else if (choice === "3") {
        showLastRunSummary();
      } else if (choice === "4") {
        const source = await resolveCsvSource("CSV containing names (name, phone_number)");
        await generarVcfDeNombres(source);
      } else if (choice === "5") {
        await reconfigure();
      } else if (choice === "6" || choice === "") {
        console.log("Done.");
        break;
      } else {
        console.log("Invalid option. Choose a number from 1 to 6.\n");
      }
    } catch (e) {
      console.error(`\nError: ${e.message}\n`);
    }

    console.log("");
  }
}

async function main() {
  // --vcf va ANTES de ensureConfig(): convertir un CSV a vCard es un trabajo local,
  // no toca Chatwoot, así que no tiene por qué pedir URL ni token.
  if (process.argv[2] === "--vcf") {
    if (!process.argv[3]) {
      console.error("Usage: node import-contacts.mjs --vcf <file.csv>");
      process.exit(1);
    }
    await generarVcfDeNombres(process.argv[3]);
    return;
  }

  await ensureConfig();

  if (process.argv[2]) {
    await runFullImport(process.argv[2]);
    return;
  }

  if (!process.stdin.isTTY) {
    console.error("Usage: node import-contacts.mjs <csv-path-or-url>");
    process.exit(1);
  }

  await menuLoop();
}

try {
  await main();
} finally {
  closeSharedRl();
}
