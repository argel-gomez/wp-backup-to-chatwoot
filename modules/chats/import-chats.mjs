// import-chats.mjs — Importa el historial de WhatsApp a Chatwoot por INSERCIÓN DIRECTA en Postgres.
//
// Por qué directo a la base y no por API: la API de Chatwoot no permite fijar created_at
// (los mensajes quedarían con la fecha de hoy) y crear mensajes salientes por API en el
// inbox real dispara envíos DE VERDAD a los clientes. Insertando en Postgres no corre
// ningún callback/webhook/job: nada se envía, y las fechas quedan las reales.
//
// Uso:
//   node import-chats.mjs                        -> menú interactivo (o run.bat -> opción 4)
//   node import-chats.mjs --dry-run              -> estadísticas del export, SIN tocar la base
//   node import-chats.mjs --chat <jid>           -> importa UN solo chat (para probar)
//   node import-chats.mjs --chats <jid1,jid2>    -> importa 2+ chats puntuales (para probar)
//   node import-chats.mjs --limit N              -> importa los N chats más grandes pendientes
//   node import-chats.mjs --all                  -> importa todo lo pendiente (reanudable)
//   node import-chats.mjs --undo                 -> borra TODO lo importado por este script
//
// Reanudable: estado.json guarda los chats ya importados; además cada conversación queda
// marcada en la base con additional_attributes.imported_from = "wa_archive", así que
// re-correr nunca duplica y --undo sabe exactamente qué borrar.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ensureConfig, ask, saveToEnvFile, ROOT_DIR } from "../../lib/config.mjs"; // carga el .env de la raíz y pregunta lo que falte
import { WaError, printError } from "../../lib/errors.mjs";
import { subirAdjuntos } from "./subir-adjuntos.mjs";
import { banner, panel, ok, warn, fail, info, progressBar, endProgressBar, bold, c } from "../../lib/ui.mjs";

const IMPORT_MARKER = "wa_archive";
// El estado de avance queda en la raíz del programa, junto a los demás reportes
const STATE_PATH = path.join(ROOT_DIR, "estado.json");

// Enums de Chatwoot (estables desde v2.x; recon.mjs los verifica contra la base real)
const MESSAGE_TYPE = { incoming: 0, outgoing: 1 };
const MESSAGE_STATUS_READ = 2;
const CONVERSATION_RESOLVED = 1;
const CONTENT_TYPE_TEXT = 0;
const FILE_TYPE = { image: 0, audio: 1, video: 2, file: 3 };

// Chats que no son conversaciones reales (estados de WhatsApp / broadcast)
const SKIP_CHAT_IDS = new Set(["0@s.whatsapp.net", "status@broadcast"]);

// ---------- CLI ----------

const args = process.argv.slice(2);
const flags = {
  dryRun: args.includes("--dry-run"),
  undo: args.includes("--undo"),
  all: args.includes("--all"),
  chat: args.includes("--chat") ? args[args.indexOf("--chat") + 1] : null,
  chats: args.includes("--chats")
    ? args[args.indexOf("--chats") + 1].split(",").map((s) => s.trim()).filter(Boolean)
    : null,
  limit: args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : null,
};

// ---------- Config ----------

// mutables: ensureConfig() puede completar process.env en caliente
let EXPORT_DIR, ACCOUNT_ID, INBOX_ID, AGENT_USER_ID, STORAGE_ROOT;
refreshConfig();

function refreshConfig() {
  EXPORT_DIR = process.env.EXPORT_DIR || "";
  ACCOUNT_ID = Number(process.env.ACCOUNT_ID || 0);
  INBOX_ID = Number(process.env.INBOX_ID || 0);
  AGENT_USER_ID = Number(process.env.AGENT_USER_ID || 0);
  STORAGE_ROOT = process.env.STORAGE_ROOT || "";
}

// ---------- Lectura del export ----------

function loadExport() {
  const jsonPath = path.join(EXPORT_DIR, "chatwoot_export.json");
  if (!fs.existsSync(jsonPath)) {
    throw new WaError("EEXP", `No existe ${jsonPath}`, "Revisá EXPORT_DIR en .env");
  }
  console.log(`Leyendo ${jsonPath} ...`);
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const contactsByJid = new Map(data.contacts.map((c) => [c.identifier, c]));
  return { conversations: data.conversations, contactsByJid };
}

function classifyJid(jid) {
  if (jid.endsWith("@g.us")) return "grupo";
  if (jid.endsWith("@lid")) return "lid";
  if (jid.endsWith("@s.whatsapp.net")) return "individual";
  return "otro";
}

// Los chats "@lid" usan el identificador de privacidad de WhatsApp, que no contiene el
// teléfono — sin resolverlos, esos chats no se pueden cruzar con la agenda y quedan
// mostrando un número largo sin sentido. La base descifrada (msgstore) trae la tabla
// jid_map con la correspondencia lid -> teléfono: acá se lee una sola vez.
let lidMap = null;

function msgstorePath() {
  if (process.env.MSGSTORE_DB) return process.env.MSGSTORE_DB;

  // el wizard deja dentro del export un puntero a la base descifrada, porque el
  // export (PLACE-HERE-3) puede quedar lejos de la carpeta del respaldo
  try {
    const apuntada = fs.readFileSync(path.join(EXPORT_DIR, "_msgstore_location.txt"), "utf8").trim();
    if (apuntada && fs.existsSync(apuntada)) return apuntada;
  } catch {}

  // ubicación que deja wa_archive.py cuando el export quedó junto al respaldo
  const juntoAlExport = path.join(EXPORT_DIR, "..", "_wa_decrypted.db");
  if (fs.existsSync(juntoAlExport)) return juntoAlExport;

  // con las carpetas PLACE-HERE, el respaldo (y su _wa_decrypted.db) vive en
  // PLACE-HERE-1-ANDROID-BACKUP — directo o un nivel adentro
  const dropBackup = path.join(ROOT_DIR, "PLACE-HERE-1-ANDROID-BACKUP");
  const candidatos = [dropBackup];
  try {
    for (const e of fs.readdirSync(dropBackup, { withFileTypes: true })) {
      if (e.isDirectory()) candidatos.push(path.join(dropBackup, e.name));
    }
  } catch {}
  for (const d of candidatos) {
    const p = path.join(d, "_wa_decrypted.db");
    if (fs.existsSync(p)) return p;
  }

  return juntoAlExport; // no existe: quien llama ya avisa y sigue sin el mapeo @lid
}

function loadLidMap() {
  if (lidMap) return lidMap;
  lidMap = new Map();
  const db = msgstorePath();
  if (!fs.existsSync(db)) {
    warn(`No encontré ${db} — los chats @lid van a quedar con su identificador crudo.`);
    warn("Si tenés la base descifrada en otro lado, poné la ruta en MSGSTORE_DB (.env).\n");
    return lidMap;
  }
  try {
    const sqlite = new DatabaseSync(db, { readOnly: true });
    const filas = sqlite.prepare(
      `select l.raw_string as lid, j.user as telefono
       from jid_map m
       join jid l on l._id = m.lid_row_id
       join jid j on j._id = m.jid_row_id
       where l.raw_string like '%@lid' and j.user is not null and j.user <> ''`
    ).all();
    sqlite.close();
    for (const f of filas) lidMap.set(f.lid, String(f.telefono).replace(/\D/g, ""));
    ok(`${lidMap.size} identificadores @lid resueltos a teléfono desde msgstore.`);
  } catch (e) {
    warn(`No pude leer el mapeo @lid (${e.message}) — esos chats quedan con el identificador crudo.`);
  }
  return lidMap;
}

// Nombres rescatados de las tarjetas de contacto (vCard) que se compartieron DENTRO de
// los chats. Es la única fuente que nombra a gente que nunca estuvo en la agenda: si
// alguien pasó el contacto de "Dra Ieda" por WhatsApp, ahí quedó su nombre y su teléfono.
let waNames = null;

function loadWaNames() {
  if (waNames) return waNames;
  waNames = new Map();
  const db = msgstorePath();
  if (!fs.existsSync(db)) return waNames;
  try {
    const sqlite = new DatabaseSync(db, { readOnly: true });
    const filas = sqlite.prepare("select vcard from message_vcard where vcard is not null").all();
    sqlite.close();
    for (const { vcard } of filas) {
      const txt = String(vcard);
      const fn = txt.match(/^FN:(.+)$/m);
      if (!fn) continue;
      const nombre = fn[1].trim();
      if (!esNombreReal(nombre)) continue;
      for (const tel of txt.matchAll(/TEL[^:]*:([^\r\n]+)/g)) {
        const c = canonicalPhoneBR(tel[1]);
        if (c && !waNames.has(c)) waNames.set(c, nombre);
      }
    }
    if (waNames.size) ok(`${waNames.size} nombres rescatados de tarjetas de contacto compartidas.`);
  } catch (e) {
    warn(`No pude leer las tarjetas de contacto (${e.message}).`);
  }
  return waNames;
}

// "<JID_EJEMPLO>@s.whatsapp.net" -> { phone: "+<JID_EJEMPLO>", sourceId: "<JID_EJEMPLO>" }
// Los @lid se resuelven a su teléfono real cuando msgstore lo permite, así se cruzan con
// la agenda igual que cualquier otro chat. Los grupos no tienen teléfono por definición:
// su source_id es el jid completo (nunca colisiona con el tráfico real del Cloud API).
function jidToIdentity(jid) {
  const kind = classifyJid(jid);

  if (kind === "individual") {
    const digits = jid.split("@")[0].replace(/\D/g, "");
    if (digits.length >= 8) return { kind, phone: `+${digits}`, sourceId: digits };
  }

  if (kind === "lid") {
    const digits = loadLidMap().get(jid);
    if (digits && digits.length >= 8) {
      return { kind, phone: `+${digits}`, sourceId: digits, desdeLid: true };
    }
  }

  return { kind, phone: null, sourceId: jid };
}

function attachmentAbsPath(filePath) {
  // el export usa rutas relativas con "/" — normalizamos para Windows/Linux
  return path.join(EXPORT_DIR, ...filePath.split("/"));
}

// El export trae el MIME real cuando WhatsApp lo guardó ("image/jpeg", "audio/ogg;
// codecs=opus"), y si no, la etiqueta del tipo que usa wa_archive.py — que está EN
// ESPAÑOL: imagen / audio / video / documento / gif / sticker / contacto / ubicacion
// (ver MEDIA_TYPES en modules/backup/wa_archive.py).
//
// "audio" y "video" se escriben igual en los dos idiomas, pero "imagen" no: contemplando
// solo "image" se colaban 16.242 fotos como adjunto genérico, y Chatwoot las mostraba
// como un archivo para descargar en vez de la foto en la burbuja.
function mapFileType(fileType) {
  const ft = (fileType || "").toLowerCase();
  if (ft.startsWith("image/") || ["image", "imagen", "sticker"].includes(ft)) return FILE_TYPE.image;
  if (ft.startsWith("audio/") || ["audio", "ptt", "voz"].includes(ft)) return FILE_TYPE.audio;
  if (ft.startsWith("video/") || ["video", "gif"].includes(ft)) return FILE_TYPE.video;
  return FILE_TYPE.file; // documento, contacto, ubicacion, y cualquier otro
}

// Texto que se muestra mientras el mensaje todavía no tiene su archivo colgado.
// La pasada de adjuntos lo reconoce por esta forma exacta para poder borrarlo.
function placeholderFor(att) {
  return `[${att.file_type || "adjunto"}]`;
}

function mimeFor(att) {
  const ft = att.file_type || "";
  if (ft.includes("/")) return ft;
  const ext = path.extname(att.file_path).toLowerCase();
  const byExt = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4",
    ".3gp": "video/3gpp", ".opus": "audio/ogg", ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".pdf": "application/pdf",
  };
  return byExt[ext] || "application/octet-stream";
}

// Prepara los mensajes de un chat: filtra vacíos, resuelve adjuntos en disco,
// y en grupos antepone el nombre del remitente a los entrantes.
function prepareMessages(conv, kind) {
  const out = [];
  let skippedEmpty = 0;
  let mediaFound = 0;
  let mediaMissing = 0;

  for (const m of conv.messages) {
    let content = (m.content || "").trim();
    const atts = [];

    for (const a of m.attachments || []) {
      const abs = attachmentAbsPath(a.file_path);
      if (fs.existsSync(abs)) {
        atts.push({ ...a, abs });
        mediaFound++;
      } else {
        mediaMissing++;
        if (!content) content = `[adjunto ausente: ${a.file_type || "archivo"}]`;
      }
    }

    if (!content && !atts.length) {
      skippedEmpty++;
      continue;
    }

    // Marcador para el mensaje que es solo un adjunto: en la primera pasada (solo texto)
    // evita que se vea una burbuja vacía. La pasada de adjuntos lo borra al colgar el
    // archivo real. Se calcula acá para que ambas pasadas generen EXACTAMENTE el mismo
    // contenido — la pasada 2 empareja los mensajes por posición y verifica la fecha.
    if (!content && atts.length) content = placeholderFor(atts[0]);

    if (kind === "grupo" && m.message_type === "incoming" && m.sender && m.sender !== "yo") {
      content = content ? `${m.sender}: ${content}` : `${m.sender}:`;
    }

    out.push({
      content,
      messageType: MESSAGE_TYPE[m.message_type] ?? MESSAGE_TYPE.incoming,
      epoch: m.created_at,
      attachments: atts,
    });
  }

  return { messages: out, skippedEmpty, mediaFound, mediaMissing };
}

// Fecha con la que va a quedar la conversación en Chatwoot (last_activity_at), que es lo
// que ordena la lista para el agente.
//
// Tiene que saltear los mensajes del final que se descartan al importar (sin texto ni
// adjunto: borrados, de sistema, multimedia perdida). Usar el último mensaje CRUDO metía
// chats viejos entre los recientes: se ordenaban por una fecha que después no era la que
// terminaban mostrando. No mira el disco a propósito — eso lo hace prepareMessages() y
// sería carísimo repetirlo para ordenar 18.000 chats.
function lastRawEpoch(conv) {
  const msgs = conv.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if ((m.content || "").trim() || (m.attachments || []).length) return m.created_at;
  }
  return 0;
}

// ---------- Dry run ----------

function dryRun({ conversations }) {
  const stats = {
    chats: 0, saltados: 0, mensajes: 0, entrantes: 0, salientes: 0, vacios: 0,
    porTipo: {}, porAnio: {}, adjRef: 0, adjEnDisco: 0, adjFaltantes: 0,
  };
  let tsMin = Infinity, tsMax = -Infinity;
  const biggest = [];

  for (const conv of conversations) {
    const jid = conv.contact_identifier;
    if (SKIP_CHAT_IDS.has(jid)) {
      stats.saltados++;
      continue;
    }
    const kind = classifyJid(jid);
    const prep = prepareMessages(conv, kind);
    if (!prep.messages.length) {
      stats.saltados++;
      continue;
    }

    stats.chats++;
    stats.porTipo[kind] = (stats.porTipo[kind] || 0) + 1;
    stats.vacios += prep.skippedEmpty;
    stats.adjEnDisco += prep.mediaFound;
    stats.adjFaltantes += prep.mediaMissing;
    stats.adjRef += prep.mediaFound + prep.mediaMissing;

    for (const m of prep.messages) {
      stats.mensajes++;
      if (m.messageType === MESSAGE_TYPE.incoming) stats.entrantes++;
      else stats.salientes++;
      const year = new Date(m.epoch * 1000).getUTCFullYear();
      stats.porAnio[year] = (stats.porAnio[year] || 0) + 1;
      if (m.epoch < tsMin) tsMin = m.epoch;
      if (m.epoch > tsMax) tsMax = m.epoch;
    }
    biggest.push({ jid, n: prep.messages.length });
  }

  biggest.sort((a, b) => b.n - a.n);
  const fmt = (e) => new Date(e * 1000).toISOString().slice(0, 10);

  console.log("\n=== DRY RUN — nada se escribió en ninguna parte ===\n");
  console.log(`Chats a importar:      ${stats.chats}  (saltados: ${stats.saltados} — estados/vacíos)`);
  console.log(`  por tipo:            ${JSON.stringify(stats.porTipo)}`);
  console.log(`Mensajes a importar:   ${stats.mensajes}  (entrantes ${stats.entrantes} / salientes ${stats.salientes})`);
  console.log(`  descartados vacíos:  ${stats.vacios} (sin texto ni adjunto — borrados/sistema/media perdida)`);
  console.log(`Rango de fechas:       ${fmt(tsMin)} → ${fmt(tsMax)}`);
  console.log(`  por año:             ${JSON.stringify(stats.porAnio)}`);
  console.log(`Adjuntos referenciados:${stats.adjRef}  (en disco: ${stats.adjEnDisco} / faltantes: ${stats.adjFaltantes})`);
  console.log(`  van en el PASO 2 (opción 6), después de importar los mensajes`);
  console.log("\nChats más grandes:");
  for (const b of biggest.slice(0, 10)) console.log(`  ${String(b.n).padStart(7)}  ${b.jid}`);
  console.log("");
}

// ---------- Estado local ----------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { importados: {} };
  }
}

// La clave lleva el inbox adelante porque el mismo chat puede importarse a DOS bandejas
// distintas (un contacto que escribió a dos números de atención): sin esto,
// el segundo número lo daría por ya hecho y se saltearía la conversación entera.
const claveEstado = (jid) => `${INBOX_ID}|${jid}`;

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ---------- Helpers de base ----------

const TS = "to_timestamp($EPOCH) at time zone 'utc'"; // Chatwoot guarda timestamps naive en UTC

function newBlobKey() {
  // equivalente a SecureRandom.base36(28) de Rails
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let key = "";
  const bytes = crypto.randomBytes(28);
  for (let i = 0; i < 28; i++) key += chars[bytes[i] % 36];
  return key;
}

function blobDiskPath(key) {
  return path.join(STORAGE_ROOT, key.slice(0, 2), key.slice(2, 4), key);
}

async function connectDb() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
  } catch (e) {
    throw new WaError("EDB", "No se pudo conectar a Postgres", `${e.message} — ¿el túnel SSH sigue abierto? ¿DATABASE_URL es correcta?`);
  }
  return client;
}

// Contactos ambiguos: el número coincide con dos personas DISTINTAS. Se anotan para
// revisión manual en vez de arriesgar una fusión equivocada.
const contactosAmbiguos = [];

// Forma canónica de un número brasileño: <DDD><últimos 8 dígitos>.
//
// WhatsApp puede identificar contactos viejos sin el noveno dígito, mientras que
// Chatwoot puede guardar el mismo contacto con ese dígito y con código de país. Esas
// variantes se reducen a una misma clave, que es lo que permite reconocerlas como
// la misma persona. Incluye el DDD a propósito: emparejar solo por los últimos dígitos
// juntaba gente de ciudades distintas.
function canonicalPhoneBR(raw) {
  if ((process.env.DEFAULT_COUNTRY_CODE || "+55").replace(/\D/g, "") !== "55") return null;
  const original = String(raw || "").trim();
  let d = original.replace(/\D/g, "");
  if (!d) return null;
  // Un E.164 explícito de otro país nunca participa del fallback brasileño.
  if (original.startsWith("+") && !d.startsWith("55")) return null;
  // el "55" inicial es código de país solo si además quedan suficientes dígitos detrás
  // (hay DDDs 51-55 en Rio Grande do Sul que también empiezan con 55)
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  return d.slice(0, 2) + d.slice(-8);
}

const esNombreReal = (n) => Boolean(n) && !/^[\d+\s()-]+$/.test(n);

// El export escribe los nombres como "CONTACTO DE EJEMPLO (<JID_EJEMPLO>)" — el identificador entre
// paréntesis lo agrega wa_archive.py a propósito, para poder auditar a ojo si el cruce con
// el .vcf acertó. En la agenda de Chatwoot ese sufijo sobra: el teléfono ya va en su campo.
function limpiarNombreExport(nombre, jid) {
  if (!nombre) return null;
  const limpio = nombre.replace(/\s*\(\d{8,}\)\s*$/, "").trim();
  // si al sacar el número no queda nada, es que el "nombre" ERA el número: no es un nombre
  return esNombreReal(limpio) ? limpio : null;
}

// Entre varios contactos que son la misma persona, el más completo: con nombre real y
// con el teléfono más largo (el que tiene código de país y el 9).
function mejorCandidato(cands) {
  const conNombre = cands.filter((c) => esNombreReal(c.name));
  const pool = conNombre.length ? conNombre : cands;
  return pool
    .slice()
    .sort((a, b) => String(b.phone_number || "").replace(/\D/g, "").length -
                    String(a.phone_number || "").replace(/\D/g, "").length)[0];
}

// ¿Todos los candidatos son la misma persona? Los duplicados que ya venían en Chatwoot
// (mismo nombre cargado dos veces con distinto formato de teléfono) NO son ambigüedad.
function mismaPersona(cands) {
  const nombres = new Set(
    cands.filter((c) => esNombreReal(c.name)).map((c) => c.name.trim().toUpperCase())
  );
  return nombres.size <= 1;
}

// Índice en memoria de los contactos que ya existen. Se arma UNA vez al empezar en lugar
// de consultar por cada chat, lo que evita miles de idas y vueltas por el túnel.
async function loadContactIndex(client) {
  const res = await client.query(
    "select id, name, phone_number, identifier from contacts where account_id = $1",
    [ACCOUNT_ID]
  );
  const index = { byPhone: new Map(), byIdent: new Map(), byCanon: new Map() };
  for (const row of res.rows) addToIndex(index, row);
  return index;
}

function addToIndex(index, row) {
  if (row.phone_number) index.byPhone.set(row.phone_number, row);
  if (row.identifier) index.byIdent.set(row.identifier, row);
  const canon = canonicalPhoneBR(row.phone_number);
  if (canon) {
    if (!index.byCanon.has(canon)) index.byCanon.set(canon, []);
    index.byCanon.get(canon).push(row);
  }
}

// Devuelve el contacto al que pertenece este chat. Si ya existe, se REUTILIZA tal cual:
// nunca se le pisa el nombre ni ningún otro dato — la agenda de Chatwoot manda sobre lo
// que diga el export, que puede estar desactualizado.
async function findOrCreateContact(client, index, jid, name, identity) {
  // Orden: teléfono exacto -> identifier (jid) -> forma canónica brasileña -> crear nuevo.
  if (identity.phone) {
    const exacto = index.byPhone.get(identity.phone);
    if (exacto) return { id: exacto.id, created: false };
  }

  const porJid = index.byIdent.get(jid);
  if (porJid) return { id: porJid.id, created: false };

  if (identity.phone) {
    const canon = canonicalPhoneBR(identity.phone);
    const cands = (canon && index.byCanon.get(canon)) || [];

    if (cands.length === 1) return { id: cands[0].id, created: false };

    if (cands.length > 1) {
      if (mismaPersona(cands)) {
        // duplicados que ya existían en Chatwoot (mismo nombre, distinto formato de
        // teléfono): se usa el más completo en vez de crear un tercero
        return { id: mejorCandidato(cands).id, created: false };
      }
      contactosAmbiguos.push({
        jid, nombre: name, telefono_wa: identity.phone,
        candidatos: cands.map((r) => ({ id: r.id, nombre: r.name, telefono: r.phone_number })),
        motivo: "el número coincide con dos personas distintas — se creó aparte, revisar a mano",
      });
    }
  }

  // Contacto nuevo. Se busca el mejor nombre disponible, en orden:
  //   1. el del export (viene del .vcf que se usó al exportar), sin el "(número)" pegado
  //   2. el de alguna tarjeta de contacto compartida dentro de los chats
  //   3. el número pelado — igual que hace Chatwoot con alguien no agendado
  // Quedan marcados con imported_from para poder encontrarlos después (ver README).
  const canonNuevo = identity.phone ? canonicalPhoneBR(identity.phone) : null;
  const nombreLimpio =
    limpiarNombreExport(name, jid) || (canonNuevo ? loadWaNames().get(canonNuevo) : null) || null;
  const nombreFinal = nombreLimpio || (identity.phone ? identity.phone.replace("+", "") : jid);

  const inserted = await client.query(
    `insert into contacts (account_id, name, phone_number, identifier, additional_attributes, created_at, updated_at)
     values ($1, $2, $3, $4, $5, now() at time zone 'utc', now() at time zone 'utc')
     returning id`,
    [
      ACCOUNT_ID, nombreFinal, identity.phone, jid,
      JSON.stringify({ imported_from: IMPORT_MARKER, sin_nombre: !nombreLimpio }),
    ]
  );
  const row = { id: inserted.rows[0].id, name: nombreFinal, phone_number: identity.phone, identifier: jid };
  addToIndex(index, row); // que el próximo chat del mismo contacto lo reutilice
  return { id: row.id, created: true, sinNombre: !nombreLimpio };
}

async function findOrCreateContactInbox(client, contactId, sourceId) {
  // Se busca por (contact_id, inbox_id) — NO por source_id — porque el reconocimiento
  // algunas instalaciones usan un identificador interno en vez de dígitos de teléfono.
  // Si ya existe
  // UN mapeo de este contacto a este inbox, se reutiliza tal cual, sea cual sea su
  // source_id — así el historial queda sobre el mismo hilo que Chatwoot usa de verdad
  // para enrutar los mensajes en vivo, en vez de crear un segundo mapeo con dígitos que
  // quedaría separado.
  const existing = await client.query(
    "select id from contact_inboxes where contact_id = $1 and inbox_id = $2 limit 1",
    [contactId, INBOX_ID]
  );
  if (existing.rows.length) return existing.rows[0].id;

  const inserted = await client.query(
    `insert into contact_inboxes (contact_id, inbox_id, source_id, created_at, updated_at)
     values ($1, $2, $3, now() at time zone 'utc', now() at time zone 'utc')
     returning id`,
    [contactId, INBOX_ID, sourceId]
  );
  return inserted.rows[0].id;
}

async function insertConversation(client, contactId, contactInboxId, jid, name, firstEpoch, lastEpoch) {
  const additional = { imported_from: IMPORT_MARKER, chat_id: jid, chat_name: name };
  const res = await client.query(
    `insert into conversations
       (account_id, inbox_id, contact_id, contact_inbox_id, status, display_id, uuid,
        additional_attributes, created_at, updated_at, last_activity_at, agent_last_seen_at)
     values ($1, $2, $3, $4, $5, nextval($6::regclass), gen_random_uuid(), $7,
             to_timestamp($8) at time zone 'utc', to_timestamp($9) at time zone 'utc',
             to_timestamp($9) at time zone 'utc', to_timestamp($9) at time zone 'utc')
     returning id, display_id`,
    [
      ACCOUNT_ID, INBOX_ID, contactId, contactInboxId, CONVERSATION_RESOLVED,
      `conv_dpid_seq_${ACCOUNT_ID}`, JSON.stringify(additional), firstEpoch, lastEpoch,
    ]
  );
  return res.rows[0];
}

async function insertMessageBatch(client, conversationId, batch, contactId) {
  // mensajes sin adjuntos: multi-fila. Con adjuntos: de a uno (necesitamos el id).
  const cols =
    "(account_id, inbox_id, conversation_id, message_type, content, content_type, status, private, sender_type, sender_id, created_at, updated_at)";
  const values = [];
  const params = [];
  let p = 1;

  for (const m of batch) {
    const isIncoming = m.messageType === MESSAGE_TYPE.incoming;
    values.push(
      `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, ${CONTENT_TYPE_TEXT}, ${MESSAGE_STATUS_READ}, false, $${p++}, $${p++}, to_timestamp($${p}) at time zone 'utc', to_timestamp($${p++}) at time zone 'utc')`
    );
    params.push(
      ACCOUNT_ID, INBOX_ID, conversationId, m.messageType, m.content,
      isIncoming ? "Contact" : "User",
      isIncoming ? contactId : AGENT_USER_ID,
      m.epoch
    );
  }

  await client.query(`insert into messages ${cols} values ${values.join(", ")}`, params);
}

// ---------- Verificación previa (simulación, no escribe nada) ----------

// Resuelve a qué contacto iría un chat, SIN tocar la base. Misma lógica que
// findOrCreateContact() pero sin el INSERT — para poder revisar el resultado antes.
function resolverContacto(index, jid, identity) {
  if (identity.phone) {
    const exacto = index.byPhone.get(identity.phone);
    if (exacto) return { tipo: "existente", contacto: exacto };
  }
  const porJid = index.byIdent.get(jid);
  if (porJid) return { tipo: "existente", contacto: porJid };

  if (identity.phone) {
    const cands = index.byCanon.get(canonicalPhoneBR(identity.phone)) || [];
    if (cands.length === 1) return { tipo: "existente", contacto: cands[0] };
    if (cands.length > 1) {
      if (mismaPersona(cands)) {
        return { tipo: "existente", contacto: mejorCandidato(cands), fusionados: cands.length };
      }
      return { tipo: "ambiguo", candidatos: cands };
    }
  }
  return { tipo: "nuevo" };
}

async function runPreflight() {
  await ensureConfig(["EXPORT_DIR", "DATABASE_URL", "ACCOUNT_ID"]);
  refreshConfig();

  banner("Verificación previa", "simulación contra la base real — NO escribe nada");

  const { conversations, contactsByJid } = loadExport();
  const client = await connectDb();

  try {
    // Se excluye lo que creó el import: así el resultado refleja cómo quedaría
    // arrancando limpio (que es el escenario después de deshacer).
    const res = await client.query(
      `select id, name, phone_number, identifier from contacts
       where account_id = $1
         and (additional_attributes->>'imported_from') is distinct from $2`,
      [ACCOUNT_ID, IMPORT_MARKER]
    );
    const index = { byPhone: new Map(), byIdent: new Map(), byCanon: new Map() };
    for (const row of res.rows) addToIndex(index, row);
    info(`Contactos reales en Chatwoot: ${res.rows.length}\n`);

    const st = { conNombre: 0, existenteSinNombre: 0, nuevoConNombre: 0, nuevoDeVcard: 0, nuevoSinNombre: 0,
                 ambiguo: 0, sinTelefono: 0, fusionados: 0 };
    const ambiguos = [];
    const muestraOk = [], muestraCruda = [], muestraVcard = [];

    for (const conv of conversations) {
      const jid = conv.contact_identifier;
      if (SKIP_CHAT_IDS.has(jid)) continue;
      const identity = jidToIdentity(jid);
      const prep = prepareMessages(conv, identity.kind);
      if (!prep.messages.length) continue;

      const nombreExport = contactsByJid.get(jid)?.name || jid;

      if (!identity.phone) {
        // grupos y @lid: el identificador de WhatsApp no contiene el teléfono, así que
        // no hay con qué cruzarlos contra la agenda
        st.sinTelefono++;
        if (!esNombreReal(nombreExport) && muestraCruda.length < 6) {
          muestraCruda.push(`${nombreExport}  (${identity.kind}: sin teléfono para cruzar)`);
        }
        continue;
      }

      const r = resolverContacto(index, jid, identity);
      if (r.tipo === "existente") {
        if (r.fusionados) st.fusionados++;
        if (esNombreReal(r.contacto.name)) {
          st.conNombre++;
          if (muestraOk.length < 6) {
            muestraOk.push(`${jid.split("@")[0]} -> "${r.contacto.name}"` +
              (r.fusionados ? ` (${r.fusionados} fichas duplicadas, usa la mejor)` : ""));
          }
        } else {
          st.existenteSinNombre++;
        }
      } else if (r.tipo === "ambiguo") {
        st.ambiguo++;
        ambiguos.push({
          jid, telefono: identity.phone,
          candidatos: r.candidatos.map((c) => ({ id: c.id, nombre: c.name, telefono: c.phone_number })),
        });
      } else {
        // mismo orden de preferencia que usa findOrCreateContact al crear
        const canonN = canonicalPhoneBR(identity.phone);
        const deVcard = canonN ? loadWaNames().get(canonN) : null;
        if (limpiarNombreExport(nombreExport, jid)) st.nuevoConNombre++;
        else if (deVcard) {
          st.nuevoDeVcard++;
          if (muestraVcard.length < 6) muestraVcard.push(`${identity.phone.replace("+", "")} -> "${deVcard}"`);
        } else {
          st.nuevoSinNombre++;
          if (muestraCruda.length < 6) muestraCruda.push(`${nombreExport}  (no está en tu agenda)`);
        }
      }
    }

    const totalCrudos = st.existenteSinNombre + st.nuevoSinNombre + st.sinTelefono;

    panel([
      "Cómo se van a ver los chats importados",
      "",
      `Con NOMBRE del contacto ya existente:  ${st.conNombre}`,
      `  de esos, con fichas duplicadas
   que se fusionan:                     ${st.fusionados}`.replace(/\s*\n\s*/, " "),
      `Contacto nuevo, con nombre del export: ${st.nuevoConNombre}`,
      `Contacto nuevo, nombre rescatado de
   una tarjeta compartida:              ${st.nuevoDeVcard}`.replace(/\s*\n\s*/, " "),
      "",
      `Van a mostrar NÚMERO/ID crudo:         ${totalCrudos}`,
      `  ya existía pero sin nombre:          ${st.existenteSinNombre}`,
      `  no está en tu agenda:                ${st.nuevoSinNombre}`,
      `  grupos y @lid (sin teléfono):        ${st.sinTelefono}`,
      "",
      `Ambiguos (2 personas distintas):       ${st.ambiguo}`,
    ], st.ambiguo > 100 ? "amber" : "green");

    if (muestraOk.length) {
      console.log(bold("\nEjemplos que van a quedar BIEN:"));
      for (const m of muestraOk) console.log(`  ✓ ${m}`);
    }
    if (muestraVcard.length) {
      console.log(bold("\nNombres rescatados de tarjetas compartidas en los chats:"));
      for (const m of muestraVcard) console.log(`  ✓ ${m}`);
    }
    if (muestraCruda.length) {
      console.log(bold("\nEjemplos que van a mostrar número crudo:"));
      for (const m of muestraCruda) console.log(`  · ${m}`);
      console.log("  (para que muestren nombre, hay que cargarlos antes en los contactos de Chatwoot)");
    }
    if (ambiguos.length) {
      fs.writeFileSync("contactos-ambiguos.json", JSON.stringify(ambiguos, null, 2));
      warn(`\n${ambiguos.length} número(s) coinciden con dos personas distintas — se van a crear aparte.`);
      warn("Detalle en contactos-ambiguos.json (revisar y unificar a mano en Chatwoot).");
    }
  } finally {
    await client.end();
  }
}

// ---------- Candidatos para probar ----------

// Chats individuales, con nombre reconocible (no solo el número crudo) y tamaño
// manejable (ni vacíos ni excesivamente grandes) — para elegir 1-2 de
// entrada al probar, sin tener que memorizar un jid.
function listTestCandidates(conversations, contactsByJid, limit = 20) {
  const out = [];
  for (const conv of conversations) {
    const jid = conv.contact_identifier;
    if (SKIP_CHAT_IDS.has(jid)) continue;
    if (classifyJid(jid) !== "individual") continue;

    const name = contactsByJid.get(jid)?.name || jid;
    if (!/[a-zA-Z]/.test(name)) continue; // descarta los que solo muestran el número crudo

    const count = prepareMessages(conv, "individual").messages.length;
    if (count < 3 || count > 300) continue;

    out.push({ jid, name, count });
  }
  out.sort((a, b) => a.count - b.count);
  return out.slice(0, limit);
}

async function runTestChatsFlow() {
  await ensureConfig(["EXPORT_DIR"]);
  refreshConfig();
  const { conversations, contactsByJid } = loadExport();
  const candidates = listTestCandidates(conversations, contactsByJid);

  if (!candidates.length) {
    warn("No encontré chats individuales chicos con nombre reconocible. Podés pegar un jid a mano igual.");
  } else {
    console.log(bold("\nChats sugeridos para probar (individuales, con nombre, tamaño chico/mediano):\n"));
    candidates.forEach((cand, i) => {
      console.log(`  ${String(i + 1).padStart(2)}) ${cand.name.slice(0, 42).padEnd(42)} ${String(cand.count).padStart(4)} mensajes`);
    });
  }

  const raw = await ask(
    "\nElegí números separados por coma (ej: 1,3) — Enter = las 2 primeras de la lista, " +
    "o pegá un jid exacto (ej. <JID_EJEMPLO>@s.whatsapp.net): "
  );

  let jids;
  if (!raw && candidates.length) {
    jids = candidates.slice(0, 2).map((cnd) => cnd.jid);
  } else if (raw.includes("@")) {
    jids = [raw];
  } else if (raw) {
    const idxs = raw.split(",").map((s) => Number(s.trim()) - 1);
    jids = idxs.filter((i) => Number.isInteger(i) && candidates[i]).map((i) => candidates[i].jid);
  } else {
    jids = [];
  }

  if (!jids.length) {
    warn("Nada seleccionado.");
    return;
  }

  console.log(`\nSe van a importar ${jids.length} chat(s) de prueba:`);
  for (const j of jids) console.log(`  - ${j}`);
  await runImport({ chats: jids });
}

// ---------- Importación ----------

async function importChat(client, index, conv, contactsByJid, onProgress = () => {}) {
  const jid = conv.contact_identifier;
  const identity = jidToIdentity(jid);
  const name = contactsByJid.get(jid)?.name || jid;
  const prep = prepareMessages(conv, identity.kind);
  if (!prep.messages.length) return { skipped: true };

  const msgs = prep.messages;
  const firstEpoch = msgs[0].epoch;
  const lastEpoch = msgs[msgs.length - 1].epoch;

  await client.query("begin");
  try {
    // Idempotencia también del lado de la base, por si estado.json se perdió.
    //
    // El filtro por inbox_id es imprescindible cuando se importan VARIOS números a la
    // misma cuenta: un contacto que escribió a dos números tiene el mismo jid
    // en los dos exports. Sin este filtro, el segundo chat se daba por "ya importado"
    // porque existía el primero, y podía perderse entero.
    const dupe = await client.query(
      `select id from conversations
       where account_id = $1 and inbox_id = $2
         and additional_attributes->>'imported_from' = $3
         and additional_attributes->>'chat_id' = $4 limit 1`,
      [ACCOUNT_ID, INBOX_ID, IMPORT_MARKER, jid]
    );
    if (dupe.rows.length) {
      await client.query("rollback");
      return { alreadyInDb: true, conversationId: dupe.rows[0].id };
    }

    const contact = await findOrCreateContact(client, index, jid, name, identity);
    const contactInboxId = await findOrCreateContactInbox(client, contact.id, identity.sourceId);
    const conversation = await insertConversation(
      client, contact.id, contactInboxId, jid, name, firstEpoch, lastEpoch
    );

    // Solo texto: los adjuntos van en una segunda pasada (opción 6). Mezclarlos acá hacía
    // que un chat con muchos adjuntos tardara demasiado tiempo sin
    // ningún avance en pantalla, y obligaba a rehacer todo si se quería agregarlos después.
    const BATCH = 500;
    for (let i = 0; i < msgs.length; i += BATCH) {
      await insertMessageBatch(client, conversation.id, msgs.slice(i, i + BATCH), contact.id);
      onProgress(Math.min(i + BATCH, msgs.length), msgs.length);
    }

    await client.query(
      `update contacts set last_activity_at = greatest(coalesce(last_activity_at, 'epoch'), to_timestamp($2) at time zone 'utc')
       where id = $1`,
      [contact.id, lastEpoch]
    );

    await client.query("commit");
    return { conversationId: conversation.id, displayId: conversation.display_id, messages: msgs.length };
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}

// ---------- Segunda pasada: adjuntos ----------

// Cuelga los adjuntos de un chat YA importado. Empareja cada mensaje del export con su
// fila en la base por POSICIÓN (los mensajes se insertaron en orden, así que `order by id`
// devuelve el mismo orden del export) y lo verifica comparando cantidad y fecha exacta de
// cada mensaje: si algo no calza, no toca nada y avisa.
async function addAttachmentsToChat(client, conv, conversationId, onProgress = () => {}) {
  const identity = jidToIdentity(conv.contact_identifier);
  const msgs = prepareMessages(conv, identity.kind).messages;
  // Total real: cuenta archivos que existen en disco, no los referenciados por el export
  // (si faltara alguno, el contador igual llega al 100%).
  const totalEnChat = msgs.reduce((acc, m) => acc + m.attachments.length, 0);
  if (!totalEnChat) return { sinAdjuntos: true };

  const db = await client.query(
    `select id, extract(epoch from created_at)::bigint as epoch
     from messages where conversation_id = $1 order by id`,
    [conversationId]
  );

  if (db.rows.length !== msgs.length) {
    throw new WaError(
      "EMATCH",
      `no coincide la cantidad de mensajes (base: ${db.rows.length}, export: ${msgs.length})`,
      "la conversación se modificó después de importarla — se saltea para no colgar archivos en el mensaje equivocado"
    );
  }
  const desalineado = msgs.findIndex((m, i) => Number(db.rows[i].epoch) !== Number(m.epoch));
  if (desalineado !== -1) {
    throw new WaError(
      "EMATCH",
      `la fecha del mensaje ${desalineado + 1} no coincide con la base`,
      "se saltea este chat para no colgar archivos en el mensaje equivocado"
    );
  }

  const copiedFiles = [];
  let puestos = 0;

  await client.query("begin");
  try {
    for (const [i, m] of msgs.entries()) {
      if (!m.attachments.length) continue;
      const messageId = db.rows[i].id;

      for (const att of m.attachments) {
        const buf = fs.readFileSync(att.abs);
        const key = newBlobKey();
        const diskPath = blobDiskPath(key);
        fs.mkdirSync(path.dirname(diskPath), { recursive: true });
        fs.writeFileSync(diskPath, buf);
        copiedFiles.push(diskPath);

        const attRow = await client.query(
          `insert into attachments (account_id, message_id, file_type, created_at, updated_at)
           values ($1, $2, $3, to_timestamp($4) at time zone 'utc', to_timestamp($4) at time zone 'utc')
           returning id`,
          [ACCOUNT_ID, messageId, mapFileType(att.file_type), m.epoch]
        );
        const blob = await client.query(
          `insert into active_storage_blobs (key, filename, content_type, metadata, service_name, byte_size, checksum, created_at)
           values ($1, $2, $3, '{}', $4, $5, $6, to_timestamp($7) at time zone 'utc')
           returning id`,
          [
            key, path.basename(att.abs), mimeFor(att),
            process.env.STORAGE_SERVICE || "local", buf.length,
            crypto.createHash("md5").update(buf).digest("base64"), m.epoch,
          ]
        );
        await client.query(
          `insert into active_storage_attachments (name, record_type, record_id, blob_id, created_at)
           values ('file', 'Attachment', $1, $2, to_timestamp($3) at time zone 'utc')`,
          [attRow.rows[0].id, blob.rows[0].id, m.epoch]
        );

        puestos++;
        onProgress(puestos, totalEnChat);
      }

      // Ya está el archivo real: sacamos el "[image/jpeg]" que se puso en la 1ª pasada
      // (solo si el contenido es exactamente ese marcador, nunca un texto del cliente).
      if (m.content === placeholderFor(m.attachments[0])) {
        await client.query("update messages set content = '' where id = $1", [messageId]);
      }
    }
    await client.query("commit");
    return { puestos };
  } catch (e) {
    // El rollback va en su propio try: si lo que falló fue la CONEXIÓN, este query
    // también revienta, y antes eso salteaba la limpieza de archivos — dejando en el
    // staging los que ya se habían copiado, sin fila que los referencie (peso muerto que
    // después se sube al servidor para nada). La limpieza tiene que correr siempre.
    try { await client.query("rollback"); } catch {}
    for (const f of copiedFiles) {
      try { fs.unlinkSync(f); } catch {}
    }
    throw e;
  }
}

async function runAttachmentPass() {
  await ensureConfig(["EXPORT_DIR", "DATABASE_URL"]);
  await ensureDestino(); // los adjuntos se cuelgan SOLO a lo importado en esta bandeja
  await ensureConfig(["STORAGE_ROOT"]);
  refreshConfig();
  info(`Se van a colgar los adjuntos de lo importado en la bandeja ${INBOX_ID}.`);

  const { conversations, contactsByJid } = loadExport();
  const client = await connectDb();

  try {
    // Chats ya importados EN ESTA BANDEJA, y cuáles ya tienen adjuntos colgados (para
    // poder reanudar).
    //
    // El filtro por inbox_id es crítico: sin él, esta pasada agarraba las conversaciones
    // del MISMO contacto importadas para otro número e intentaba colgarles los
    // archivos del segundo export. La verificación de EMATCH lo frenaba en la práctica
    // —compara cantidad de mensajes y fecha exacta antes de tocar nada—, pero un chat
    // corto que casualmente coincidiera habría recibido archivos de otra conversación.
    const yaImportados = await client.query(
      `select c.id, c.additional_attributes->>'chat_id' as chat_id,
              count(a.id) as adjuntos
       from conversations c
       left join messages m on m.conversation_id = c.id
       left join attachments a on a.message_id = m.id
       where c.account_id = $1 and c.inbox_id = $2
         and c.additional_attributes->>'imported_from' = $3
       group by c.id`,
      [ACCOUNT_ID, INBOX_ID, IMPORT_MARKER]
    );
    const porJid = new Map(yaImportados.rows.map((r) => [r.chat_id, r]));

    const cola = [];
    let totalAdjuntos = 0;
    for (const conv of conversations) {
      const fila = porJid.get(conv.contact_identifier);
      if (!fila) continue;                       // ese chat todavía no se importó
      if (Number(fila.adjuntos) > 0) continue;   // ya tiene adjuntos: no repetir
      const n = conv.messages.reduce((acc, m) => acc + (m.attachments || []).length, 0);
      if (!n) continue;
      cola.push({ conv, conversationId: fila.id, n });
      totalAdjuntos += n;
    }

    if (!cola.length) {
      info("No hay adjuntos pendientes: o ya están todos, o todavía no importaste los chats.");
      return;
    }

    // Mismo criterio que la pasada de mensajes: lo más reciente primero, así los chats de
    // la última semana quedan completos (con sus fotos) desde el arranque.
    cola.sort((a, b) => lastRawEpoch(b.conv) - lastRawEpoch(a.conv));

    info(`${cola.length} chat(s) con adjuntos pendientes — ${totalAdjuntos} archivos en total.`);
    info(`Se guardan en ${STORAGE_ROOT} y después se suben al servidor con la opción 7.\n`);

    let hechos = 0, chatsOk = 0, fallidos = 0;
    const errores = [];

    // Mismo freno que la pasada de mensajes: si se cae el túnel (o internet), TODOS los
    // chats siguientes van a fallar igual. Sin esto, una corrida grande quema la
    // lista entera en segundos marcando todo como error, y encima ensucia
    // errores-adjuntos.json con miles de fallas que no son del chat sino de la conexión.
    // Lo ya colgado queda en la base, así que volver a correr retoma donde quedó.
    const MAX_FALLOS_SEGUIDOS = 5;
    let consecutivos = 0;
    let abortado = null;

    for (const item of cola) {
      const jid = item.conv.contact_identifier;
      const nombre = contactsByJid.get(jid)?.name || jid;
      try {
        progressBar(hechos, totalAdjuntos, `${nombre.slice(0, 30)} · abriendo`);
        const res = await addAttachmentsToChat(client, item.conv, item.conversationId, (n, tot) => {
          progressBar(hechos + n, totalAdjuntos, `${nombre.slice(0, 26)} · ${n}/${tot} archivos`);
        });
        hechos += res.puestos || 0;
        chatsOk++;
        consecutivos = 0;
        progressBar(hechos, totalAdjuntos, `${nombre.slice(0, 30)} · listo`);
      } catch (e) {
        endProgressBar();
        fallidos++;
        consecutivos++;
        errores.push({ jid, nombre, error: e.message, detalle: e.detail });
        fail(`${nombre}: ${e.message}`);

        if (consecutivos >= MAX_FALLOS_SEGUIDOS) {
          abortado = `${consecutivos} fallos seguidos — se corta acá para no quemar la lista entera.`;
          break;
        }
      }
    }
    endProgressBar();

    if (abortado) {
      warn(`\nPASADA CORTADA: ${abortado}`);
      warn("Revisá que el túnel SSH siga abierto y volvé a correr esta opción: retoma donde quedó.");
    }

    panel([
      "Adjuntos procesados",
      `Chats con adjuntos:  ${chatsOk}`,
      `Archivos colgados:   ${hechos}`,
      `Chats con problema:  ${fallidos}`,
      `Pendientes:          ${cola.length - chatsOk - fallidos}`,
    ], fallidos ? "amber" : "green");

    if (errores.length) {
      fs.writeFileSync("errores-adjuntos.json", JSON.stringify(errores, null, 2));
      warn("Detalle de los chats que se saltearon en errores-adjuntos.json");
    }
    if (hechos) {
      info("Siguiente paso: opción 7 para subir los archivos al servidor.");
    }
  } finally {
    await client.end();
  }
}

async function runImport(opts = {}) {
  // Esta pasada es solo texto: los adjuntos se cuelgan después con la opción 6, así que
  // acá no hace falta STORAGE_ROOT.
  await ensureConfig(["EXPORT_DIR", "DATABASE_URL"]);
  await ensureDestino(); // cuenta / bandeja (por número de teléfono) / agente
  refreshConfig();

  const { conversations, contactsByJid } = loadExport();
  const state = loadState();
  const wanted = opts.chats || (opts.chat ? [opts.chat] : null);

  // Ventana temporal: `mesesDesde` deja solo lo de los últimos N meses; `mesesHasta`
  // deja solo lo ANTERIOR a esos N meses (para la segunda tanda, el historial viejo).
  const ahora = Math.floor(Date.now() / 1000);
  const corte = opts.meses ? ahora - opts.meses * 30.44 * 24 * 3600 : null;

  let pending = conversations.filter((conv) => {
    const jid = conv.contact_identifier;
    if (SKIP_CHAT_IDS.has(jid)) return false;
    if (state.importados[claveEstado(jid)]) return false;
    if (wanted && !wanted.includes(jid)) return false;
    if (corte !== null) {
      const ep = lastRawEpoch(conv);
      if (opts.soloViejos ? ep >= corte : ep < corte) return false;
    }
    return true;
  });

  if (!pending.length) {
    warn(wanted ? "Ninguno de esos chats está en el export, o ya fueron importados." : "Nada pendiente.");
    return;
  }

  info(`${pending.length} chat(s) pendientes. Conectando a la base ...`);
  const client = await connectDb();

  info("Cargando los contactos que ya existen en Chatwoot ...");
  const index = await loadContactIndex(client);
  ok(`${index.byPhone.size} contactos con teléfono indexados para no duplicar.`);

  // El orden se decide DESPUÉS de tener el índice, porque para priorizar los chats que
  // ya tienen contacto con nombre hay que saber cuáles son.
  if (opts.sortBy === "biggest") {
    pending.sort((a, b) => b.messages.length - a.messages.length);
  } else {
    const conNombre = new Map();
    for (const conv of pending) {
      const r = resolverContacto(index, conv.contact_identifier, jidToIdentity(conv.contact_identifier));
      conNombre.set(conv, r.tipo === "existente" && esNombreReal(r.contacto.name));
    }
    pending.sort((a, b) => {
      // 1º los que ya tienen ficha con nombre real; dentro de cada grupo, el más reciente
      if (opts.nombresPrimero && conNombre.get(a) !== conNombre.get(b)) {
        return conNombre.get(a) ? -1 : 1;
      }
      return lastRawEpoch(b) - lastRawEpoch(a);
    });
    if (opts.nombresPrimero) {
      const n = [...conNombre.values()].filter(Boolean).length;
      info(`Orden: primero los ${n} chats que ya tienen contacto con nombre, después los ${pending.length - n} restantes.`);
    }
  }
  if (opts.limit) pending = pending.slice(0, opts.limit);
  console.log("");

  let done = 0, failed = 0, alreadyIn = 0, totalMsgs = 0;
  let consecutivos = 0;
  let abortado = null;
  const errores = [];

  // Si se cae el túnel SSH (o la base), TODOS los chats siguientes van a fallar igual.
  // Sin este freno, una corrida grande quema la lista entera en segundos
  // marcando todo como error. Mejor cortar y que el usuario reintente: lo ya importado
  // queda guardado en estado.json y la próxima corrida sigue donde quedó.
  const MAX_FALLOS_SEGUIDOS = 5;

  try {
    for (const [i, conv] of pending.entries()) {
      const jid = conv.contact_identifier;
      const nombre = contactsByJid.get(jid)?.name || jid;
      progressBar(i, pending.length, nombre.slice(0, 34));
      try {
        // Los chats grandes tardan; sin este avance por lote la pantalla parecía colgada.
        // El i + fracción hace que la barra también se mueva dentro del chat.
        const res = await importChat(client, index, conv, contactsByJid, (hechos, total) => {
          progressBar(i + hechos / total, pending.length, `${nombre.slice(0, 28)} · ${hechos}/${total} msg`);
        });
        endProgressBar();
        consecutivos = 0;
        if (res.skipped) {
          state.importados[claveEstado(jid)] = { skipped: true };
        } else if (res.alreadyInDb) {
          state.importados[claveEstado(jid)] = { conversation_id: res.conversationId };
          alreadyIn++;
          info(`${jid}: ya estaba en la base (conv ${res.conversationId})`);
        } else {
          state.importados[claveEstado(jid)] = { conversation_id: res.conversationId, mensajes: res.messages };
          totalMsgs += res.messages;
          done++;
          ok(`${jid}: conversación #${res.displayId} con ${res.messages} mensajes`);
        }
        saveState(state);
      } catch (e) {
        endProgressBar();
        failed++;
        consecutivos++;
        errores.push({ jid, error: e.message });
        fail(`${jid}: ${e.message}`);

        if (consecutivos >= MAX_FALLOS_SEGUIDOS) {
          abortado = `${consecutivos} fallos seguidos — se corta acá para no quemar la lista entera.`;
          break;
        }
      }

      // Respiro entre chats: por defecto ninguno (el script es secuencial, un chat por vez,
      // así que ya es suave con el servidor). Subir IMPORT_PAUSE_MS en .env si se quiere
      // bajar más la carga en el servidor mientras hay gente trabajando.
      const pausa = Number(process.env.IMPORT_PAUSE_MS || 0);
      if (pausa > 0) await new Promise((r) => setTimeout(r, pausa));
    }
    if (!abortado) {
      progressBar(pending.length, pending.length, "listo");
      endProgressBar();
    }
  } finally {
    await client.end();
  }

  if (abortado) {
    warn(`\nIMPORTACIÓN CORTADA: ${abortado}`);
    warn("Revisá que el túnel SSH siga abierto y volvé a correr: retoma donde quedó.");
  }

  const resumen = [
    "Importación terminada",
    `Chats importados:   ${done}`,
    `Mensajes:            ${totalMsgs}`,
    `Ya estaban (dupe):   ${alreadyIn}`,
    `Errores:             ${failed}`,
  ];
  panel(resumen, failed ? "amber" : "green");
  if (failed) {
    fs.writeFileSync("errores-import.json", JSON.stringify(errores, null, 2));
    warn("Los chats con error quedan pendientes (se reintentan al volver a correr) — detalle en errores-import.json");
  }

  if (contactosAmbiguos.length) {
    fs.writeFileSync("contactos-ambiguos.json", JSON.stringify(contactosAmbiguos, null, 2));
    warn(
      `${contactosAmbiguos.length} chat(s) con teléfono ambiguo (coincide en los últimos 8 dígitos con más ` +
      `de un contacto existente): se crearon como contacto NUEVO en vez de arriesgar la fusión. ` +
      `Revisar y unificar a mano en Chatwoot — detalle en contactos-ambiguos.json`
    );
  }
}

// ---------- Undo ----------

async function runUndo() {
  await ensureConfig(["DATABASE_URL"]);
  await ensureDestino(); // hay que saber QUÉ bandeja se va a vaciar
  refreshConfig();
  const client = await connectDb();

  try {
    // El borrado va SIEMPRE acotado a una bandeja. Con varios números importados a la
    // misma cuenta (sucursal A, sucursal B, sucursal C...), un undo global se llevaba puesto
    // el historial de todos — decenas de miles de mensajes ajenos a lo que se quería
    // deshacer.
    const porInbox = await client.query(
      `select c.inbox_id, i.name, count(*) as convs
       from conversations c join inboxes i on i.id = c.inbox_id
       where c.account_id = $1 and c.additional_attributes->>'imported_from' = $2
       group by 1, 2 order by 1`,
      [ACCOUNT_ID, IMPORT_MARKER]
    );

    if (!porInbox.rows.length) {
      info("No hay nada importado por este script en la base.");
      return;
    }

    if (porInbox.rows.length > 1) {
      console.log(bold("\nHistorial importado en esta cuenta:"));
      for (const r of porInbox.rows) {
        const marca = Number(r.inbox_id) === INBOX_ID ? "  <- se va a borrar SOLO esta" : "";
        console.log(`  inbox ${r.inbox_id}  ${r.name.padEnd(32)} ${String(r.convs).padStart(6)} conversaciones${marca}`);
      }
      console.log("");
    }

    const convs = await client.query(
      `select id from conversations
       where account_id = $1 and inbox_id = $2 and additional_attributes->>'imported_from' = $3`,
      [ACCOUNT_ID, INBOX_ID, IMPORT_MARKER]
    );
    const convIds = convs.rows.map((r) => r.id);
    if (!convIds.length) {
      const destino = porInbox.rows.find((r) => Number(r.inbox_id) === INBOX_ID);
      info(`La bandeja ${INBOX_ID} no tiene nada importado por este script.${destino ? "" : " (Lo importado está en otra bandeja — cambiala con la opción 10.)"}`);
      return;
    }

    const nombreInbox = porInbox.rows.find((r) => Number(r.inbox_id) === INBOX_ID)?.name || `inbox ${INBOX_ID}`;
    const answer = await ask(
      `Se van a borrar ${convIds.length} conversaciones importadas en "${nombreInbox}" ` +
      `(con sus mensajes y adjuntos). El historial de las demás bandejas NO se toca. ` +
      `¿Seguro? (escribí "borrar"): `
    );
    if (answer.toLowerCase() !== "borrar") {
      info("Cancelado.");
      return;
    }

    await client.query("begin");

    const blobs = await client.query(
      `select b.id, b.key, asa.id as asa_id, a.id as att_id
       from attachments a
       join messages m on m.id = a.message_id
       join active_storage_attachments asa on asa.record_type = 'Attachment' and asa.record_id = a.id
       join active_storage_blobs b on b.id = asa.blob_id
       where m.conversation_id = any($1)`,
      [convIds]
    );

    await client.query(
      `delete from active_storage_attachments where id = any($1)`,
      [blobs.rows.map((r) => r.asa_id)]
    );
    await client.query(`delete from active_storage_blobs where id = any($1)`, [blobs.rows.map((r) => r.id)]);
    await client.query(
      `delete from attachments where message_id in (select id from messages where conversation_id = any($1))`,
      [convIds]
    );
    await client.query(`delete from messages where conversation_id = any($1)`, [convIds]);
    await client.query(`delete from conversations where id = any($1)`, [convIds]);

    // contactos creados por el import que quedaron sin ninguna conversación
    const orphans = await client.query(
      `select c.id from contacts c
       where c.account_id = $1 and c.additional_attributes->>'imported_from' = $2
         and not exists (select 1 from conversations v where v.contact_id = c.id)`,
      [ACCOUNT_ID, IMPORT_MARKER]
    );
    const orphanIds = orphans.rows.map((r) => r.id);
    if (orphanIds.length) {
      await client.query(`delete from contact_inboxes where contact_id = any($1)`, [orphanIds]);
      await client.query(`delete from contacts where id = any($1)`, [orphanIds]);
    }

    await client.query("commit");

    let filesRemoved = 0;
    if (STORAGE_ROOT) {
      for (const r of blobs.rows) {
        try {
          fs.unlinkSync(blobDiskPath(r.key));
          filesRemoved++;
        } catch {}
      }
    }

    // Del estado local se borran SOLO las entradas de esta bandeja: el avance de los
    // otros números importados tiene que sobrevivir al undo.
    const estado = loadState();
    const prefijo = `${INBOX_ID}|`;
    for (const clave of Object.keys(estado.importados)) {
      if (clave.startsWith(prefijo)) delete estado.importados[clave];
    }
    saveState(estado);

    panel([
      "Deshecho",
      `Bandeja:                 ${nombreInbox}`,
      `Conversaciones borradas: ${convIds.length}`,
      `Adjuntos borrados:       ${blobs.rows.length} (${filesRemoved} archivos del storage)`,
      `Contactos borrados:      ${orphanIds.length}`,
    ]);
  } catch (e) {
    try { await client.query("rollback"); } catch {}
    throw e;
  } finally {
    await client.end();
  }
}

// ---------- Elegir el destino (cuenta / inbox / agente) ----------

// Pedir el INBOX_ID pelado obligaba a correr el reconocimiento aparte, anotar un número
// interno y tipearlo a ciegas — con el riesgo de mandar todo el historial a la bandeja
// equivocada. Acá se listan las bandejas reales CON SU TELÉFONO y se elige de la lista
// (o pegando el número, que es como uno lo tiene en la cabeza).
async function elegirInbox(client) {
  const { rows } = await client.query(
    `select i.id, i.name, i.channel_type,
            coalesce(w.phone_number, '') as phone_number,
            coalesce(w.provider, '') as provider
     from inboxes i
     left join channel_whatsapp w on i.channel_type = 'Channel::Whatsapp' and w.id = i.channel_id
     where i.account_id = $1
     order by (i.channel_type = 'Channel::Whatsapp') desc, i.id`,
    [ACCOUNT_ID]
  );

  if (!rows.length) {
    throw new WaError(
      "EINBOX", `La cuenta ${ACCOUNT_ID} no tiene ninguna bandeja de entrada`,
      "Creá primero la bandeja de WhatsApp en Chatwoot (Configuración > Bandejas de entrada)."
    );
  }

  console.log(bold("\n¿A qué número (bandeja de entrada) van los chats importados?\n"));
  rows.forEach((r, i) => {
    const tel = r.phone_number ? r.phone_number : "(sin número asociado)";
    const tipo = r.channel_type.replace("Channel::", "");
    console.log(`  ${String(i + 1).padStart(2)}) ${tel.padEnd(18)} ${r.name}   [${tipo}${r.provider ? ", " + r.provider : ""}]`);
  });
  console.log("");
  warn("El historial va a aparecer dentro de esa bandeja, con las fechas reales.");
  console.log("");

  while (true) {
    const raw = await ask(`Elegí el número de la lista (1-${rows.length}), o pegá el teléfono con +55: `);
    const limpio = raw.trim();

    const porLista = Number(limpio);
    if (Number.isInteger(porLista) && rows[porLista - 1]) return rows[porLista - 1];

    // pegó el teléfono: se comparan solo los dígitos, así da igual el formato
    const digitos = limpio.replace(/\D/g, "");
    if (digitos.length >= 8) {
      const match = rows.filter((r) => r.phone_number.replace(/\D/g, "").endsWith(digitos.slice(-8)));
      if (match.length === 1) return match[0];
      if (match.length > 1) {
        warn("Ese número coincide con más de una bandeja — elegila por número de la lista.");
        continue;
      }
      warn(`Ninguna bandeja de esta cuenta tiene el número ${limpio}.`);
      warn("Si es un número nuevo, primero hay que crear su bandeja en Chatwoot (Configuración > Bandejas de entrada).");
      continue;
    }

    warn("No entendí. Escribí el número de la lista o pegá el teléfono completo.");
  }
}

async function elegirDeLista(titulo, rows, formato) {
  console.log(bold(`\n${titulo}\n`));
  rows.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}) ${formato(r)}`));
  while (true) {
    const n = Number((await ask(`\nElegí (1-${rows.length}): `)).trim());
    if (Number.isInteger(n) && rows[n - 1]) return rows[n - 1];
    warn("Opción inválida.");
  }
}

// Completa cuenta, bandeja y agente eligiéndolos de la base. Con forzar=true los vuelve a
// preguntar aunque ya estén guardados (para cambiar de destino sin editar el .env a mano).
async function ensureDestino({ forzar = false } = {}) {
  await ensureConfig(["DATABASE_URL"]);
  if (forzar) {
    for (const k of ["ACCOUNT_ID", "INBOX_ID", "AGENT_USER_ID"]) delete process.env[k];
    refreshConfig();
  }
  if (ACCOUNT_ID && INBOX_ID && AGENT_USER_ID) return;

  const client = await connectDb();
  try {
    if (!ACCOUNT_ID) {
      const cuentas = (await client.query("select id, name from accounts order by id")).rows;
      const elegida = cuentas.length === 1
        ? cuentas[0]
        : await elegirDeLista("¿En qué cuenta de Chatwoot?", cuentas, (c) => `${c.name}  (id ${c.id})`);
      process.env.ACCOUNT_ID = String(elegida.id);
      saveToEnvFile({ ACCOUNT_ID: String(elegida.id) });
      refreshConfig();
      ok(`Cuenta: ${elegida.name}`);
    }

    if (!INBOX_ID) {
      const inbox = await elegirInbox(client);
      process.env.INBOX_ID = String(inbox.id);
      saveToEnvFile({ INBOX_ID: String(inbox.id) });
      refreshConfig();
      ok(`Bandeja destino: ${inbox.name}${inbox.phone_number ? ` (${inbox.phone_number})` : ""}`);
    }

    if (!AGENT_USER_ID) {
      const usuarios = (await client.query(
        `select u.id, u.name, u.email, au.role from users u
         join account_users au on au.user_id = u.id and au.account_id = $1
         order by (au.role = 'administrator') desc, u.id`,
        [ACCOUNT_ID]
      )).rows;
      if (!usuarios.length) {
        throw new WaError("EUSER", `La cuenta ${ACCOUNT_ID} no tiene usuarios`, "Revisá la cuenta elegida.");
      }
      const elegido = await elegirDeLista(
        "¿Qué usuario figura como remitente de los mensajes que enviaste vos?",
        usuarios,
        (u) => `${u.name} <${u.email}>  (${u.role})`
      );
      process.env.AGENT_USER_ID = String(elegido.id);
      saveToEnvFile({ AGENT_USER_ID: String(elegido.id) });
      refreshConfig();
      ok(`Remitente de los salientes: ${elegido.name}`);
    }
  } finally {
    await client.end();
  }
}

// Resumen del destino actual, para que quede a la vista antes de importar.
async function mostrarDestino() {
  if (!ACCOUNT_ID || !INBOX_ID) return;
  try {
    const client = await connectDb();
    try {
      const { rows } = await client.query(
        `select i.name, coalesce(w.phone_number, '') as phone_number
         from inboxes i
         left join channel_whatsapp w on i.channel_type = 'Channel::Whatsapp' and w.id = i.channel_id
         where i.id = $1`,
        [INBOX_ID]
      );
      if (rows.length) {
        const tel = rows[0].phone_number || "sin número";
        console.log(c("dim", `  destino: ${rows[0].name} · ${tel}  (cuenta ${ACCOUNT_ID}, inbox ${INBOX_ID})`));
      }
    } finally {
      await client.end();
    }
  } catch {
    // sin base a mano (túnel cerrado): no es motivo para no mostrar el menú
    console.log(c("dim", `  destino: cuenta ${ACCOUNT_ID}, inbox ${INBOX_ID} (no se pudo consultar el nombre)`));
  }
}

// ---------- Menú interactivo ----------

async function menu() {
  // Todo lo que falte en .env se pregunta de entrada, antes del menú. Cuenta/inbox/agente
  // son "opcionales acá" (Enter si todavía no corriste el reconocimiento) pero vuelven a
  // pedirse — ya en serio, sin Enter posible — apenas se elige importar algo de verdad.
  await ensureConfig(
    ["EXPORT_DIR", "DATABASE_URL", "ACCOUNT_ID", "INBOX_ID", "AGENT_USER_ID"],
    { optional: ["ACCOUNT_ID", "INBOX_ID", "AGENT_USER_ID"] }
  );
  refreshConfig();
  // El destino (cuenta/bandeja/agente) se elige de una lista con los teléfonos reales
  // recién al importar — ver ensureDestino. Acá solo se muestra el que esté guardado.

  while (true) {
    console.log("");
    banner("Importador de historial WhatsApp -> Chatwoot", "inserción directa en Postgres — nada se envía a los clientes");
    await mostrarDestino();
    console.log("");
    console.log(bold("   Antes de importar — no escriben nada:"));
    console.log("1) Dry-run: estadísticas del export (ni siquiera se conecta a la base)");
    console.log("2) Reconocimiento de la base (cuenta, inbox, agentes, storage)");
    console.log("3) Verificar cómo van a quedar los nombres de contacto");
    console.log("4) Importar chats de PRUEBA (elegís de una lista — ideal 1-2)");
    console.log("");
    console.log(bold("   Importación — en este orden:"));
    console.log("5)   PASO 1: mensajes de los ÚLTIMOS 12 MESES        <- empezar acá");
    console.log("       (primero los que ya tienen contacto con nombre)");
    console.log("6)   PASO 2: colgar los adjuntos a lo ya importado");
    console.log("7)   PASO 3: subir los archivos al servidor");
    console.log("");
    console.log(bold("   Después, si hace falta:"));
    console.log("8) Mensajes del historial viejo (anterior a 12 meses)");
    console.log("9) Importar los N chats más grandes pendientes");
    console.log("");
    console.log("10) Cambiar el NÚMERO destino (cuenta / bandeja / agente)");
    console.log("00) Deshacer todo lo importado");
    console.log("0)  Salir");

    const choice = await ask("\nElegí una opción: ");
    console.log("");
    try {
      if (choice === "1") {
        dryRun(loadExport());
      } else if (choice === "2") {
        spawnSync(process.execPath, [fileURLToPath(new URL("recon.mjs", import.meta.url))], { stdio: "inherit" });
      } else if (choice === "3") {
        await runPreflight();
      } else if (choice === "4") {
        await runTestChatsFlow();
      } else if (choice === "5") {
        const answer = await ask(
          "Se importan los mensajes de los últimos 12 meses a la base REAL.\n" +
          "¿Ya hiciste el respaldo con pg_dump? Escribí SI para continuar: "
        );
        if (/^s[ií]$/i.test(answer)) await runImport({ meses: 12, nombresPrimero: true });
        else info("Cancelado.");
      } else if (choice === "6") {
        await runAttachmentPass();
      } else if (choice === "7") {
        await subirAdjuntos();
      } else if (choice === "8") {
        const answer = await ask(
          "Se importa el historial ANTERIOR a 12 meses.\n" +
          "Escribí SI para continuar: "
        );
        if (/^s[ií]$/i.test(answer)) await runImport({ meses: 12, soloViejos: true, nombresPrimero: true });
        else info("Cancelado.");
      } else if (choice === "9") {
        const n = Number(await ask("¿Cuántos chats? "));
        if (Number.isInteger(n) && n > 0) await runImport({ limit: n, sortBy: "biggest" });
        else warn("Cantidad inválida.");
      } else if (choice === "10") {
        await ensureDestino({ forzar: true });
      } else if (choice === "00") {
        await runUndo();
      } else if (choice === "0" || choice === "") {
        break;
      } else {
        warn("Opción inválida.");
      }
    } catch (e) {
      printError(e);
    }
  }
}

// ---------- Main ----------

try {
  if (flags.dryRun) {
    await ensureConfig(["EXPORT_DIR"]);
    refreshConfig();
    dryRun(loadExport());
  } else if (flags.undo) {
    await runUndo();
  } else if (flags.chat || flags.chats || flags.limit || flags.all) {
    await runImport({ chat: flags.chat, chats: flags.chats, limit: flags.limit });
  } else if (process.stdin.isTTY) {
    await menu();
  } else {
    console.error(
      "Sin terminal interactiva. Usá un flag explícito:\n" +
      "  --dry-run | --chat <jid> | --chats <jid1,jid2> | --limit N | --all | --undo"
    );
    process.exit(1);
  }
} catch (e) {
  printError(e);
  process.exit(1);
}
