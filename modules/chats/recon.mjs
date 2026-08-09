// recon.mjs — Reconocimiento de la instancia de Chatwoot. SOLO LECTURA: únicamente SELECTs.
//
// Correr ANTES de importar nada. Muestra los datos que van en .env (ACCOUNT_ID,
// INBOX_ID, AGENT_USER_ID) y verifica los supuestos del importador contra la base real:
// formato de source_id, secuencia de display_id, versión de esquema.
//
//   node recon.mjs        (pregunta DATABASE_URL si falta)

import pg from "pg";
import { ensureConfig } from "../../lib/config.mjs"; // carga el .env de la raíz y pregunta la URL si falta
import { WaError, printError } from "../../lib/errors.mjs";
import { banner, warn } from "../../lib/ui.mjs";

let client;
try {
  await ensureConfig(["DATABASE_URL"]);
  client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
} catch (e) {
  printError(
    e instanceof WaError
      ? e
      : new WaError("EDB", "No se pudo conectar a Postgres", `${e.message} — ¿el túnel SSH sigue abierto? ¿DATABASE_URL es correcta?`)
  );
  process.exit(1);
}

async function q(sql, params = []) {
  return (await client.query(sql, params)).rows;
}

// una sección que falla no corta el resto del reconocimiento
async function section(title, fn) {
  console.log(`\n--- ${title} ---`);
  try {
    await fn();
  } catch (e) {
    warn(`no se pudo: ${e.message}`);
  }
}

try {
  banner("Reconocimiento de Chatwoot", "solo lectura — ningún UPDATE/INSERT/DELETE");

  await section("Servidor", async () => {
    const pgVersion = await q("select version()");
    console.log(`  Postgres: ${pgVersion[0].version.split(",")[0]}`);
    const migration = await q("select max(version) as v from schema_migrations");
    console.log(`  Última migración de esquema: ${migration[0].v}`);
  });

  await section("Cuentas", async () => {
    for (const a of await q("select id, name from accounts order by id")) {
      console.log(`  ACCOUNT_ID=${a.id}  ${a.name}`);
    }
  });

  let inboxes = [];
  await section("Inboxes (buscá el del canal WhatsApp)", async () => {
    inboxes = await q(
      `select i.id, i.account_id, i.name, i.channel_type, i.channel_id,
              coalesce(w.phone_number, '') as phone_number, coalesce(w.provider, '') as provider
       from inboxes i
       left join channel_whatsapp w on i.channel_type = 'Channel::Whatsapp' and w.id = i.channel_id
       order by i.id`
    );
    for (const i of inboxes) {
      const extra = i.phone_number ? `  ${i.phone_number} (${i.provider})` : "";
      console.log(`  INBOX_ID=${i.id}  cuenta ${i.account_id}  [${i.channel_type}]  ${i.name}${extra}`);
    }
  });

  await section("Usuarios/agentes (para AGENT_USER_ID de los salientes)", async () => {
    for (const u of await q(
      `select u.id, u.name, u.email, au.role
       from users u join account_users au on au.user_id = u.id
       order by u.id`
    )) {
      console.log(`  AGENT_USER_ID=${u.id}  ${u.name} <${u.email}>  (${u.role})`);
    }
  });

  for (const wa of inboxes.filter((i) => i.channel_type === "Channel::Whatsapp")) {
    await section(`Formato de source_id en el inbox ${wa.id} (${wa.name})`, async () => {
      const stats = await q(
        `select
           count(*) filter (where source_id ~ '^\\d+$') as solo_digitos,
           count(*) filter (where source_id !~ '^\\d+$') as otro_formato,
           count(*) as total
         from contact_inboxes where inbox_id = $1`,
        [wa.id]
      );
      const { solo_digitos, otro_formato, total } = stats[0];
      console.log(`  ${solo_digitos}/${total} son solo dígitos (formato esperado por el importador)`);
      if (Number(otro_formato) > 0) {
        console.log(`  ${otro_formato}/${total} tienen OTRO formato — muestras con su contacto y teléfono:`);
        const samples = await q(
          `select ci.source_id, c.id as contact_id, c.name, c.phone_number
           from contact_inboxes ci join contacts c on c.id = ci.contact_id
           where ci.inbox_id = $1 and ci.source_id !~ '^\\d+$'
           order by ci.id desc limit 5`,
          [wa.id]
        );
        for (const s of samples) {
          console.log(`    source_id=${s.source_id}  contacto #${s.contact_id} "${s.name}"  phone_number=${s.phone_number || "(sin teléfono)"}`);
        }
      }
    });
  }

  // Lo que decide qué ven los agentes y qué pasa cuando entra un mensaje real:
  // sin esto, el historial puede quedar invisible (agente no asignado al inbox) o
  // mezclarse con las conversaciones vivas (lock_to_single_conversation).
  for (const wa of inboxes.filter((i) => i.channel_type === "Channel::Whatsapp")) {
    await section(`Ajustes operativos del inbox ${wa.id} (${wa.name})`, async () => {
      const cfg = await q(
        `select lock_to_single_conversation, enable_auto_assignment, csat_survey_enabled,
                greeting_enabled, working_hours_enabled
         from inboxes where id = $1`,
        [wa.id]
      );
      const c = cfg[0];
      console.log(`  lock_to_single_conversation: ${c.lock_to_single_conversation}`);
      console.log(
        c.lock_to_single_conversation
          ? "    -> un mensaje nuevo REABRE la última conversación del contacto (incluida la importada)"
          : "    -> un mensaje nuevo abre una conversación NUEVA; el historial importado queda aparte (recomendado)"
      );
      console.log(`  enable_auto_assignment:      ${c.enable_auto_assignment}`);
      console.log(`  greeting_enabled:            ${c.greeting_enabled}`);
      console.log(`  working_hours_enabled:       ${c.working_hours_enabled}`);

      const members = await q(
        `select u.id, u.name, u.email from inbox_members im
         join users u on u.id = im.user_id where im.inbox_id = $1 order by u.id`,
        [wa.id]
      );
      if (!members.length) {
        console.log("  AGENTES ASIGNADOS: ninguno — NADIE va a ver este inbox (ni el historial importado)");
      } else {
        console.log(`  Agentes con acceso a este inbox (${members.length}):`);
        for (const m of members) console.log(`    #${m.id} ${m.name} <${m.email}>`);
      }
    });
  }

  await section("Progreso de la importación (marcador wa_archive)", async () => {
    const imp = await q(
      `select count(distinct c.id) as conversaciones, count(m.id) as mensajes,
              min(c.created_at)::date as desde, max(c.last_activity_at)::date as hasta
       from conversations c left join messages m on m.conversation_id = c.id
       where c.additional_attributes->>'imported_from' = 'wa_archive'`
    );
    const r = imp[0];
    console.log(`  conversaciones importadas: ${r.conversaciones} | mensajes: ${r.mensajes}`);
    if (Number(r.conversaciones) > 0) console.log(`  rango de fechas: ${r.desde} → ${r.hasta}`);
    const adj = await q(
      `select count(*) as n from attachments a join messages m on m.id = a.message_id
       join conversations c on c.id = m.conversation_id
       where c.additional_attributes->>'imported_from' = 'wa_archive'`
    );
    console.log(`  adjuntos importados: ${adj[0].n}`);
  });

  await section("Secuencias de display_id de conversaciones", async () => {
    const seqs = await q(`select sequencename from pg_sequences where sequencename like 'conv_dpid_seq_%'`);
    if (!seqs.length) console.log("  (ninguna — ESTO SERÍA UN PROBLEMA, avisar antes de importar)");
    for (const s of seqs) console.log(`  ${s.sequencename}`);
  });

  await section("Enum real de attachments.file_type en uso", async () => {
    const ft = await q(`select file_type, count(*) from attachments group by 1 order by 1`);
    if (!ft.length) console.log("  (sin adjuntos todavía)");
    for (const r of ft) console.log(`  ${r.file_type}: ${r.count}`);
    console.log("  el importador usa: image=0, audio=1, video=2, file=3");
  });

  await section("Storage (active_storage_blobs.service_name en uso)", async () => {
    const services = await q(`select service_name, count(*) from active_storage_blobs group by 1`);
    if (!services.length) console.log("  (sin blobs todavía — revisar ACTIVE_STORAGE_SERVICE en el entorno del contenedor)");
    for (const s of services) console.log(`  ${s.service_name}: ${s.count} blobs`);
    console.log("  si es 'local', STORAGE_ROOT debe apuntar al volumen de /app/storage del contenedor");
  });

  await section("Volumen actual", async () => {
    const counts = await q(
      `select
         (select count(*) from contacts) as contactos,
         (select count(*) from conversations) as conversaciones,
         (select count(*) from messages) as mensajes`
    );
    console.log(`  contactos: ${counts[0].contactos} | conversaciones: ${counts[0].conversaciones} | mensajes: ${counts[0].mensajes}`);
  });

  console.log("\nListo. Completá .env con ACCOUNT_ID, INBOX_ID y AGENT_USER_ID según lo de arriba.");
} finally {
  await client.end();
}
