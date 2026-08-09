# Contributing

Thank you for helping improve this independent community project. This repository
is not part of the official Chatwoot codebase and contributions here are not
Chatwoot product contributions.

## Before opening an issue

1. Search existing issues and read the English README and troubleshooting guide.
2. Test with the latest project release on a disposable or staging installation.
3. Record the operating system, Android, WhatsApp Business, Chatwoot, Node.js,
   Python, and PostgreSQL versions when available.
4. Reduce the problem to the smallest reproducible example.

Never attach real contacts, phone numbers, messages, media, VCF/CSV files,
WhatsApp databases, PostgreSQL dumps, `.env` files, API tokens, passwords, SSH
keys, domains, IP addresses, or server logs containing private data.

If a report concerns a vulnerability in Chatwoot itself, use Chatwoot's private
security reporting process instead of this repository.

## Development workflow

1. Fork this repository and create a focused branch.
2. Keep changes small and document behavior changes.
3. Add or update tests for code changes.
4. Run:

   ```powershell
   npm ci
   npm test
   ```

5. Verify JavaScript and Python syntax.
6. Open a pull request using the repository template.

Use English for code, user-facing text, issues, and pull requests. Spanish
documentation may be updated together with the English source document.

## Commit messages

Prefer Conventional Commit subjects:

```text
feat: add a migration capability
fix: prevent duplicate contacts
docs: clarify Android backup steps
test: cover a PostgreSQL connection case
```

## Safety requirements

- Do not expose PostgreSQL port 5432 to the Internet.
- Preserve the SSH-tunnel model.
- Keep destructive database operations explicitly confirmed and reversible.
- Require a verified backup and staging test for schema-dependent changes.
- Do not weaken `.gitignore` rules protecting user data.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
