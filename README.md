# WhatsApp Business Android Backup to Chatwoot

[Español](README.es.md) · **English**

Open-source Windows tool for backing up **WhatsApp Business for Android**, exporting
its history, and importing contacts, conversations, and attachments into Chatwoot.

Everything runs on the user's computer. Backups, contacts, messages, API tokens,
database passwords, and SSH keys are excluded from Git.

> [!IMPORTANT]
> This project supports the **Android WhatsApp Business app only**. It does not
> support iPhone/iOS, the regular WhatsApp consumer app, or WhatsApp Cloud API
> backups.

> [!CAUTION]
> This is an experimental community project. It is not an official WhatsApp or
> Chatwoot product. Historical chat import writes directly to Chatwoot's
> PostgreSQL database and may break when Chatwoot changes its schema. Test on a
> disposable/staging instance and create a verified `pg_dump` before touching
> production. A paid Chatwoot plan does not make this tool officially supported.

## What can it do?

| Task | Chatwoot Cloud | Self-hosted Chatwoot |
|---|---:|---:|
| Back up and export WhatsApp Business | Yes; Chatwoot is not required | Yes |
| Import contacts through the Chatwoot API | Yes | Yes |
| Import chats with their historical timestamps | No | Yes; SSH and PostgreSQL required |
| Import historical attachments | No | Yes; SSH and storage access required |

Chatwoot's API is available for Cloud and self-hosted installations. Administrative
PostgreSQL access is only possible on a self-hosted installation. If a hosting
provider does not give you SSH and database access, use only backup/export and
contact import.

## Requirements

- Windows 10 or Windows 11.
- [Node.js](https://nodejs.org/) 22.13 or newer; Node.js 24 LTS is recommended.
- An **Android** phone with WhatsApp Business installed.
- A complete copy of the Android `WhatsApp Business` folder and, if the database
  is encrypted, its 64-digit key.
- For contacts: a Chatwoot URL and a user access token with access to the account.
- For chats: self-hosted Chatwoot, administrative SSH access, PostgreSQL access,
  and access to the attachment storage.
- Windows OpenSSH Client for server detection and the database tunnel.
- Python 3.12 for backup processing. The wizard can install it through `winget`.

## Install

### Download a ZIP

1. On GitHub, select **Code → Download ZIP**.
2. Extract the entire ZIP to a local folder. Do not run `run.bat` from inside
   the compressed file.
3. Double-click `run.bat`.

### Clone with Git

```powershell
git clone https://github.com/argel-gomez/wp-backup-to-chatwoot.git
cd wp-backup-to-chatwoot
.\run.bat
```

The first run installs Node.js dependencies and creates a local `.env` from
`.env.example`.

### Automatic dependency setup

- **Node.js itself:** must be installed first. `run.bat` checks the version and
  prints the official `winget` command if it is missing or too old.
- **Node packages:** installed automatically with `npm ci` on the first run,
  using the exact versions in `package-lock.json`.
- **Python:** needed only for backup/export. Option 1 installs Python 3.12 through
  `winget` when Python is missing.
- **Python packages:** installed by the backup wizard when required.
- **OpenSSH Client:** required only for self-hosted chat import and must be enabled
  in Windows Optional Features if it is not already present.
- **ADB:** not required for normal USB file transfer and is never installed
  automatically. Install Google's Platform Tools only for the optional ADB method.

Package installation requires an Internet connection. Windows may request approval
for Python installation.

## Copy the Android backup to the computer

The program creates the destination folder automatically:

```text
PLACE-HERE-1-ANDROID-BACKUP\
```

The folder contains a bilingual `README.txt` reminder, and the main menu also
displays where files must be placed.

### Recommended method: USB file transfer (MTP)

1. Connect the unlocked Android phone with a USB cable that supports data.
2. Tap the Android USB notification and choose **File transfer / Android Auto**.
   Do not leave it in **Charge only** mode.
3. In Windows File Explorer, open **This PC → your phone → Internal shared storage**.
4. Browse to:

   ```text
   Android\media\com.whatsapp.w4b\WhatsApp Business
   ```

5. Copy the **complete `WhatsApp Business` folder**, including `Databases`,
   `Media`, and `Backups`.
6. Paste it into the repository like this:

   ```text
   PLACE-HERE-1-ANDROID-BACKUP\WhatsApp Business\Databases
   PLACE-HERE-1-ANDROID-BACKUP\WhatsApp Business\Media
   PLACE-HERE-1-ANDROID-BACKUP\WhatsApp Business\Backups
   ```

7. Wait for Windows to finish copying before disconnecting the phone. Large
   media folders may take a long time.

USB debugging is **not required** for normal MTP file transfer and should not be
enabled without a reason.

### Optional advanced method: ADB

Use this only when MTP cannot copy the folder and you understand Android developer
access. The program cannot enable USB debugging automatically; Android requires
the phone owner to enable and approve it on the device.

1. Install Google's official [SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools).
2. On Android, enable **Developer options → USB debugging**.
3. Connect the phone, unlock it, and approve the computer's RSA fingerprint.
4. From the repository root, verify the device and copy the folder:

   ```powershell
   adb devices
   adb pull "/sdcard/Android/media/com.whatsapp.w4b/WhatsApp Business" "PLACE-HERE-1-ANDROID-BACKUP\WhatsApp Business"
   ```

5. Disable USB debugging and revoke debugging authorizations after the copy if
   you no longer need ADB.

## First-run onboarding

The wizard asks which scope you need.

### 1. Backup/export only

No Chatwoot settings are requested. You can verify, decrypt, and export the local
backup as HTML, text, JSON, CSV, Markdown, or Chatwoot import data.

### 2. Backup and contacts through the API

The wizard requests:

- Chatwoot base URL: `https://app.chatwoot.com` or your self-hosted domain.
- User access token: Chatwoot → **Profile settings → Access Token**.
- Default calling code for national numbers, such as `+55`, `+34`, or `+52`.

The token input is hidden. The tool calls `/api/v1/profile`, validates the token,
and lists the available accounts. If the token has access to multiple accounts,
you can select one without manually finding its ID.

### 3. Full self-hosted workflow

In addition to optional API settings, the wizard requests:

- `SSH_HOST`: server domain or IPv4 address.
- `SSH_USER`: SSH user, often `ubuntu`.
- `SSH_KEY`: a `.pem` file or a directory in which to find it.

It tests SSH and offers to discover PostgreSQL from Docker. The SSH user must be
able to run `docker info`; passwordless `sudo -n docker` is also supported.

If the installation does not use Docker, enter `DATABASE_URL` manually. Input is
hidden and must point to the local end of the tunnel:

```text
postgresql://USERNAME:PASSWORD@127.0.0.1:15432/DATABASE_NAME
```

An administrator can find the original values in Chatwoot's server-side `.env`.
From the installation directory, inspect only the relevant variables:

```bash
grep -E '^(DATABASE_URL|POSTGRES_HOST|POSTGRES_PORT|POSTGRES_DATABASE|POSTGRES_DB|POSTGRES_USERNAME|POSTGRES_USER|POSTGRES_PASSWORD)=' .env
```

Never paste that output into an issue, community chat, or support ticket. For a
managed database, `TUNNEL_REMOTE_HOST` must be the database hostname as seen from
the SSH server.

### 4. Configure later

This opens the menu without requesting integrations. Menu option 8 runs onboarding
again when the required information is available.

## PostgreSQL security model

**Never expose port 5432 to the Internet.** The connection path is:

```text
Windows tool → 127.0.0.1:15432 → SSH tunnel → server-side PostgreSQL:5432
```

During Docker discovery, the tool:

1. Receives the SSH host, user, and key from the local user.
2. verifies non-interactive SSH connectivity.
3. Requests explicit approval before a read-only server inspection.
4. Reads only `DATABASE_URL` or `POSTGRES_*` variables from the Rails container
   and the PostgreSQL container's internal location.
5. Builds a local URL using `127.0.0.1:15432` and stores it in the local `.env`.
   The password is never printed.
6. Keeps PostgreSQL reachable only through SSH while the tunnel window is open.

See Chatwoot's official [environment variable reference](https://developers.chatwoot.com/self-hosted/configuration/environment-variables),
[Docker deployment guide](https://developers.chatwoot.com/self-hosted/deployment/docker),
and [backup guide](https://developers.chatwoot.com/self-hosted/deployment/backup).

## Local configuration

| Variable | Purpose | Secret? |
|---|---|---:|
| `SETUP_MODE` | Onboarding mode | No |
| `CHATWOOT_BASE_URL` | Chatwoot URL | No |
| `CHATWOOT_ACCOUNT_ID` | Selected account | No |
| `CHATWOOT_TOKEN` | API authentication | Yes |
| `DEFAULT_COUNTRY_CODE` | Prefix for national phone numbers | No |
| `SSH_HOST`, `SSH_USER` | Server access | No |
| `SSH_KEY` | Local private-key path | Sensitive |
| `DATABASE_URL` | PostgreSQL username and password | Yes |
| `TUNNEL_LOCAL_PORT` | Local port; default `15432` | No |
| `TUNNEL_REMOTE_HOST` | Database host as seen by the SSH server | No |
| `TUNNEL_REMOTE_PORT` | Remote port; default `5432` | No |
| `ACCOUNT_ID`, `INBOX_ID`, `AGENT_USER_ID` | Chat destination | No |
| `EXPORT_DIR`, `STORAGE_ROOT` | Export and attachment staging | No |

`.env` is ignored by Git. Re-run onboarding, use a module's configuration menu,
or edit your local `.env` to change values. Never put real values in `.env.example`.

## Complete workflow

### Step 0: place the files

The program creates three input folders:

| Folder | Place this inside |
|---|---|
| `PLACE-HERE-1-ANDROID-BACKUP\` | Complete Android `WhatsApp Business` folder |
| `PLACE-HERE-2-CONTACTS\` | Contact `.vcf` or `.csv` file |
| `PLACE-HERE-3-CHATWOOT-EXPORT\` | `chatwoot_export.json` and `attachments` |

Each folder contains a bilingual `README.txt` with the same instructions.

### Step 1: back up and export WhatsApp

1. Copy the complete Android folder as described above.
2. Run `run.bat` and select option 1.
3. The wizard verifies `Databases`, `Media`, and `Backups`.
4. If requested, enter the 64-digit key. It is not written to disk.
5. Choose **Chatwoot** format if you plan to import chats.
6. Confirm that `chatwoot_export.json`, `_summary.json`, and `attachments` were
   created under `PLACE-HERE-3-CHATWOOT-EXPORT`.

### Step 2: import contacts

1. Export contacts as VCF or CSV.
2. Recommended CSV columns are `name`, `phone_number`, `email`, `city`, and
   `country`; `first_name` and `last_name` are also accepted.
3. Put the file in `PLACE-HERE-2-CONTACTS`.
4. Select option 2 from the main menu.
5. Start with one or two test contacts.
6. Check them in Chatwoot before importing the remaining contacts.

A single file may contain phone numbers from any country. Values beginning with
`+` or international prefix `00` are preserved as E.164. National numbers receive
`DEFAULT_COUNTRY_CODE`. Brazil-specific validation is applied only to `+55`;
national rules are not invented for other countries.

### Step 3: open the SSH tunnel

1. Select option 3.
2. The program tests the key and server.
3. A separate tunnel window opens.
4. Keep that window open throughout the import.
5. Do not create a public firewall rule for port 5432.

If `15432` is busy, change `TUNNEL_LOCAL_PORT` in `.env`, for example to `25432`,
and repeat onboarding so `DATABASE_URL` is rebuilt.

### Step 4: back up PostgreSQL

Before importing, connect to the server through SSH and create a dump. For Docker
Compose, adapt the database user and name to your installation:

```bash
docker compose exec -T postgres pg_dump -U postgres chatwoot > chatwoot-before-whatsapp.sql
ls -lh chatwoot-before-whatsapp.sql
```

Store the dump outside the container and preferably keep a second encrypted copy
in separate storage. Chatwoot's official backup documentation also recommends
backing up storage and configuration.

### Step 5: inspect and test

1. Select option 4 from the main menu.
2. Run **Dry run**; it analyzes the export without changing PostgreSQL.
3. Run **Database reconnaissance**; it lists accounts, inboxes, agents, and
   storage without inserting messages.
4. Verify the contact names.
5. Import only one or two test chats.
6. Check dates, senders, inbox, names, and attachments in Chatwoot.

### Step 6: import the history

Follow the chat menu order:

1. Import messages from the last 12 months.
2. Associate attachments with imported messages.
3. Upload files to server storage.
4. Import history older than 12 months if required.

Progress is stored in `estado.json`. If interrupted, the next run continues with
pending work. **Undo** removes only records tagged as created by this tool; it is
not a replacement for the PostgreSQL dump.

## Commands

| Command | Action |
|---|---|
| `npm start` | Open the main menu |
| `npm run onboarding` | Repeat first-run configuration |
| `npm run contactos -- file.csv` | Import contacts |
| `npm run dry-run` | Analyze the export without writing to PostgreSQL |
| `npm run recon` | Run read-only database reconnaissance |
| `node modules/chats/import-chats.mjs --all` | Import all pending chats |
| `node modules/chats/import-chats.mjs --undo` | Start the undo flow |
| `npm test` | Run the automated tests |

## Troubleshooting

### Chatwoot Cloud

Cloud customers do not have PostgreSQL or SSH access. Use options 1 and 2.
Historical chat and attachment import is disabled by design.

### Windows cannot see the phone or folder

- Unlock the phone and select **File transfer / Android Auto**, not **Charge only**.
- Try another USB data cable or USB port.
- Accept any file-access prompt on the phone.
- Confirm that you are using WhatsApp **Business** for Android; its package is
  `com.whatsapp.w4b`.
- Use the optional ADB method only after normal file transfer fails.

### PostgreSQL could not be detected automatically

- Confirm that Chatwoot uses Docker Compose.
- Run `docker info` with the same SSH user.
- If it works only with `sudo`, allow `sudo -n docker` or enter `DATABASE_URL`
  manually.
- For native Linux installations, read the Chatwoot `.env` and configure the
  tunnel manually.

### `Connection refused` at `127.0.0.1:15432`

- The tunnel window is not open.
- The local port changed but `DATABASE_URL` still uses the previous port.
- `TUNNEL_REMOTE_HOST` or `TUNNEL_REMOTE_PORT` does not match the installation.

### HTTP 401 while importing contacts

Create a user access token from the Chatwoot profile and verify that the user can
access the selected account. Platform API tokens are not equivalent to the user
tokens required by these endpoints.

### Schema changes

WhatsApp and Chatwoot may change their internal schemas. Stop if reconnaissance
or the test chat fails. Open an issue without attaching real contacts, tokens,
dumps, exports, messages, or server details.

## Privacy and security

- Never use `git add -f` on any `PLACE-HERE-*` folder.
- Never publish `.env`, `.pem`, VCF, CSV, dumps, `msgstore`, exports, or reports.
- Process only data that you are authorized to handle.
- Rotate any accidentally exposed token or password immediately.
- Review [SECURITY.md](SECURITY.md) before reporting a problem.

## Community sharing

This repository may be useful to the Chatwoot self-hosted community as an
**experimental migration utility**, especially for teams moving locally owned
WhatsApp Business Android history. Present it as an independent project, not as
an official or supported Chatwoot importer, and lead with the staging, backup,
and schema-compatibility warnings above.

Good places to share it are Chatwoot's official [community page and Discord](https://www.chatwoot.com/community)
or [GitHub Discussions](https://github.com/orgs/chatwoot/discussions). If a test
reveals a security issue in Chatwoot, follow Chatwoot's private security reporting
process instead of posting details publicly.

## Development

```powershell
npm ci
npm test
```

The tests cover Docker and managed-database tunnel construction, passwords with
special characters, and configurable international phone numbers.

## License

[MIT](LICENSE). You may use, modify, and redistribute the project while preserving
the license notice.
