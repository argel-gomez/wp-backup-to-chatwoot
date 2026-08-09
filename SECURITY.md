# Security

## Data that must never be published

Do not attach backups, contacts, conversations, media, databases, `.env` files,
Chatwoot tokens, credential-bearing URLs, or SSH keys to issues, commits, or pull
requests.

Do not expose PostgreSQL port `5432` to the Internet. The chat importer must use
the local SSH tunnel created by the application.

If a credential is accidentally published, remove the public content and rotate
the credential immediately. Deleting only the latest commit does not remove it
from Git history.

## Reporting a vulnerability

Use **Report a vulnerability** on the repository's Security tab when available.
Otherwise, open an issue without secrets, personal information, or exploitation
details and ask the maintainer for a private channel.

Include the affected version or commit, expected impact, and minimal reproduction
steps using fictional data.
