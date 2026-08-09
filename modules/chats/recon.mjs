// Read-only inspection of the target Chatwoot instance.
// Run before importing to discover IDs and verify schema assumptions.

import pg from "pg";
import { ensureConfig } from "../../lib/config.mjs";
import { WaError, printError } from "../../lib/errors.mjs";
import { banner, warn } from "../../lib/ui.mjs";

let client;
try {
  await ensureConfig(["DATABASE_URL"]);
  client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
} catch (error) {
  printError(
    error instanceof WaError
      ? error
      : new WaError("EDB", "Could not connect to PostgreSQL", `${error.message} — Is the SSH tunnel still open? Is DATABASE_URL correct?`)
  );
  process.exit(1);
}

async function q(sql, params = []) {
  return (await client.query(sql, params)).rows;
}

async function section(title, fn) {
  console.log(`\n--- ${title} ---`);
  try {
    await fn();
  } catch (error) {
    warn(`Could not inspect this section: ${error.message}`);
  }
}

try {
  banner("Chatwoot inspection", "read-only — no UPDATE, INSERT, or DELETE statements");

  await section("Server", async () => {
    const pgVersion = await q("select version()");
    console.log(`  PostgreSQL: ${pgVersion[0].version.split(",")[0]}`);
    const migration = await q("select max(version) as v from schema_migrations");
    console.log(`  Latest schema migration: ${migration[0].v}`);
  });

  await section("Accounts", async () => {
    for (const account of await q("select id, name from accounts order by id")) {
      console.log(`  ACCOUNT_ID=${account.id}  ${account.name}`);
    }
  });

  let inboxes = [];
  await section("Inboxes (select the WhatsApp channel)", async () => {
    inboxes = await q(
      `select i.id, i.account_id, i.name, i.channel_type, i.channel_id,
              coalesce(w.phone_number, '') as phone_number, coalesce(w.provider, '') as provider
       from inboxes i
       left join channel_whatsapp w on i.channel_type = 'Channel::Whatsapp' and w.id = i.channel_id
       order by i.id`
    );
    for (const inbox of inboxes) {
      const extra = inbox.phone_number ? `  ${inbox.phone_number} (${inbox.provider})` : "";
      console.log(`  INBOX_ID=${inbox.id}  account ${inbox.account_id}  [${inbox.channel_type}]  ${inbox.name}${extra}`);
    }
  });

  await section("Users and agents (AGENT_USER_ID for outgoing messages)", async () => {
    for (const user of await q(
      `select u.id, u.name, u.email, au.role
       from users u join account_users au on au.user_id = u.id
       order by u.id`
    )) {
      console.log(`  AGENT_USER_ID=${user.id}  ${user.name} <${user.email}>  (${user.role})`);
    }
  });

  for (const inbox of inboxes.filter((item) => item.channel_type === "Channel::Whatsapp")) {
    await section(`source_id format in inbox ${inbox.id} (${inbox.name})`, async () => {
      const stats = await q(
        `select
           count(*) filter (where source_id ~ '^\\d+$') as digits_only,
           count(*) filter (where source_id !~ '^\\d+$') as other_format,
           count(*) as total
         from contact_inboxes where inbox_id = $1`,
        [inbox.id]
      );
      const { digits_only: digitsOnly, other_format: otherFormat, total } = stats[0];
      console.log(`  ${digitsOnly}/${total} contain digits only (the importer expects this format)`);
      if (Number(otherFormat) > 0) {
        console.log(`  ${otherFormat}/${total} use another format — sample contacts:`);
        const samples = await q(
          `select ci.source_id, c.id as contact_id, c.name, c.phone_number
           from contact_inboxes ci join contacts c on c.id = ci.contact_id
           where ci.inbox_id = $1 and ci.source_id !~ '^\\d+$'
           order by ci.id desc limit 5`,
          [inbox.id]
        );
        for (const sample of samples) {
          console.log(`    source_id=${sample.source_id}  contact #${sample.contact_id} "${sample.name}"  phone_number=${sample.phone_number || "(none)"}`);
        }
      }
    });
  }

  for (const inbox of inboxes.filter((item) => item.channel_type === "Channel::Whatsapp")) {
    await section(`Operational settings for inbox ${inbox.id} (${inbox.name})`, async () => {
      const [settings] = await q(
        `select lock_to_single_conversation, enable_auto_assignment, csat_survey_enabled,
                greeting_enabled, working_hours_enabled
         from inboxes where id = $1`,
        [inbox.id]
      );
      console.log(`  lock_to_single_conversation: ${settings.lock_to_single_conversation}`);
      console.log(
        settings.lock_to_single_conversation
          ? "    -> a new message reopens the contact's latest conversation, including an imported one"
          : "    -> a new message opens a new conversation and keeps imported history separate (recommended)"
      );
      console.log(`  enable_auto_assignment:      ${settings.enable_auto_assignment}`);
      console.log(`  greeting_enabled:            ${settings.greeting_enabled}`);
      console.log(`  working_hours_enabled:       ${settings.working_hours_enabled}`);

      const members = await q(
        `select u.id, u.name, u.email from inbox_members im
         join users u on u.id = im.user_id where im.inbox_id = $1 order by u.id`,
        [inbox.id]
      );
      if (!members.length) {
        console.log("  ASSIGNED AGENTS: none — nobody will see this inbox or its imported history");
      } else {
        console.log(`  Agents with access to this inbox (${members.length}):`);
        for (const member of members) console.log(`    #${member.id} ${member.name} <${member.email}>`);
      }
    });
  }

  await section("Import progress (wa_archive marker)", async () => {
    const [result] = await q(
      `select count(distinct c.id) as conversations, count(m.id) as messages,
              min(c.created_at)::date as first_date, max(c.last_activity_at)::date as last_date
       from conversations c left join messages m on m.conversation_id = c.id
       where c.additional_attributes->>'imported_from' = 'wa_archive'`
    );
    console.log(`  imported conversations: ${result.conversations} | messages: ${result.messages}`);
    if (Number(result.conversations) > 0) console.log(`  date range: ${result.first_date} → ${result.last_date}`);
    const [attachments] = await q(
      `select count(*) as n from attachments a join messages m on m.id = a.message_id
       join conversations c on c.id = m.conversation_id
       where c.additional_attributes->>'imported_from' = 'wa_archive'`
    );
    console.log(`  imported attachments: ${attachments.n}`);
  });

  await section("Conversation display_id sequences", async () => {
    const sequences = await q(`select sequencename from pg_sequences where sequencename like 'conv_dpid_seq_%'`);
    if (!sequences.length) console.log("  (none — stop and report this before importing)");
    for (const sequence of sequences) console.log(`  ${sequence.sequencename}`);
  });

  await section("attachments.file_type values in use", async () => {
    const fileTypes = await q(`select file_type, count(*) from attachments group by 1 order by 1`);
    if (!fileTypes.length) console.log("  (no attachments yet)");
    for (const row of fileTypes) console.log(`  ${row.file_type}: ${row.count}`);
    console.log("  importer mapping: image=0, audio=1, video=2, file=3");
  });

  await section("Storage services in use", async () => {
    const services = await q(`select service_name, count(*) from active_storage_blobs group by 1`);
    if (!services.length) console.log("  (no blobs yet — check ACTIVE_STORAGE_SERVICE in the container environment)");
    for (const service of services) console.log(`  ${service.service_name}: ${service.count} blobs`);
    console.log("  when the service is 'local', STORAGE_ROOT must point to the container's /app/storage volume");
  });

  await section("Current volume", async () => {
    const [counts] = await q(
      `select
         (select count(*) from contacts) as contacts,
         (select count(*) from conversations) as conversations,
         (select count(*) from messages) as messages`
    );
    console.log(`  contacts: ${counts.contacts} | conversations: ${counts.conversations} | messages: ${counts.messages}`);
  });

  console.log("\nDone. Use the values above for ACCOUNT_ID, INBOX_ID, and AGENT_USER_ID.");
} finally {
  await client.end();
}
