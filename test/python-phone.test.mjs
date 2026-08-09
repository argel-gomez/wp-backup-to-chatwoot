import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("el exportador Python resuelve contactos internacionales sin aplicar variantes de Brasil", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-python-world-test-"));
  const vcf = path.join(temp, "world.vcf");
  fs.writeFileSync(vcf, [
    "BEGIN:VCARD", "VERSION:3.0", "FN:CONTACTO_EJEMPLO_US", "TEL:+12025550123", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "FN:CONTACTO_EJEMPLO_UK", "TEL:00442079460123", "END:VCARD",
  ].join("\r\n") + "\r\n", "utf8");

  const python = [
    "import importlib.util, os, sys",
    "os.environ['DEFAULT_COUNTRY_CODE'] = '+34'",
    "spec = importlib.util.spec_from_file_location('wa_archive', sys.argv[1])",
    "mod = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "idx, warnings = mod.ContactIndex.from_vcf(sys.argv[2])",
    "assert idx.lookup('12025550123@s.whatsapp.net') == 'CONTACTO_EJEMPLO_US'",
    "assert idx.lookup('442079460123@s.whatsapp.net') == 'CONTACTO_EJEMPLO_UK'",
  ].join("; ");

  try {
    const result = spawnSync(
      "python",
      ["-c", python, path.join(root, "modules", "backup", "wa_archive.py"), vcf],
      { cwd: root, encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
