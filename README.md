# api-admin-foodtag · API del super admin de FoodTag

Plano de control de **todos los restaurantes (tenants)**. Cada restaurante corre en su propia instancia de `api-foodtag` (API + base propias); esta API registra cada instancia, guarda el estado deseado (módulos contratados, suspensión) y se lo empuja a la instancia por un canal protegido. También crea y administra las instancias (Docker).

La pantalla es otro proyecto: [`app-admin-foodtag`](../app-admin-foodtag) (misma base que `app-foodtag`). Esta API es Express + TypeORM + Postgres propia (administradores, restaurantes, auditoría, respaldos).

## Cómo funciona
Hay dos formas de dar de alta un restaurante:

**Creada por el panel (recomendada, `PROVISIONER=docker`).** Se carga nombre, slug, módulos y el email del dueño; el panel levanta la instancia solo:
1. Base propia: un rol y una base (`ft_<slug>` / `foodtag_<slug>`) en el Postgres compartido.
2. Contenedor `foodtag-<slug>` con la imagen de `api-foodtag`, su `JWT_SECRET`, su `PLATFORM_ADMIN_TOKEN` y la web de gestión montada; arranca creando el esquema (`BOOTSTRAP_SCHEMA`) y corriendo migraciones (`RUN_MIGRATIONS`).
3. Dirección `<slug>.foodtag.com` (dominio provisorio, `INSTANCE_BASE_DOMAIN`) por etiquetas de Traefik. En desarrollo (`INSTANCE_ROUTING=port`) no hace falta proxy ni DNS: cada restaurante queda en su propio puerto, `http://localhost:4100`, `4101`…
4. Se le empuja la configuración (módulos, zona horaria) y se crea el **dueño** con una contraseña temporal que se muestra **una sola vez**.
El restaurante pasa por `PROVISIONING` → `ACTIVE`; si algo falla queda `FAILED` con el motivo y se reintenta (los pasos ya hechos se reutilizan).

**Instancia existente** (`mode: "existing"`): se carga la URL y se genera (o se pega) el token; el panel muestra las variables para la instancia (`PLATFORM_ADMIN_TOKEN`, `ENABLED_MODULES`).

En los dos casos:
- Cada cambio (datos, módulos, suspender/reanudar) se guarda en el panel y se empuja a la instancia. Si no responde, queda guardado y el restaurante figura «Sin conexión» hasta sincronizar.
- En la instancia: suspender corta logins y sesiones abiertas; cambiar módulos hace que las sesiones anteriores pidan volver a entrar.
- El token de cada instancia se guarda cifrado (AES-256-GCM con `ADMIN_SECRET_KEY`) y nunca se devuelve por la API; consultarlo queda en la auditoría.

### Operación de las instancias creadas por el panel
- **Actualizar versión** (una o «Actualizar todas», de a una): renombra el contenedor viejo, levanta el nuevo con la imagen indicada y, si no queda sano, vuelve al anterior (el restaurante sigue `ACTIVE` con el aviso).
- **Respaldos**: `pg_dump -Fc` de su base, manual o diario automático (`BACKUP_HOUR`, `BACKUP_RETENTION_DAYS`) en `BACKUP_DIR`; se pueden descargar y borrar. Se restauran con `pg_restore`.
- **Baja**: hay que escribir el slug. Con «borrar datos» se hace antes un respaldo (`PRE_REMOVE`) y se eliminan base, rol y volumen de imágenes; sin eso solo se quita el contenedor. Con los datos borrados el slug queda libre.
- **Monitoreo** (`MONITOR_INTERVAL_SECONDS`): reinicia contenedores caídos y vuelve a empujar el estado deseado si la instancia difiere (nombre, zona horaria, módulos, suspensión).
- Si el panel se reinicia en medio de una operación, al arrancar un alta interrumpida queda `FAILED` (se reintenta) y una actualización o baja interrumpida vuelve a `READY` con el aviso.
- Seguridad: Docker se invoca con `execFile` (sin shell), los secretos van a la instancia por un `--env-file` temporal (0600) y el panel necesita acceso al socket de Docker: tratalo como un servicio privilegiado.
- Fase 3 (nodo local sin conexión en el dispositivo madre): pendiente, ver `../PLAN_INSTANCIAS_Y_OFFLINE.md`.

## Puesta en marcha
```bash
cp .env.example .env   # completar DB, JWT_SECRET y ADMIN_SECRET_KEY (32+ caracteres)
npm install && npm run dev
npm run create-admin -- admin@tuempresa.com "una-clave-larga" "Tu nombre"
```
`npm run check:modules` verifica que el catálogo de módulos coincida con el de `api-foodtag`.

### Aprovisionamiento
1. Construir la imagen y la web de las instancias: `docker build -t foodtag-api:local ../api-foodtag` y `npm run build:instance` en `app-foodtag` (carpeta `dist-instance`, la que va en `INSTANCE_WEB_DIR`; en macOS tiene que estar fuera de `Desktop`/`Documents`).
2. Infraestructura compartida (Traefik + Postgres): `deploy/docker-compose.yml`. Vive acá porque es lo que esta API aprovisiona.
3. Completar en `.env` las variables de `PROVISIONER` … `MONITOR_INTERVAL_SECONDS` (ver `.env.example`) y reiniciar. `GET /system` informa si quedó habilitado; sin `PROVISIONER=docker` el panel solo registra instancias existentes.

## Pruebas de punta a punta (`tests/e2e/`)
- `flow.mjs`: recorrido contra una instancia ya levantada con `PLATFORM_ADMIN_TOKEN`. Correrlo con `PROVISIONER=` vacío (si no, crea contenedores).
- `provisioning.mjs`: alta, dueño, suspensión, respaldos, actualización con rollback y baja contra Docker real (con `PROVISIONER=docker`).
