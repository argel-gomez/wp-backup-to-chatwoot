# WhatsApp Business Backup to Chatwoot

Herramienta de código abierto para respaldar WhatsApp Business para Android,
exportar el historial e importar contactos, conversaciones y adjuntos a
Chatwoot.

Todo se ejecuta desde la computadora del usuario. Los respaldos, contactos,
mensajes, tokens, contraseñas y llaves SSH quedan fuera de Git.

> [!IMPORTANT]
> Este proyecto no es oficial ni está afiliado con WhatsApp o Chatwoot. La
> importación de chats escribe directamente en PostgreSQL y debe probarse primero
> en una copia. Hacé un `pg_dump` antes de modificar una instancia real.

## Qué modalidad elegir

| Necesidad | Chatwoot Cloud | Chatwoot autohospedado |
|---|---:|---:|
| Respaldar y exportar WhatsApp | Sí, no requiere Chatwoot | Sí |
| Importar contactos por API | Sí | Sí |
| Importar chats con fecha histórica | No | Sí, requiere SSH y PostgreSQL |
| Importar adjuntos históricos | No | Sí, requiere SSH y acceso al storage |

Chatwoot permite usar su API tanto en Cloud como en instalaciones propias, pero
el acceso administrativo a PostgreSQL solamente existe en una instalación
autohospedada. Si un proveedor administra el servidor y no entrega SSH/base de
datos, usá únicamente respaldo/exportación y contactos por API.

## Modelo de seguridad de PostgreSQL

**No abras el puerto 5432 en Internet.** El programa usa este recorrido:

```text
Programa en Windows → 127.0.0.1:15432 → túnel SSH → PostgreSQL del servidor:5432
```

Durante el onboarding, una instalación Docker puede detectarse automáticamente:

1. El usuario proporciona host, usuario y llave SSH.
2. El programa comprueba la conexión sin contraseña (`BatchMode`).
3. Con autorización explícita, ejecuta por SSH una inspección de solo lectura.
4. Lee únicamente `DATABASE_URL` o las variables `POSTGRES_*` del contenedor
   Rails y la ubicación interna del contenedor PostgreSQL.
5. Construye una URL que apunta a `127.0.0.1:15432` y la guarda en el `.env`
   local. La contraseña nunca se muestra en pantalla.
6. Al abrir el túnel, PostgreSQL sigue accesible únicamente a través de SSH.

La configuración oficial de Chatwoot admite `DATABASE_URL` o variables
`POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DATABASE`, `POSTGRES_USERNAME` y
`POSTGRES_PASSWORD`. Su Compose de producción publica PostgreSQL en el localhost
del servidor, no directamente en Internet. Consultá la
[referencia de variables](https://developers.chatwoot.com/self-hosted/configuration/environment-variables)
y la [guía oficial de Docker](https://developers.chatwoot.com/self-hosted/deployment/docker).

## Requisitos

- Windows 10 u 11.
- [Node.js](https://nodejs.org/) 22.13 o posterior; Node.js 24 LTS recomendado.
- Para respaldo: una copia de la carpeta de WhatsApp Business de Android y, si
  la base está cifrada, su clave de 64 dígitos.
- Para contactos: URL de Chatwoot y un token de usuario con acceso a la cuenta.
- Para chats: Chatwoot autohospedado, SSH administrativo, PostgreSQL y acceso al
  almacenamiento de adjuntos.
- El asistente intenta instalar Python 3.12 mediante `winget` cuando hace falta.
- Cliente OpenSSH de Windows para túnel/detección del servidor.

## Instalación

### Descargar un ZIP

1. En GitHub, elegí **Code → Download ZIP**.
2. Extraé todo el ZIP en una carpeta local; no ejecutes `run.bat` dentro del ZIP.
3. Hacé doble clic en `run.bat`.

### Clonar con Git

```powershell
git clone https://github.com/argel-gomez/wp-backup-to-chatwoot.git
cd wp-backup-to-chatwoot
.\run.bat
```

La primera ejecución instala las dependencias de Node.js y crea `.env` desde
`.env.example`.

## Onboarding de primera ejecución

Al iniciar se pregunta qué alcance necesitás:

### 1. Solo respaldo/exportación

No solicita variables de Chatwoot. Permite verificar, descifrar y exportar el
respaldo local en HTML, texto, JSON, CSV, Markdown o formato Chatwoot.

### 2. Respaldo y contactos por API

Solicita:

- URL base: `https://app.chatwoot.com` o el dominio de la instalación propia.
- Token de acceso: Chatwoot → **Configuración del perfil → Token de acceso**.
- Código telefónico predeterminado: por ejemplo `+55`, `+34` o `+52`.

El token se escribe oculto. El programa llama a `/api/v1/profile`, valida el
token y obtiene las cuentas disponibles. Si hay varias, permite elegir una sin
tener que buscar manualmente el `ACCOUNT_ID`.

### 3. Flujo completo autohospedado

Además de la API opcional, solicita:

- `SSH_HOST`: dominio o IPv4 del servidor.
- `SSH_USER`: usuario SSH, normalmente `ubuntu`.
- `SSH_KEY`: archivo `.pem` o una carpeta donde buscarlo.

Después prueba SSH y ofrece detectar PostgreSQL desde Docker. Para autorizar la
detección, el usuario SSH debe ejecutar `docker info`; también funciona con
`sudo -n docker` cuando el servidor permite Docker sin contraseña interactiva.

Si la detección falla porque la instalación no usa Docker, podés pegar
`DATABASE_URL` manualmente. El valor se escribe oculto y debe usar el puerto
local del túnel:

```text
postgresql://USUARIO:CONTRASEÑA@127.0.0.1:15432/NOMBRE_BASE
```

El administrador encuentra los valores originales en el `.env` de Chatwoot.
En el servidor, desde la carpeta de instalación, puede revisar solamente las
variables relevantes:

```bash
grep -E '^(DATABASE_URL|POSTGRES_HOST|POSTGRES_PORT|POSTGRES_DATABASE|POSTGRES_DB|POSTGRES_USERNAME|POSTGRES_USER|POSTGRES_PASSWORD)=' .env
```

No publiques ni pegues esa salida en issues o chats. Si PostgreSQL es un servicio
administrado, `TUNNEL_REMOTE_HOST` debe ser el host de la base visto desde el
servidor SSH.

### 4. Configurar después

Abre el menú sin pedir integraciones. La opción 8 vuelve a ejecutar el
onboarding cuando tengas los datos.

## Variables guardadas

| Variable | Uso | Secreto |
|---|---|---:|
| `SETUP_MODE` | Modalidad elegida en el onboarding | No |
| `CHATWOOT_BASE_URL` | URL de Chatwoot | No |
| `CHATWOOT_ACCOUNT_ID` | Cuenta elegida | No |
| `CHATWOOT_TOKEN` | Autenticación de API | Sí |
| `DEFAULT_COUNTRY_CODE` | Prefijo para números nacionales | No |
| `SSH_HOST`, `SSH_USER` | Acceso al servidor | No |
| `SSH_KEY` | Ruta local de la llave privada | Sensible |
| `DATABASE_URL` | Usuario y contraseña PostgreSQL | Sí |
| `TUNNEL_LOCAL_PORT` | Puerto local; predeterminado `15432` | No |
| `TUNNEL_REMOTE_HOST` | Base vista desde el servidor SSH | No |
| `TUNNEL_REMOTE_PORT` | Puerto remoto; predeterminado `5432` | No |
| `ACCOUNT_ID`, `INBOX_ID`, `AGENT_USER_ID` | Destino de chats | No |
| `EXPORT_DIR`, `STORAGE_ROOT` | Export y staging de adjuntos | No |

El archivo `.env` está ignorado por Git. Para cambiar valores podés repetir el
onboarding, usar las opciones de configuración de cada módulo o editar `.env`
localmente. Nunca reemplaces `.env.example` con tus valores reales.

## Manual del flujo completo

### Paso 0: preparar los archivos

El programa crea tres carpetas, cada una con un `LEEME.txt`:

| Carpeta | Qué colocar |
|---|---|
| `PONER-AQUI-1-respaldo-celular\` | Carpeta de WhatsApp Business que contiene `Databases`, `Media` y `Backups` |
| `PONER-AQUI-2-contactos\` | Archivo `.vcf` o `.csv` de contactos |
| `PONER-AQUI-3-export-chats\` | `chatwoot_export.json` y carpeta `attachments` |

En Android, la carpeta de WhatsApp Business suele encontrarse en:

```text
Almacenamiento interno/Android/media/com.whatsapp.w4b/WhatsApp Business
```

### Paso 1: respaldar y exportar WhatsApp

1. Copiá la carpeta completa en `PONER-AQUI-1-respaldo-celular`.
2. Ejecutá `run.bat` y elegí la opción 1.
3. El asistente verifica `Databases`, `Media` y `Backups`.
4. Si se solicita, introducí la clave de 64 dígitos. No se guarda en disco.
5. Elegí el formato **Chatwoot** si luego importarás los chats.
6. Confirmá que se generaron `chatwoot_export.json`, `_summary.json` y
   `attachments` dentro de `PONER-AQUI-3-export-chats`.

### Paso 2: importar contactos

1. Exportá contactos como VCF o CSV.
2. Para CSV se recomiendan columnas `name`, `phone_number`, `email`, `city` y
   `country`; también admite `first_name` y `last_name`.
3. Colocá el archivo en `PONER-AQUI-2-contactos`.
4. Elegí la opción 2 del menú principal.
5. Primero usá la prueba con 1–2 contactos.
6. Revisá esos contactos en Chatwoot y recién después continuá con el resto.

Un mismo archivo puede contener números de cualquier país. Los números con `+`
o prefijo internacional `00` se conservan como E.164; las pruebas usan números
de rangos reservados para ficción como `+12025550123`, `00442079460123` y
`+61255501234`. Los números nacionales sin prefijo reciben
`DEFAULT_COUNTRY_CODE`. Para `+55` también se aplican controles específicos de
DDD y celulares brasileños; para otros países no se inventan reglas nacionales.

### Paso 3: abrir el túnel SSH

1. Elegí la opción 3.
2. El programa prueba la llave y el servidor.
3. Se abre otra ventana con el túnel.
4. Dejá esa ventana abierta durante toda la importación.
5. No agregues ninguna regla pública para el puerto 5432.

Si `15432` está ocupado, cambiá `TUNNEL_LOCAL_PORT` en `.env`, por ejemplo a
`25432`, y actualizá/repite el onboarding para reconstruir `DATABASE_URL`.

### Paso 4: respaldar PostgreSQL

Antes de importar, entrá por SSH al servidor y creá un dump. En Docker Compose,
adaptando usuario y base a tu `.env`:

```bash
docker compose exec -T postgres pg_dump -U postgres chatwoot > chatwoot-antes-whatsapp.sql
```

Verificá que el archivo exista y tenga tamaño razonable:

```bash
ls -lh chatwoot-antes-whatsapp.sql
```

Guardalo fuera del contenedor y, preferentemente, copiá una segunda versión a
otro almacenamiento.

### Paso 5: reconocer y probar la importación

1. Elegí la opción 4 del menú principal.
2. Ejecutá **Dry-run**: analiza el export sin tocar PostgreSQL.
3. Ejecutá **Reconocimiento de la base**: lista cuentas, bandejas, agentes y
   storage sin insertar mensajes.
4. Verificá los nombres de contacto.
5. Importá solamente 1–2 chats de prueba.
6. Revisá fechas, remitentes, bandeja, nombres y adjuntos en Chatwoot.

### Paso 6: importar el historial

En el menú de chats, seguí el orden indicado:

1. Mensajes de los últimos 12 meses.
2. Asociar adjuntos a los mensajes importados.
3. Subir los archivos al storage del servidor.
4. Historial anterior a 12 meses, si hace falta.

El estado se guarda en `estado.json`; si el proceso se interrumpe, una nueva
ejecución continúa con lo pendiente. La opción **Deshacer** elimina solamente
los registros identificados como creados por esta herramienta, pero no sustituye
el `pg_dump`.

## Comandos disponibles

| Comando | Acción |
|---|---|
| `npm start` | Abre el menú principal |
| `npm run onboarding` | Repite la configuración inicial |
| `npm run contactos -- archivo.csv` | Importa contactos |
| `npm run dry-run` | Analiza el export sin escribir en PostgreSQL |
| `npm run recon` | Ejecuta reconocimiento de solo lectura |
| `node modules/chats/import-chats.mjs --all` | Importa todos los chats pendientes |
| `node modules/chats/import-chats.mjs --undo` | Inicia el flujo de deshacer |
| `npm test` | Ejecuta las pruebas automatizadas locales |

## Problemas frecuentes

### Uso Chatwoot Cloud

No existe acceso a PostgreSQL ni SSH. Usá las opciones 1 y 2; la importación
histórica de chats y adjuntos queda deshabilitada por diseño.

### `No se pudo detectar PostgreSQL automáticamente`

- Confirmá que Chatwoot use Docker Compose.
- Probá `docker info` con el mismo usuario SSH.
- Si solo funciona con `sudo`, el servidor necesita permitir `sudo -n docker` o
  el administrador debe proporcionar `DATABASE_URL` manualmente.
- En instalaciones Linux nativas, obtené la configuración desde el `.env` de
  Chatwoot y completá el túnel manualmente.

### `Connection refused` a `127.0.0.1:15432`

- La ventana del túnel no está abierta.
- El puerto local cambió y `DATABASE_URL` todavía usa el anterior.
- `TUNNEL_REMOTE_HOST` o `TUNNEL_REMOTE_PORT` no coinciden con la instalación.

### HTTP 401 al importar contactos

Generá un token de usuario desde el perfil de Chatwoot y confirmá que ese usuario
tenga acceso a la cuenta elegida. Los tokens de Platform API no son equivalentes
a los tokens de usuario usados por estos endpoints.

### Cambios de esquema

WhatsApp y Chatwoot pueden modificar sus esquemas internos. No continúes si el
reconocimiento o el chat de prueba falla. Abrí un issue sin adjuntar datos reales,
tokens, dumps ni exports.

## Privacidad

- No uses `git add -f` con las carpetas `PONER-AQUI-*`.
- No publiques `.env`, `.pem`, VCF, CSV, dumps, `msgstore`, exports ni reportes.
- Procesá únicamente datos para los que tengas autorización.
- Rotá inmediatamente cualquier token o contraseña expuesta accidentalmente.

Consultá [SECURITY.md](SECURITY.md) para informar problemas sin divulgar datos.

## Desarrollo y verificación

```powershell
npm ci
npm test
```

Las pruebas cubren la construcción del túnel para Docker/servicios administrados,
contraseñas con caracteres especiales y teléfonos internacionales configurables.

## Licencia

[MIT](LICENSE). Podés usar, modificar y redistribuir el proyecto conservando el
aviso de licencia.
