#!/usr/bin/env python3
"""
wa_archive.py - Respaldo y extraccion de WhatsApp Business (Android, sin root).

Fases:
  wizard   Asistente interactivo: valida la carpeta, pide la clave, elige
           formato y exporta con barra de progreso
  pull     Extrae Databases/ y Media/ del telefono via adb (multimedia incremental)
  verify   Igual que pull pero sin descargar: solo reporta lo que falta
  decrypt  Descifra msgstore.db.crypt15 con la clave de 64 digitos
  export   Genera el archivo legible (HTML/TXT/JSON/CSV/Markdown/Chatwoot)

Requisitos: adb en PATH (solo para pull/verify). Las dependencias de Python
(questionary, rich, wa-crypt-tools) se instalan solas si faltan.
La clave de 64 digitos se lee de la variable de entorno WA_KEY o se pide de
forma interactiva; nunca se escribe en disco ni se registra en el log.

Hecho por github.com/argel-gomez - software libre, licencia MIT (ver LICENSE).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import importlib
import importlib.util
import json
import os
import quopri
import re
import shutil
import site
import sqlite3
import subprocess
import sys
import sysconfig
import urllib.parse
from collections.abc import Callable, Iterable, Iterator
from datetime import datetime, timezone
from pathlib import Path

PKG = "com.whatsapp.w4b"          # WhatsApp Business. WhatsApp normal: com.whatsapp
REMOTE_ROOT = f"/sdcard/Android/media/{PKG}/WhatsApp Business"
STALE_HOURS = 30                   # avisa si la copia local no es reciente
SKIP_DIRS = (".trash/", ".Shared/", ".StickerThumbs/")  # ruido, no se extrae
PIP_PACKAGES = {"questionary": "questionary", "rich": "rich"}
RELAUNCH_FLAG = "WA_ARCHIVE_RELAUNCHED"   # evita reinicios en bucle
ADB_URL = "https://developer.android.com/tools/releases/platform-tools"


# --------------------------------------------------------------------------
# errores
# --------------------------------------------------------------------------

class WaError(Exception):
    """Error con codigo estable para poder reportarlo y depurarlo."""

    def __init__(self, code: str, message: str, detail: str | None = None,
                 exit_code: int = 1):
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message
        self.detail = detail
        self.exit_code = exit_code


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def die(msg: str) -> "NoReturn":
    raise WaError("E00", msg)


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
    res = subprocess.run(cmd, capture_output=True, text=True)
    if check and res.returncode != 0:
        raise WaError("E05", f"fallo el comando: {' '.join(cmd[:3])}...",
                      res.stderr.strip())
    return res


def adb(*args: str, check: bool = True) -> str:
    return run(["adb", *args], check=check).stdout


# --------------------------------------------------------------------------
# dependencias
# --------------------------------------------------------------------------

def ensure_pip() -> None:
    try:
        importlib.import_module("pip")
    except ImportError:
        print("pip no esta disponible, instalandolo con ensurepip...")
        res = run([sys.executable, "-m", "ensurepip", "--upgrade"], check=False)
        if res.returncode != 0:
            raise WaError("E91", "no se pudo habilitar pip con ensurepip",
                          res.stderr.strip())


def pip_install(pip_name: str) -> subprocess.CompletedProcess:
    res = run([sys.executable, "-m", "pip", "install", pip_name], check=False)
    if res.returncode != 0:
        # instalacion global sin permisos: reintentar en el perfil del usuario
        res = run([sys.executable, "-m", "pip", "install", "--user", pip_name],
                  check=False)
    return res


def module_available(module_name: str) -> bool:
    try:
        importlib.import_module(module_name)
        return True
    except ImportError:
        return False


def refresh_import_paths() -> None:
    """Hace visible lo recien instalado sin reiniciar el proceso.

    Si site-packages del usuario no existia al arrancar, Python no lo puso en
    sys.path; pip lo crea recien ahora, asi que hay que agregarlo a mano.
    """
    importlib.invalidate_caches()
    dirs = [site.getusersitepackages()]
    try:
        dirs.extend(site.getsitepackages())
    except AttributeError:      # algunos entornos virtuales no lo exponen
        pass
    for d in dirs:
        if d and os.path.isdir(d):
            site.addsitedir(d)
    importlib.invalidate_caches()


def relaunch_after_install(pending: list[str]) -> "NoReturn":
    """Ultimo recurso: reiniciar el interprete para que cargue lo instalado."""
    if os.environ.get(RELAUNCH_FLAG):
        raise WaError("E91", f"se instalo {', '.join(pending)} pero sigue sin "
                             "poder importarse.",
                      "Cerra esta ventana, abrila de nuevo y volve a intentar.")
    print("Reiniciando para cargar las dependencias recien instaladas...")
    env = {**os.environ, RELAUNCH_FLAG: "1"}
    res = subprocess.run([sys.executable, *sys.argv], env=env)
    sys.exit(res.returncode)


def script_dirs() -> list[Path]:
    """Carpetas donde pip deja los ejecutables, global y del usuario."""
    dirs: list[Path] = []
    for scheme in (None, "nt_user", "posix_user"):
        try:
            p = (sysconfig.get_path("scripts") if scheme is None
                 else sysconfig.get_path("scripts", scheme))
        except (KeyError, ValueError):
            continue
        if p:
            dirs.append(Path(p))
    dirs.append(Path(sys.executable).parent)
    dirs.append(Path(sys.executable).parent / "Scripts")
    return dirs


def wadecrypt_cmd() -> list[str] | None:
    """Como invocar wadecrypt. El modulo va primero: no depende del PATH."""
    try:
        if importlib.util.find_spec("wa_crypt_tools.wadecrypt") is not None:
            return [sys.executable, "-m", "wa_crypt_tools.wadecrypt"]
    except (ImportError, AttributeError, ValueError):
        pass
    found = shutil.which("wadecrypt")
    if found:
        return [found]
    for d in script_dirs():
        for name in ("wadecrypt.exe", "wadecrypt"):
            candidate = d / name
            if candidate.is_file():
                return [str(candidate)]
    return None


def ensure_wadecrypt() -> list[str]:
    cmd = wadecrypt_cmd()
    if cmd:
        return cmd
    print("Instalando wa-crypt-tools (provee 'wadecrypt')...")
    res = pip_install("wa-crypt-tools")
    refresh_import_paths()
    cmd = wadecrypt_cmd()
    if res.returncode != 0 or not cmd:
        raise WaError("E92", "no se pudo instalar wa-crypt-tools o 'wadecrypt' "
                             "sigue sin encontrarse", res.stderr.strip())
    return cmd


def ensure_dependencies() -> None:
    ensure_pip()
    faltantes = [(m, p) for m, p in PIP_PACKAGES.items() if not module_available(m)]
    for module_name, pip_name in faltantes:
        print(f"Instalando dependencia faltante: {pip_name}...")
        res = pip_install(pip_name)
        if res.returncode != 0:
            raise WaError("E91", f"no se pudo instalar {pip_name}",
                          res.stderr.strip())
    ensure_wadecrypt()

    if faltantes:
        refresh_import_paths()
        pendientes = [m for m, _ in faltantes if not module_available(m)]
        if pendientes:
            relaunch_after_install(pendientes)


# --------------------------------------------------------------------------
# fase 1: pull
# --------------------------------------------------------------------------

def preflight() -> None:
    if not shutil.which("adb"):
        raise WaError("E01", "adb no esta en el PATH.",
                      f"Descargalo de {ADB_URL}, descomprimilo y agregalo al PATH.")
    devices = [
        ln for ln in adb("devices").splitlines()[1:]
        if ln.strip() and not ln.startswith("*")
    ]
    online = [d for d in devices if d.split()[-1] == "device"]
    if not online:
        raise WaError("E02", "ningun dispositivo autorizado.",
                      "Revisa el cable y acepta la huella RSA en el telefono.")
    if len(online) > 1:
        raise WaError("E03", f"hay {len(online)} dispositivos conectados.",
                      "Usa la variable de entorno ANDROID_SERIAL para elegir uno.")
    log(f"dispositivo: {online[0].split()[0]}")

    probe = adb("shell", "ls", f"'{REMOTE_ROOT}'", check=False)
    if "No such file" in probe or not probe.strip():
        raise WaError("E04", f"no existe {REMOTE_ROOT} en el telefono.",
                      f"Verifica el paquete ({PKG}).")


def check_backup_freshness() -> None:
    """Avisa si msgstore.db.crypt15 no se regenero recientemente."""
    out = adb("shell", f"stat -c '%Y %n' '{REMOTE_ROOT}/Databases/msgstore.db.crypt15'",
              check=False)
    parts = out.strip().split(None, 1)
    if len(parts) != 2 or not parts[0].isdigit():
        log("AVISO: no se encontro msgstore.db.crypt15. Activa la copia "
            "cifrada E2E con clave de 64 digitos y pulsa 'Guardar' en la app.")
        return
    age_h = (datetime.now(timezone.utc).timestamp() - int(parts[0])) / 3600
    log(f"copia local: {age_h:.1f} h de antiguedad")
    if age_h > STALE_HOURS:
        log("AVISO: la copia es vieja. HyperOS pudo matar el proceso "
            "nocturno; pon la app en 'Sin restricciones' de bateria.")


def remote_listing() -> dict[str, int]:
    """Ruta relativa -> tamano, para todo el arbol remoto."""
    out = adb("shell", f"find '{REMOTE_ROOT}' -type f -printf '%s\\t%P\\n'",
              check=False)
    if not out.strip():
        # find sin -printf en algunos builds: fallback mas lento
        out = adb("shell", f"cd '{REMOTE_ROOT}' && find . -type f -exec stat -c '%s\\t%n' {{}} +")
    listing: dict[str, int] = {}
    for line in out.splitlines():
        if "\t" not in line:
            continue
        size, rel = line.split("\t", 1)
        rel = rel.strip().lstrip("./")
        if not (size.strip().isdigit() and rel):
            continue
        if rel.startswith(SKIP_DIRS):
            continue
        listing[rel] = int(size)
    return listing


def pull(dest: Path, dry_run: bool = False) -> None:
    preflight()
    check_backup_freshness()
    dest.mkdir(parents=True, exist_ok=True)

    log("listando archivos remotos...")
    remote = remote_listing()
    total_gb = sum(remote.values()) / 1e9
    log(f"{len(remote)} archivos, {total_gb:.2f} GB en el telefono")

    # las bases se re-extraen siempre; la multimedia solo si falta o cambio
    pending = []
    for rel, size in remote.items():
        local = dest / rel
        if rel.startswith("Databases/"):
            pending.append(rel)
        elif not local.exists() or local.stat().st_size != size:
            pending.append(rel)

    log(f"{len(pending)} archivos por extraer "
        f"({sum(remote[r] for r in pending) / 1e9:.2f} GB)")

    if dry_run:
        report = dest / "_faltantes.txt"
        report.write_text("\n".join(sorted(pending)), encoding="utf-8")
        log(f"MODO VERIFICACION: no se descargo nada. Lista en {report}")
        if pending:
            log("Estos archivos faltan o quedaron truncados en la copia manual.")
        else:
            log("La copia local esta completa. Nada que traer.")
        return

    failures = []
    for i, rel in enumerate(pending, 1):
        local = dest / rel
        local.parent.mkdir(parents=True, exist_ok=True)
        res = run(["adb", "pull", "-a", f"{REMOTE_ROOT}/{rel}", str(local)],
                  check=False)
        if res.returncode != 0:
            failures.append(rel)
        if i % 200 == 0 or i == len(pending):
            log(f"  {i}/{len(pending)}")

    manifest = {
        "pulled_at": datetime.now(timezone.utc).isoformat(),
        "remote_root": REMOTE_ROOT,
        "file_count": len(remote),
        "total_bytes": sum(remote.values()),
        "failed": failures,
    }
    (dest / "_manifest.json").write_text(json.dumps(manifest, indent=2))

    if failures:
        log(f"AVISO: {len(failures)} archivos fallaron (ver _manifest.json)")
    log(f"extraccion lista en {dest}")


# --------------------------------------------------------------------------
# fase 2: decrypt
# --------------------------------------------------------------------------

def normalize_key(raw: str) -> str:
    return re.sub(r"\s+", "", raw or "")


def validate_key(key: str) -> None:
    if not key:
        raise WaError("E20", "no se proporciono la clave.",
                      "Define WA_KEY o usa el modo wizard.")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", key):
        raise WaError("E21", f"la clave debe tener 64 caracteres hexadecimales "
                             f"(recibidos: {len(key)}).",
                      "Pegala corrida, sin espacios ni saltos de linea.")


def decrypt(db_dir: Path, out_db: Path, key: str | None = None) -> None:
    key = normalize_key(key if key is not None else os.environ.get("WA_KEY", ""))
    validate_key(key)

    enc = db_dir / "msgstore.db.crypt15"
    if not enc.exists():
        raise WaError("E12", f"no existe {enc}",
                      "Activa la copia cifrada E2E en WhatsApp y volve a copiar "
                      "la carpeta Databases.")
    cmd = wadecrypt_cmd()
    if not cmd:
        raise WaError("E22", "wadecrypt no encontrado.",
                      "pip install wa-crypt-tools")

    log(f"descifrando {enc.name} ({enc.stat().st_size / 1e6:.1f} MB)...")
    out_db.parent.mkdir(parents=True, exist_ok=True)
    res = run([*cmd, key, str(enc), str(out_db)], check=False)
    if res.returncode != 0:
        raise WaError("E23", "wadecrypt fallo al descifrar la base.",
                      res.stderr.strip().replace(key, "***"))

    with sqlite3.connect(out_db) as cx:
        if cx.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise WaError("E24", "la base descifrada no pasa integrity_check.",
                          "Casi siempre significa que la clave es incorrecta.")
    log(f"base lista: {out_db}")


# --------------------------------------------------------------------------
# fase 3: export
# --------------------------------------------------------------------------

QUERY_MODERN = """
SELECT
    j.raw_string                          AS chat_id,
    COALESCE(c.subject, j.user)           AS chat_name,
    m.timestamp                           AS ts,
    m.from_me                             AS from_me,
    COALESCE(sj.raw_string, '')           AS sender,
    m.message_type                        AS mtype,
    COALESCE(m.text_data, '')             AS body,
    COALESCE(mm.file_path, '')            AS media_path,
    COALESCE(mm.mime_type, '')            AS mime,
    COALESCE(mm.file_size, 0)             AS media_size
FROM message m
JOIN chat c            ON c._id = m.chat_row_id
JOIN jid  j            ON j._id = c.jid_row_id
LEFT JOIN jid sj       ON sj._id = m.sender_jid_row_id
LEFT JOIN message_media mm ON mm.message_row_id = m._id
WHERE m.timestamp > 0
"""
ORDER_MODERN = "ORDER BY j.raw_string, m.timestamp"

QUERY_LEGACY = """
SELECT
    key_remote_jid                        AS chat_id,
    key_remote_jid                        AS chat_name,
    timestamp                             AS ts,
    key_from_me                           AS from_me,
    COALESCE(remote_resource, '')         AS sender,
    media_wa_type                         AS mtype,
    COALESCE(data, '')                    AS body,
    COALESCE(media_name, '')              AS media_path,
    COALESCE(media_mime_type, '')         AS mime,
    COALESCE(media_size, 0)               AS media_size
FROM messages
WHERE timestamp > 0
"""
ORDER_LEGACY = "ORDER BY key_remote_jid, timestamp"

MEDIA_TYPES = {1: "imagen", 2: "audio", 3: "video", 4: "contacto",
               5: "ubicacion", 9: "documento", 13: "gif", 20: "sticker"}


def open_db(db: Path) -> sqlite3.Connection:
    if not db.is_file():
        raise WaError("E30", f"no existe la base descifrada: {db}")
    try:
        cx = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    except sqlite3.Error as exc:
        raise WaError("E30", f"no se pudo abrir {db}", str(exc))
    cx.row_factory = sqlite3.Row
    return cx


def detect_schema(cx: sqlite3.Connection) -> str:
    tables = {r[0] for r in cx.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    if {"message", "chat", "jid"} <= tables:
        return "modern"
    if "messages" in tables:
        return "legacy"
    raise WaError("E31", "esquema no reconocido en msgstore.db",
                  f"tablas encontradas: {', '.join(sorted(tables)) or '(ninguna)'}")


def schema_query(schema: str) -> tuple[str, str]:
    return ((QUERY_MODERN, ORDER_MODERN) if schema == "modern"
            else (QUERY_LEGACY, ORDER_LEGACY))


def count_rows(cx: sqlite3.Connection, schema: str) -> int:
    base, _ = schema_query(schema)
    try:
        return cx.execute(f"SELECT COUNT(*) FROM ({base})").fetchone()[0]
    except sqlite3.Error as exc:
        raise WaError("E32", "fallo el conteo de mensajes", str(exc))


def count_messages(db: Path) -> int:
    cx = open_db(db)
    try:
        return count_rows(cx, detect_schema(cx))
    finally:
        cx.close()


def _strip_media_prefix(rel: str) -> str:
    """El file_path de la base viene como 'Media/sub/archivo.jpg'. Como ahora
    recibimos la carpeta Media directamente (elegida aparte), quitamos ese
    prefijo para unirlo a media_dir sin duplicar el nivel 'Media'."""
    return rel.split("/", 1)[1] if rel.startswith("Media/") else rel


def resolve_media(media_dir: Path, rel: str, index: dict[str, Path]) -> Path | None:
    if not rel:
        return None
    direct = media_dir / _strip_media_prefix(rel)
    if direct.exists():
        return direct
    return index.get(Path(rel).name)


def build_media_index(media_dir: Path) -> dict[str, Path]:
    """basename -> ruta real, para adjuntos cuyo file_path no coincide."""
    index: dict[str, Path] = {}
    if media_dir.exists():
        for p in media_dir.rglob("*"):
            if p.is_file():
                index.setdefault(p.name, p)
    return index


def _unfold_vcf_lines(text: str) -> list[str]:
    """Junta lineas partidas: RFC 6350 (la siguiente empieza con espacio/tab)
    y el estilo vCard 2.1 mas viejo (la linea termina en '=')."""
    raw = text.splitlines()
    lines: list[str] = []
    for line in raw:
        if lines and (line.startswith(" ") or line.startswith("\t")):
            lines[-1] += line[1:]
        elif lines and lines[-1].endswith("="):
            lines[-1] = lines[-1][:-1] + line
        else:
            lines.append(line)
    return lines


def _decode_vcf_value(value: str, params: str) -> str:
    if "QUOTED-PRINTABLE" in params.upper():
        try:
            charset = "utf-8"
            for part in params.split(";"):
                if part.upper().startswith("CHARSET="):
                    charset = part.split("=", 1)[1]
            return quopri.decodestring(value.encode("ascii", "ignore")).decode(
                charset, errors="replace")
        except (ValueError, LookupError):
            return value
    return value


def parse_vcf(path: str | Path) -> dict:
    """Parser defensivo de vCard 2.1/3.0/4.0: nunca lanza excepcion, ante
    cualquier problema devuelve lo que pudo entender y una lista de avisos."""
    contacts: list[tuple[str, list[str]]] = []
    warnings: list[str] = []

    try:
        raw = Path(path).read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        try:
            raw = Path(path).read_text(encoding="cp1252")
        except (UnicodeDecodeError, OSError) as exc:
            warnings.append(f"no se pudo leer {path}: {exc}")
            return {"contacts": contacts, "warnings": warnings}
    except OSError as exc:
        warnings.append(f"no se pudo leer {path}: {exc}")
        return {"contacts": contacts, "warnings": warnings}

    fn = n = org = None
    tels: list[str] = []
    in_card = False

    for line in _unfold_vcf_lines(raw):
        if not line.strip():
            continue
        stripped = line.strip()
        if stripped.upper() == "BEGIN:VCARD":
            fn = n = org = None
            tels = []
            in_card = True
            continue
        if stripped.upper() == "END:VCARD":
            if in_card:
                name = fn or n or org
                if not name:
                    pass  # sin nombre util, se descarta
                elif not tels:
                    pass  # sin telefono, no aporta al indice
                else:
                    contacts.append((name, tels))
            in_card = False
            continue
        if not in_card or ":" not in line:
            continue

        prop, value = line.split(":", 1)
        prop_parts = prop.split(";")
        prop_name = prop_parts[0].split(".")[-1].upper()
        params = ";".join(prop_parts[1:])
        value = _decode_vcf_value(value, params)

        if prop_name == "FN":
            fn = value.strip() or fn
        elif prop_name == "N" and not fn:
            pieces = [p.strip() for p in value.split(";") if p.strip()]
            n = " ".join(pieces) or n
        elif prop_name == "ORG" and not fn and not n:
            org = value.replace(";", " ").strip() or org
        elif prop_name == "TEL":
            v = value.strip()
            if v.lower().startswith("tel:"):
                v = v[4:]
            if v:
                tels.append(v)

    return {"contacts": contacts, "warnings": warnings}


def _default_country_digits() -> str:
    return re.sub(r"\D", "", os.environ.get("DEFAULT_COUNTRY_CODE", "+55")) or "55"


def _brazil_national_digits(raw: str) -> str | None:
    """Devuelve un numero nacional brasileño solo cuando el dato lo demuestra.

    Un E.164 explícito de otro país nunca entra al fallback brasileño. Esto evita
    cruzar, por ejemplo, un +1 o +44 con un contacto de Brasil por sus últimos
    dígitos.
    """
    if _default_country_digits() != "55":
        return None
    text = str(raw).strip()
    digits = re.sub(r"\D", "", text.split("@", 1)[0])
    explicit = text.startswith(chr(43)) or text.startswith("00") or "@" in text
    if text.startswith("00"):
        digits = digits[2:]
    if digits.startswith("55") and len(digits) in (12, 13):
        return digits[2:]
    if not explicit and len(digits) in (10, 11):
        return digits
    return None


def _number_variants(raw: str) -> set[str]:
    """Claves equivalentes sin asumir que todos los telefonos son brasileños."""
    text = str(raw).strip()
    digits = re.sub(r"\D", "", text.split("@", 1)[0])
    if text.startswith("00"):
        digits = digits[2:]
    if not digits:
        return set()

    keys = {digits}
    explicit = text.startswith(chr(43)) or text.startswith("00") or "@" in text
    country = _default_country_digits()
    if not explicit:
        keys.add(country + digits.lstrip("0"))

    national = _brazil_national_digits(raw)
    if national is None:
        return keys

    variants = {national, "55" + national}
    if len(national) == 11 and national[2] == "9":
        no9 = national[:2] + national[3:]
        variants.update({no9, "55" + no9})
    elif len(national) == 10:
        with9 = national[:2] + "9" + national[2:]
        variants.update({with9, "55" + with9})
    return keys | variants


class ContactIndex:
    """Numero -> nombre, armado desde un .vcf. Ante una clave (exacta o de
    respaldo por sufijo) que apunte a mas de un nombre distinto, se marca
    como colisionada y nunca se resuelve -- preferimos dejar el numero
    crudo antes que arriesgar mostrar el nombre equivocado."""

    def __init__(self) -> None:
        self._exact: dict[str, str] = {}
        self._exact_collided: set[str] = set()
        self._suffix: dict[str, str] = {}
        self._suffix_collided: set[str] = set()
        self.stats = {
            "contacts_parsed": 0,
            "collisions_exact": 0,
            "collisions_suffix": 0,
        }

    def _add_exact(self, key: str, name: str) -> None:
        if key in self._exact_collided:
            return
        prev = self._exact.get(key)
        if prev is None:
            self._exact[key] = name
        elif prev != name:
            del self._exact[key]
            self._exact_collided.add(key)
            self.stats["collisions_exact"] += 1

    def _add_suffix(self, key: str, name: str) -> None:
        if key in self._suffix_collided:
            return
        prev = self._suffix.get(key)
        if prev is None:
            self._suffix[key] = name
        elif prev != name:
            del self._suffix[key]
            self._suffix_collided.add(key)
            self.stats["collisions_suffix"] += 1

    @classmethod
    def from_vcf(cls, path: str | Path) -> tuple["ContactIndex", list[str]]:
        idx = cls()
        parsed = parse_vcf(path)
        for name, phones in parsed["contacts"]:
            idx.stats["contacts_parsed"] += 1
            for raw_phone in phones:
                digits = re.sub(r"\D", "", raw_phone)
                if not digits:
                    continue
                for key in _number_variants(raw_phone):
                    idx._add_exact(key, name)
                if _brazil_national_digits(raw_phone) is not None and len(digits) >= 8:
                    idx._add_suffix(digits[-8:], name)
        return idx, parsed["warnings"]

    def lookup(self, jid_or_number: str) -> str | None:
        digits = re.sub(r"\D", "", jid_or_number.split("@", 1)[0])
        if not digits:
            return None
        for key in _number_variants(jid_or_number):
            if key in self._exact_collided:
                return None
            if key in self._exact:
                return self._exact[key]
        if _brazil_national_digits(jid_or_number) is not None and len(digits) >= 8:
            suf = digits[-8:]
            if suf in self._suffix_collided:
                return None
            if suf in self._suffix:
                return self._suffix[suf]
        return None

    @staticmethod
    def format_display(name: str, jid: str) -> str:
        number = jid.split("@", 1)[0]
        return f"{name} ({number})"


def iter_rows(cx: sqlite3.Connection, schema: str, media_dir: Path,
              index: dict[str, Path],
              contacts: ContactIndex | None = None) -> Iterator[dict]:
    """Unica fuente de mensajes normalizados; todos los formatos la consumen."""
    base, order = schema_query(schema)
    try:
        rows = cx.execute(f"{base} {order}")
    except sqlite3.Error as exc:
        raise WaError("E32", "fallo la consulta de mensajes", str(exc))

    # cache por JID: un chat o remitente se repite en miles de filas, no
    # hace falta llamar contacts.lookup() en cada una
    _resolved: dict[str, str | None] = {}

    def resolve_name(jid: str) -> str | None:
        if contacts is None or not jid.endswith("@s.whatsapp.net"):
            return None
        if jid not in _resolved:
            match = contacts.lookup(jid)
            _resolved[jid] = ContactIndex.format_display(match, jid) if match else None
        return _resolved[jid]

    for r in rows:
        when = datetime.fromtimestamp(r["ts"] / 1000, timezone.utc)
        resolved = resolve_media(media_dir, r["media_path"], index)
        chat_name = resolve_name(r["chat_id"]) or r["chat_name"]
        sender = r["sender"] or ("yo" if r["from_me"] else r["chat_id"])
        sender = sender if sender == "yo" else (resolve_name(sender) or sender)
        yield {
            "chat_id": r["chat_id"],
            "chat_name": chat_name,
            "ts_utc": when.isoformat(),
            "direction": "saliente" if r["from_me"] else "entrante",
            "sender": sender,
            "type": MEDIA_TYPES.get(r["mtype"], "texto" if not r["mtype"] else str(r["mtype"])),
            "body": r["body"],
            # se conserva el arbol bajo 'Media/' para que attachments/ replique
            # la misma estructura, aunque la carpeta Media este en otro lado
            "media": ("Media/" + resolved.relative_to(media_dir).as_posix()) if resolved else None,
            "media_missing": bool(r["media_path"]) and resolved is None,
            "mime": r["mime"],
            "size": r["media_size"],
        }


def group_by_chat(rows: Iterable[dict]) -> dict[str, list[dict]]:
    chats: dict[str, list[dict]] = {}
    for rec in rows:
        chats.setdefault(rec["chat_id"], []).append(rec)
    return chats


def sorted_chats_by_count(chats: dict[str, list[dict]]) -> list[tuple[str, list[dict]]]:
    return sorted(chats.items(), key=lambda kv: -len(kv[1]))


def safe_slug(text: str) -> str:
    keep = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in text)
    return keep[:60] or hashlib.sha1(text.encode()).hexdigest()[:12]


def copy_attachment(media_dir: Path, media_rel: str, outdir: Path) -> Path:
    """Copia el adjunto a outdir/attachments/<misma ruta relativa que en
    root> si todavia no esta ahi (evita recopiar cuando varios mensajes
    comparten el mismo archivo, y evita colisiones de nombre entre chats
    al preservar el arbol de carpetas original). Usa hardlink cuando el
    filesystem lo permite -- el caso normal, ya que el destino por defecto
    es root/export_<formato>, mismo volumen -- para no duplicar espacio en
    disco; si falla (otro volumen, permisos, FS sin soporte), cae a copia
    real. Asi cada export_<formato>/ queda independiente de la carpeta
    cruda: se puede mover o copiar sola."""
    dest = outdir / "attachments" / media_rel
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        src = media_dir / _strip_media_prefix(media_rel)
        try:
            os.link(src, dest)
        except OSError:
            shutil.copy2(src, dest)
    return dest


def localize_media(media_dir: Path, media_rel: str, outdir: Path, from_dir: Path) -> str:
    """Copia (si hace falta) el adjunto y devuelve la ruta relativa desde
    from_dir hasta la copia local en outdir/attachments/."""
    dest = copy_attachment(media_dir, media_rel, outdir)
    return os.path.relpath(dest, from_dir).replace(os.sep, "/")


# --- writers --------------------------------------------------------------

def write_jsonl(rows: Iterable[dict], outdir: Path, root: Path) -> None:
    with (outdir / "messages.jsonl").open("w", encoding="utf-8") as jf:
        for rec in rows:
            media = (localize_media(root, rec["media"], outdir, outdir)
                     if rec["media"] else None)
            jf.write(json.dumps({**rec, "media": media}, ensure_ascii=False) + "\n")


def write_csv(rows: Iterable[dict], outdir: Path, root: Path) -> None:
    with (outdir / "messages.csv").open("w", newline="", encoding="utf-8") as cf:
        writer = csv.writer(cf)
        writer.writerow(["chat", "fecha_utc", "direccion", "remitente",
                         "tipo", "texto", "adjunto", "mime", "bytes"])
        for rec in rows:
            media = (localize_media(root, rec["media"], outdir, outdir)
                     if rec["media"] else "")
            writer.writerow([rec["chat_name"], rec["ts_utc"], rec["direction"],
                             rec["sender"], rec["type"], rec["body"],
                             media, rec["mime"], rec["size"]])


CSS = """body{font:15px/1.5 system-ui,sans-serif;max-width:820px;margin:2rem auto;
padding:0 1rem;color:#1a1a1a}h1{font-size:1.3rem}.m{padding:.5rem .8rem;margin:.4rem 0;
border-radius:10px;max-width:75%}.in{background:#f1f1f1}.out{background:#d9fdd3;
margin-left:auto}.meta{font-size:.75rem;color:#666;margin-bottom:.2rem}
img{max-width:280px;border-radius:8px;display:block;margin-top:.4rem}
.miss{color:#b00;font-size:.8rem}a{color:#075e54}"""


def write_html(rows: Iterable[dict], outdir: Path, root: Path) -> None:
    chatdir = outdir / "chats"
    chatdir.mkdir(parents=True, exist_ok=True)
    (outdir / "style.css").write_text(CSS, encoding="utf-8")
    chats = group_by_chat(rows)
    entries = []

    for chat_id, msgs in sorted_chats_by_count(chats):
        name = msgs[0]["chat_name"]
        fname = f"{safe_slug(chat_id)}.html"
        entries.append((name, len(msgs), fname))
        parts = [
            "<!doctype html><meta charset='utf-8'>",
            f"<title>{html.escape(name)}</title>",
            "<link rel='stylesheet' href='../style.css'>",
            f"<h1>{html.escape(name)}</h1>",
            f"<p class='meta'>{len(msgs)} mensajes | {html.escape(chat_id)}</p>",
            "<p><a href='../index.html'>&larr; indice</a></p>",
        ]
        for m in msgs:
            cls = "out" if m["direction"] == "saliente" else "in"
            parts.append(f"<div class='m {cls}'>")
            parts.append(f"<div class='meta'>{m['ts_utc'][:19].replace('T', ' ')}"
                         f" &middot; {html.escape(m['sender'])}</div>")
            if m["body"]:
                parts.append(html.escape(m["body"]).replace("\n", "<br>"))
            if m["media"]:
                rel = urllib.parse.quote(localize_media(root, m["media"], outdir, chatdir))
                if m["mime"].startswith("image/"):
                    parts.append(f"<img src='{html.escape(rel)}' loading='lazy'>")
                else:
                    parts.append(f"<a href='{html.escape(rel)}'>"
                                 f"{html.escape(m['type'])}: "
                                 f"{html.escape(Path(m['media']).name)}</a>")
            elif m["media_missing"]:
                parts.append("<div class='miss'>[adjunto ausente]</div>")
            parts.append("</div>")
        (chatdir / fname).write_text("\n".join(parts), encoding="utf-8")

    idx = ["<!doctype html><meta charset='utf-8'><title>Archivo WhatsApp Business</title>",
           "<link rel='stylesheet' href='style.css'>",
           "<h1>Archivo WhatsApp Business</h1>",
           f"<p class='meta'>{len(entries)} conversaciones &middot; "
           f"generado {datetime.now():%Y-%m-%d %H:%M}</p><ul>"]
    for name, count, fname in entries:
        idx.append(f"<li><a href='chats/{fname}'>{html.escape(name)}</a> "
                   f"<span class='meta'>({count})</span></li>")
    idx.append("</ul>")
    (outdir / "index.html").write_text("\n".join(idx), encoding="utf-8")


def write_txt(rows: Iterable[dict], outdir: Path, root: Path) -> None:
    chatdir = outdir / "chats_txt"
    chatdir.mkdir(parents=True, exist_ok=True)
    chats = group_by_chat(rows)
    entries = []

    for chat_id, msgs in sorted_chats_by_count(chats):
        name = msgs[0]["chat_name"]
        fname = f"{safe_slug(chat_id)}.txt"
        entries.append((name, len(msgs), fname))
        lines = [f"{name} ({chat_id})", f"{len(msgs)} mensajes", "-" * 60, ""]
        for m in msgs:
            when = m["ts_utc"][:19].replace("T", " ")
            lines.append(f"[{when}] {m['direction']} {m['sender']}: {m['body']}")
            if m["media"]:
                lines.append(f"    [{m['type']}: {localize_media(root, m['media'], outdir, chatdir)}]")
            elif m["media_missing"]:
                lines.append("    [adjunto ausente]")
        (chatdir / fname).write_text("\n".join(lines), encoding="utf-8")

    idx = ["Archivo WhatsApp Business",
           f"{len(entries)} conversaciones - generado {datetime.now():%Y-%m-%d %H:%M}",
           "-" * 60, ""]
    for name, count, fname in entries:
        idx.append(f"{count:>7}  {name}  ->  chats_txt/{fname}")
    (outdir / "index.txt").write_text("\n".join(idx), encoding="utf-8")


def write_markdown(rows: Iterable[dict], outdir: Path, root: Path) -> None:
    chatdir = outdir / "chats_md"
    chatdir.mkdir(parents=True, exist_ok=True)
    chats = group_by_chat(rows)
    entries = []

    for chat_id, msgs in sorted_chats_by_count(chats):
        name = msgs[0]["chat_name"]
        fname = f"{safe_slug(chat_id)}.md"
        entries.append((name, len(msgs), fname))
        parts = [f"# {name}", "", f"`{chat_id}` - {len(msgs)} mensajes", "",
                 "[<- indice](../index.md)", ""]
        for m in msgs:
            when = m["ts_utc"][:19].replace("T", " ")
            parts.append(f"**{m['direction']} - {m['sender']}** _{when}_")
            if m["body"]:
                parts.append("")
                parts.append(m["body"])
            if m["media"]:
                # <> permite espacios en la ruta sin romper el enlace
                rel = f"<{localize_media(root, m['media'], outdir, chatdir)}>"
                label = f"{m['type']}: {Path(m['media']).name}"
                parts.append("")
                parts.append(f"![{label}]({rel})" if m["mime"].startswith("image/")
                             else f"[{label}]({rel})")
            elif m["media_missing"]:
                parts.append("")
                parts.append("> _[adjunto ausente]_")
            parts.append("")
        (chatdir / fname).write_text("\n".join(parts), encoding="utf-8")

    idx = ["# Archivo WhatsApp Business", "",
           f"{len(entries)} conversaciones - generado {datetime.now():%Y-%m-%d %H:%M}",
           "", "| Conversacion | Mensajes |", "|---|---:|"]
    for name, count, fname in entries:
        idx.append(f"| [{name}](chats_md/{fname}) | {count} |")
    (outdir / "index.md").write_text("\n".join(idx), encoding="utf-8")


def write_chatwoot(rows: Iterable[dict], outdir: Path, root: Path) -> None:
    """Mapeo best-effort: Chatwoot no publica un formato de importacion masiva."""
    chats = group_by_chat(rows)
    contacts = []
    conversations = []

    for chat_id, msgs in sorted_chats_by_count(chats):
        contacts.append({
            "identifier": chat_id,
            "name": msgs[0]["chat_name"],
            "phone_number": None,
        })
        messages = []
        for m in msgs:
            msg = {
                "content": m["body"],
                "message_type": "outgoing" if m["direction"] == "saliente" else "incoming",
                "created_at": int(datetime.fromisoformat(m["ts_utc"]).timestamp()),
                "sender": m["sender"],
                "private": False,
            }
            if m["media"]:
                msg["attachments"] = [{
                    "file_path": localize_media(root, m["media"], outdir, outdir),
                    "file_type": m["mime"] or m["type"],
                }]
            messages.append(msg)
        conversations.append({
            "contact_identifier": chat_id,
            "inbox_identifier": "whatsapp_business_export",
            "messages": messages,
        })

    payload = {
        "export_format": "chatwoot-bulk-import-v1 (no oficial, best-effort)",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "media_root": str(root.resolve()),
        "contacts": contacts,
        "conversations": conversations,
    }
    (outdir / "chatwoot_export.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


FORMAT_WRITERS: dict[str, Callable[[Iterable[dict], Path, Path], None]] = {
    "html": write_html,
    "txt": write_txt,
    "json": write_jsonl,
    "csv": write_csv,
    "markdown": write_markdown,
    "chatwoot": write_chatwoot,
}


def load_contacts(path: Path) -> ContactIndex | None:
    """Parsea un .vcf y reporta por log(); nunca lanza, si no hay nada
    utilizable devuelve None y la exportacion sigue sin resolver nombres."""
    idx, warnings = ContactIndex.from_vcf(path)
    for w in warnings:
        log(f"AVISO (contactos): {w}")
    if idx.stats["contacts_parsed"] == 0:
        log(f"AVISO: no se encontraron contactos utilizables en {path}; "
            "se sigue sin resolver nombres")
        return None
    collided = idx.stats["collisions_exact"] + idx.stats["collisions_suffix"]
    msg = f"contactos: {idx.stats['contacts_parsed']} cargados"
    if collided:
        msg += f", {collided} numero(s) sin resolver por coincidencia ambigua"
    log(msg)
    return idx


def export(media_dir: Path, db: Path, outdir: Path, fmt: str | None = None,
           progress_cb: Callable[[], None] | None = None,
           contacts: ContactIndex | None = None) -> dict:
    if fmt is not None and fmt not in FORMAT_WRITERS:
        raise WaError("E41", f"formato desconocido: {fmt}",
                      f"validos: {', '.join(FORMAT_WRITERS)}")
    try:
        outdir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise WaError("E40", f"no se puede crear la carpeta de salida: {outdir}",
                      str(exc))

    cx = open_db(db)
    try:
        schema = detect_schema(cx)
        log(f"esquema detectado: {schema}")

        index = build_media_index(media_dir)
        log(f"indice de multimedia: {len(index)} archivos")

        stats = {"messages": 0, "media_missing": 0}
        chat_ids: set[str] = set()

        def tracked() -> Iterator[dict]:
            for rec in iter_rows(cx, schema, media_dir, index, contacts):
                stats["messages"] += 1
                chat_ids.add(rec["chat_id"])
                if rec["media_missing"]:
                    stats["media_missing"] += 1
                if progress_cb:
                    progress_cb()
                yield rec

        try:
            if fmt is None:
                # comportamiento historico: jsonl + csv + html juntos
                records = list(tracked())
                write_jsonl(records, outdir, media_dir)
                write_csv(records, outdir, media_dir)
                write_html(records, outdir, media_dir)
            else:
                FORMAT_WRITERS[fmt](tracked(), outdir, media_dir)
        except OSError as exc:
            raise WaError("E42", "fallo la escritura de la exportacion", str(exc))

        log(f"{stats['messages']} mensajes en {len(chat_ids)} conversaciones")
        if stats["media_missing"]:
            log(f"AVISO: {stats['media_missing']} adjuntos referenciados pero "
                "ausentes (borrados del telefono o limpiados por HyperOS)")

        summary = {
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "schema": schema,
            "format": fmt or "legacy (jsonl+csv+html)",
            "messages": stats["messages"],
            "chats": len(chat_ids),
            "media_missing": stats["media_missing"],
        }
        (outdir / "_summary.json").write_text(json.dumps(summary, indent=2))
        log(f"exportacion lista en {outdir}")
        return summary
    finally:
        cx.close()


# --------------------------------------------------------------------------
# apariencia de la consola
# --------------------------------------------------------------------------
# Paleta inspirada en WhatsApp. El tamano de fuente NO se toca por codigo:
# se probo con la API de consola de Windows (SetCurrentConsoleFontEx) y con
# el registro por-titulo, y ninguna de las dos tuvo efecto real en pruebas
# (Windows moderno la ignora en silencio). Lo que si funciona, comprobado, es
# agrandar y centrar la ventana con SetWindowPos.

WA_TEAL = "#075E54"
WA_GREEN = "#25D366"
WA_BLUE = "#34B7F1"
WA_AMBER = "#FFA000"
WA_RED = "#FF5252"
CREDIT = "hecho por github.com/argel-gomez - software libre, licencia MIT"


def _lerp_hex(a: str, b: str, t: float) -> str:
    ar, ag, ab = int(a[1:3], 16), int(a[3:5], 16), int(a[5:7], 16)
    br, bg, bb = int(b[1:3], 16), int(b[3:5], 16), int(b[5:7], 16)
    r = round(ar + (br - ar) * t)
    g = round(ag + (bg - ag) * t)
    bch = round(ab + (bb - ab) * t)
    return f"#{r:02x}{g:02x}{bch:02x}"


def gradient_text(text: str, start: str, end: str):
    from rich.text import Text
    out = Text()
    n = max(len(text) - 1, 1)
    for i, ch in enumerate(text):
        out.append(ch, style=f"bold {_lerp_hex(start, end, i / n)}")
    return out


def questionary_style():
    import questionary
    return questionary.Style([
        ("qmark", f"fg:{WA_GREEN} bold"),
        ("question", "bold"),
        ("answer", f"fg:{WA_BLUE} bold"),
        ("pointer", f"fg:{WA_GREEN} bold"),
        ("highlighted", f"fg:{WA_GREEN} bold"),
        ("selected", f"fg:#ffffff bg:{WA_TEAL}"),
        ("separator", "fg:#6c6c6c"),
        ("instruction", "fg:#808080 italic"),
        ("disabled", "fg:#858585 italic"),
    ])


def beautify_console() -> None:
    """Centra y agranda la ventana. Puramente cosmetico: cualquier fallo se
    ignora en silencio, nunca debe romper el wizard."""
    if os.name != "nt":
        return
    try:
        import ctypes

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32

        target_w, target_h = 1100, 700
        screen_w = user32.GetSystemMetrics(0)
        screen_h = user32.GetSystemMetrics(1)
        x = max(0, (screen_w - target_w) // 2)
        y = max(0, (screen_h - target_h) // 2)

        if os.environ.get("WT_SESSION"):
            # Windows Terminal: GetConsoleWindow() devuelve una ventana de
            # conhost oculta, no la visible. La visible es la que quedo al
            # frente justo despues de abrirse.
            hwnd = user32.GetForegroundWindow()
        else:
            hwnd = kernel32.GetConsoleWindow()

        if hwnd:
            SWP_NOZORDER = 0x0004
            user32.SetWindowPos(hwnd, None, x, y, target_w, target_h, SWP_NOZORDER)
    except Exception:
        pass


# --------------------------------------------------------------------------
# asistente interactivo
# --------------------------------------------------------------------------

FORMAT_CHOICES = [
    ("HTML - sitio navegable con fotos y adjuntos", "html"),
    ("TXT  - texto plano, un archivo por conversacion", "txt"),
    ("JSON - un mensaje por linea (JSONL)", "json"),
    ("CSV  - tabla para Excel / Sheets", "csv"),
    ("Markdown - un .md por conversacion", "markdown"),
    ("Chatwoot - JSON para importar despues (solo archivo, sin API)", "chatwoot"),
]


def clean_path_input(text: str) -> Path:
    return Path(text.strip().strip('"').strip("'")).expanduser()


# Carpetas "PLACE-HERE" del programa unificado (Backup WP and Chatwoot): el
# lanzador (menu.mjs) las pasa por variables de entorno. Si el usuario ya dejo
# ahi sus archivos, el asistente las ofrece como respuesta por defecto (Enter
# para aceptar) -- siempre se puede escribir otra ruta encima.

def drop_backup_default() -> str:
    # El usuario puede soltar la carpeta con cualquier anidado (visto en la vida
    # real: PLACE-HERE-1\WhatsAppBusiness\com.whatsapp.w4b\WhatsApp Business), asi
    # que se busca en anchura hasta 4 niveles. Se poda lo que no puede contener la
    # raiz (Media/Databases/Backups y carpetas ocultas — Media puede tener MILES de
    # subcarpetas) y se acota el total de carpetas visitadas: nunca se cuelga.
    base = os.environ.get("WA_DROP_BACKUP")
    if not base or not Path(base).is_dir():
        return ""
    skip = {"media", "databases", "backups", "node_modules"}
    pending = [(Path(base), 0)]
    visited = 0
    while pending and visited < 200:
        d, depth = pending.pop(0)
        visited += 1
        try:
            if (d / "Databases" / "msgstore.db.crypt15").is_file() and (d / "Media").is_dir():
                return str(d)
            if depth >= 4:
                continue
            for child in d.iterdir():
                if (child.is_dir() and not child.name.startswith(".")
                        and child.name.lower() not in skip):
                    pending.append((child, depth + 1))
        except OSError:
            continue
    return ""


def drop_contacts_default() -> str:
    base = os.environ.get("WA_DROP_CONTACTS")
    if not base:
        return ""
    try:
        vcfs = sorted(Path(base).glob("*.vcf"))
    except OSError:
        return ""
    return str(vcfs[0]) if len(vcfs) == 1 else ""


def default_export_dir(root: Path, fmt: str) -> Path:
    # El formato "chatwoot" va por defecto a la carpeta PLACE-HERE-3-CHATWOOT-EXPORT:
    # es lo que despues lee el importador de chats a Chatwoot.
    drop = os.environ.get("WA_DROP_EXPORT")
    if fmt == "chatwoot" and drop:
        return Path(drop) / "export_chatwoot"
    return root / f"export_{fmt}"


def prompt_root_folder() -> Path:
    """Carpeta del respaldo: la que contiene Databases, Media y Backups."""
    def check(text: str) -> bool | str:
        d = clean_path_input(text)
        if not d.is_dir():
            return f"[E10] la carpeta no existe: {d}"
        if not (d / "Databases" / "msgstore.db.crypt15").is_file():
            return ("[E12] no encuentro Databases/msgstore.db.crypt15 aca. "
                    "Elegi la carpeta del respaldo (la que contiene Databases, "
                    "Media y Backups).")
        if not (d / "Media").is_dir():
            return "[E11] falta la subcarpeta 'Media' dentro de esta carpeta."
        return True

    import questionary
    answer = questionary.path(
        "Carpeta del respaldo (la que contiene Databases, Media y Backups):",
        default=drop_backup_default(),
        validate=check, only_directories=True, style=questionary_style()).ask()
    if answer is None:
        raise WaError("E90", "cancelado por el usuario", exit_code=130)
    return clean_path_input(answer).resolve()


def prompt_key() -> str:
    import questionary

    def check(text: str) -> bool | str:
        try:
            validate_key(normalize_key(text))
            return True
        except WaError as e:
            return f"[{e.code}] {e.message}"

    answer = questionary.password(
        "Clave de 64 caracteres del respaldo cifrado (se puede pegar):",
        validate=check, style=questionary_style()).ask()
    if answer is None:
        raise WaError("E90", "cancelado por el usuario", exit_code=130)
    return normalize_key(answer)


def prompt_contacts_path() -> Path | None:
    import questionary

    def check(text: str) -> bool | str:
        text = text.strip()
        if not text:
            return True  # opcional, Enter para omitir
        if not clean_path_input(text).is_file():
            return f"no se encontro el archivo: {clean_path_input(text)}"
        return True

    default = drop_contacts_default()
    message = ("Contactos .vcf para resolver nombres (encontrado en PLACE-HERE-2 -- "
               "Enter para usarlo, borra la linea para omitir):" if default else
               "Contactos .vcf para resolver nombres (opcional, Enter para omitir):")
    answer = questionary.path(
        message, default=default,
        validate=check, style=questionary_style()).ask()
    if answer is None:
        raise WaError("E90", "cancelado por el usuario", exit_code=130)
    answer = answer.strip()
    return clean_path_input(answer) if answer else None


def prompt_format() -> str:
    import questionary

    answer = questionary.select(
        "Formato de exportacion (uno por sesion):",
        choices=[label for label, _ in FORMAT_CHOICES], style=questionary_style()).ask()
    if answer is None:
        raise WaError("E90", "cancelado por el usuario", exit_code=130)
    return dict(FORMAT_CHOICES)[answer]


def prompt_repeat() -> bool:
    import questionary

    answer = questionary.confirm(
        "Exportar tambien en otro formato (misma base ya descifrada)?",
        default=False, style=questionary_style()).ask()
    return bool(answer)


def prompt_output_folder(default: Path) -> Path:
    import questionary

    while True:
        answer = questionary.path("Carpeta donde dejar la exportacion:",
                                  default=str(default), only_directories=True,
                                  style=questionary_style()).ask()
        if answer is None:
            raise WaError("E90", "cancelado por el usuario", exit_code=130)
        out = clean_path_input(answer).resolve()
        try:
            out.mkdir(parents=True, exist_ok=True)
            return out
        except OSError as exc:
            print(f"[E40] no se puede usar esa carpeta: {exc}")


def wizard() -> None:
    ensure_dependencies()
    # imports diferidos: recien aca es seguro asumir que existen
    from rich.console import Console
    from rich.panel import Panel
    from rich.progress import (BarColumn, MofNCompleteColumn, Progress,
                               SpinnerColumn, TaskProgressColumn, TextColumn)

    beautify_console()
    console = Console(highlight=False)

    banner = gradient_text("Archivo de WhatsApp Business", WA_TEAL, WA_GREEN)
    console.print()
    console.print(Panel(banner, subtitle=f"[dim]{CREDIT}[/]",
                        border_style=WA_GREEN, padding=(1, 4)))
    console.print()
    console.print(f"[bold {WA_AMBER}][AVISO][/] la exportacion va a contener conversaciones "
                  f"reales de clientes. No la subas a ningun repositorio ni la compartas "
                  f"sin criterio.\n")

    if os.environ.get("WT_SESSION"):
        console.print(f"[dim]Tip: si el texto se ve chico, manten Ctrl y gira la rueda "
                      f"del mouse (o Ctrl y '+'). Windows Terminal lo recuerda para "
                      f"la proxima.[/]\n")

    try:
        root = prompt_root_folder()
        console.print(f"[bold {WA_GREEN}][OK][/] carpeta valida: {root}")

        db_path = root / "_wa_decrypted.db"
        while True:
            key = prompt_key()
            try:
                decrypt(root / "Databases", db_path, key=key)
                break
            except WaError as e:
                if e.code not in ("E23", "E24"):
                    raise
                console.print(f"[bold {WA_RED}]Error {e.code}[/]: {e.message}")
                if e.detail:
                    console.print(f"[dim]{e.detail}[/]")
                console.print("Volve a ingresar la clave.\n")
            finally:
                key = None

        console.print(f"[bold {WA_GREEN}][OK][/] clave correcta, base descifrada\n")

        contacts_path = prompt_contacts_path()
        contacts = load_contacts(contacts_path) if contacts_path else None
        console.print()

        while True:
            fmt = prompt_format()
            out_dir = prompt_output_folder(default_export_dir(root, fmt))

            total = count_messages(db_path)
            with Progress(SpinnerColumn(style=WA_GREEN),
                          TextColumn("[progress.description]{task.description}"),
                          BarColumn(complete_style=WA_GREEN, finished_style=WA_GREEN),
                          TaskProgressColumn(), MofNCompleteColumn(),
                          console=console) as progress:
                task = progress.add_task(f"Exportando a {fmt}...", total=total)
                summary = export(root / "Media", db_path, out_dir, fmt,
                                 progress_cb=lambda: progress.advance(task),
                                 contacts=contacts)

            if fmt == "chatwoot":
                # El importador de chats usa la base descifrada para el mapeo @lid y
                # los nombres de tarjetas compartidas. Como el export puede quedar
                # lejos del respaldo (carpeta PLACE-HERE-3), se deja apuntada la
                # ubicacion real de la base para que el importador la encuentre.
                (out_dir / "_msgstore_location.txt").write_text(str(db_path),
                                                                encoding="utf-8")

            console.print(Panel(
                f"[bold {WA_GREEN}][OK] Listo[/] - {summary['messages']} mensajes en "
                f"{summary['chats']} conversaciones\n"
                f"Salida: {out_dir}"
                + (f"\n[bold {WA_AMBER}][AVISO][/] {summary['media_missing']} adjuntos ausentes "
                   "(borrados del telefono antes del respaldo)"
                   if summary["media_missing"] else ""),
                border_style=WA_GREEN, padding=(1, 2)))
            console.print("[dim]Esta carpeta es independiente: copia sus propios adjuntos "
                          "en attachments/, asi que la podes mover o copiar (ej. al NAS) "
                          "sin la carpeta cruda.[/]\n")

            if not prompt_repeat():
                break
            console.print()

    except WaError as e:
        console.print(f"[bold {WA_RED}][ERROR {e.code}][/]: {e.message}")
        if e.detail:
            console.print(f"[dim]{e.detail}[/]")
        sys.exit(e.exit_code)
    except KeyboardInterrupt:
        console.print(f"\n[{WA_AMBER}]Cancelado.[/] [dim](E90)[/]")
        sys.exit(130)
    except Exception as exc:
        if type(exc).__name__ == "NoConsoleScreenBufferError":
            console.print(f"[bold {WA_RED}]Error E95[/]: el asistente necesita una consola real.")
            console.print("[dim]Abrilo en PowerShell o cmd.exe. No funciona con la salida "
                          "redirigida ni dentro de Git Bash/MSYS.[/]")
            sys.exit(1)
        console.print(f"[bold {WA_RED}]Error E00[/]: {type(exc).__name__}: {exc}")
        sys.exit(1)


# --------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("phase", choices=["wizard", "verify", "pull", "decrypt",
                                      "export", "all"])
    ap.add_argument("--root", type=Path, default=Path("./wa-raw"),
                    help="destino de la extraccion cruda")
    ap.add_argument("--db", type=Path, default=Path("./msgstore.db"))
    ap.add_argument("--out", type=Path, default=None,
                    help="carpeta de salida; por defecto ./export_<formato> "
                         "si se paso --format, o ./wa-export en modo legacy")
    ap.add_argument("--format", dest="fmt", choices=sorted(FORMAT_WRITERS),
                    default=None,
                    help="formato unico de exportacion; sin esto se generan "
                         "jsonl + csv + html como siempre")
    ap.add_argument("--contacts", type=Path, default=None,
                    help="'.vcf' opcional para resolver numeros a nombres "
                         "de contacto en chats individuales y remitentes de "
                         "grupo; si falla o no aporta nada, se sigue sin "
                         "resolver (nunca corta la exportacion)")
    a = ap.parse_args()

    if a.phase == "wizard":
        wizard()
        return

    out = a.out if a.out is not None else Path(
        f"./export_{a.fmt}" if a.fmt else "./wa-export")

    try:
        if a.phase == "verify":
            pull(a.root, dry_run=True)
            return
        if a.phase in ("pull", "all"):
            pull(a.root)
        if a.phase in ("decrypt", "all"):
            decrypt(a.root / "Databases", a.db)
        if a.phase in ("export", "all"):
            contacts = load_contacts(a.contacts) if a.contacts else None
            export(a.root / "Media", a.db, out, a.fmt, contacts=contacts)
    except WaError as e:
        print(f"ERROR [{e.code}] {e.message}", file=sys.stderr)
        if e.detail:
            print(e.detail, file=sys.stderr)
        sys.exit(e.exit_code)
    except KeyboardInterrupt:
        print("ERROR [E90] cancelado por el usuario", file=sys.stderr)
        sys.exit(130)


if __name__ == "__main__":
    main()
