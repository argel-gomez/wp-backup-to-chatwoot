import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("converts a non-Brazilian national number with DEFAULT_COUNTRY_CODE", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-chatwoot-test-"));
  const csv = path.join(temp, "sample-contacts.csv");
  const output = path.join(root, "PLACE-HERE-2-CONTACTS", "sample-contacts-nombres.vcf");
  fs.writeFileSync(csv, "name,phone_number\nSAMPLE_CONTACT,123456789\n", "utf8");

  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "modules", "contactos", "import-contacts.mjs"), "--vcf", csv],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, DEFAULT_COUNTRY_CODE: "+34" },
      }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(fs.readFileSync(output, "utf8"), /TEL;TYPE=CELL:\+34123456789/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(output, { force: true });
  }
});

test("accepts E.164 numbers from several countries in one file", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-chatwoot-world-test-"));
  const csv = path.join(temp, "international-contacts.csv");
  const output = path.join(root, "PLACE-HERE-2-CONTACTS", "international-contacts-nombres.vcf");
  fs.writeFileSync(
    csv,
    [
      "name,phone_number",
      "SAMPLE_CONTACT_US,+12025550123",
      "SAMPLE_CONTACT_UK,00442079460123",
      "SAMPLE_CONTACT_AU,+61255501234",
    ].join("\n") + "\n",
    "utf8"
  );

  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "modules", "contactos", "import-contacts.mjs"), "--vcf", csv],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, DEFAULT_COUNTRY_CODE: "+34" },
      }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const vcf = fs.readFileSync(output, "utf8");
    assert.match(vcf, /TEL;TYPE=CELL:\+12025550123/);
    assert.match(vcf, /TEL;TYPE=CELL:\+442079460123/);
    assert.match(vcf, /TEL;TYPE=CELL:\+61255501234/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(output, { force: true });
  }
});
