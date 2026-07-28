#!/usr/bin/env bash
# Деплой notes на my-vpn.
#
#   ./deploy.sh              — образ собирается здесь, на сервер едет только он
#   ./deploy.sh --skip-dns   — не трогать DNS в Timeweb
#   ./deploy.sh --logs       — показать логи контейнера после деплоя
#
# Исходников на сервере нет: туда уходят compose.yml, .env и docker-образ, внутри
# которого лежит только dist (бандл сервера + собранный фронт).
#
# Секреты: .env собирается из sec-проекта `notes`, токен Timeweb — из home-kai/TIMEWEB_TOKEN.
# Ни то, ни другое не попадает в argv и в вывод.
set -euo pipefail

SSH_HOST="my-vpn"
REMOTE_PATH="/app/notes"
DOMAIN="notes.kaidstor.ru"
SUBDOMAIN="notes"
BASE_DOMAIN="kaidstor.ru"
SERVER_IP="82.97.248.187"
IMAGE_NAME="notes"
CONTAINER_NAME="notes"
SEC_PROJECT="notes"
KEEP_IMAGES=3

SKIP_DNS=0
SHOW_LOGS=0

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }
success() { echo -e "${GREEN}✅ $1${NC}"; }
warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
error()   { echo -e "${RED}❌ $1${NC}" >&2; }

for arg in "$@"; do
  case "$arg" in
    --skip-dns) SKIP_DNS=1 ;;
    --logs|-l)  SHOW_LOGS=1 ;;
    -h|--help)  sed -n '2,12p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *)          error "неизвестный флаг $arg"; exit 1 ;;
  esac
done

cd "$(dirname "$0")"
START_TIME=$(date +%s)
VERSION=$(date +"%Y%m%d_%H%M%S")
TAR_FILE="${IMAGE_NAME}_${VERSION}.tar"

cleanup_local() { rm -f "$TAR_FILE"; }
trap cleanup_local EXIT

# --- проверки ----------------------------------------------------------------

need() { command -v "$1" >/dev/null 2>&1 || { error "нет $1"; exit 1; }; }

preflight() {
  info "Проверки..."
  need ssh; need rsync; need docker; need sec; need jq

  ssh -q -o ConnectTimeout=10 "$SSH_HOST" exit || { error "нет доступа к $SSH_HOST"; exit 1; }
  sec ls "$SEC_PROJECT" >/dev/null 2>&1 || { error "нет sec-проекта $SEC_PROJECT"; exit 1; }

  ssh "$SSH_HOST" 'docker network inspect vpn >/dev/null 2>&1' \
    || { error "на сервере нет docker-сети vpn"; exit 1; }

  success "Окружение в порядке"
}

# --- DNS в Timeweb -----------------------------------------------------------

tw_api() {
  # Токен уходит в curl через stdin-конфиг, а не через argv (ps его не увидит).
  local method="$1" path="$2" body="${3:-}"
  local token="${TIMEWEB_TOKEN:-$(sec get home-kai/TIMEWEB_TOKEN)}"

  if [[ -n "$body" ]]; then
    printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$token" \
      | curl -s --max-time 30 --config - -X "$method" --data "$body" "https://api.timeweb.cloud$path"
  else
    printf 'header = "Authorization: Bearer %s"\n' "$token" \
      | curl -s --max-time 30 --config - -X "$method" "https://api.timeweb.cloud$path"
  fi
}

ensure_dns() {
  info "DNS: $DOMAIN → $SERVER_IP"

  # В Timeweb поддомен — отдельный объект со своим набором записей: A-запись живёт
  # в /domains/notes.kaidstor.ru/dns-records с subdomain: null, а не в записях
  # родительского домена с subdomain: "notes".
  local records
  records=$(tw_api GET "/api/v1/domains/$DOMAIN/dns-records")

  if ! jq -e '.dns_records' >/dev/null 2>&1 <<<"$records"; then
    info "Поддомена $DOMAIN ещё нет — создаю"
    local created
    created=$(tw_api POST "/api/v1/domains/$BASE_DOMAIN/subdomains/$SUBDOMAIN")
    jq -e '.subdomain' >/dev/null 2>&1 <<<"$created" \
      || { error "Timeweb не создал поддомен: $(jq -c '.' <<<"$created" 2>/dev/null || echo "$created")"; exit 1; }
    success "Поддомен создан (id $(jq -r '.subdomain.id' <<<"$created"))"
    records='{"dns_records":[]}'
  fi

  local existing
  existing=$(jq -r '.dns_records[]? | select(.type == "A") | "\(.id) \(.data.value)"' <<<"$records" | head -1)

  if [[ -n "$existing" ]]; then
    local value="${existing#* }"
    if [[ "$value" == "$SERVER_IP" ]]; then
      success "A-запись уже на месте (id ${existing%% *})"
    else
      warning "A-запись $DOMAIN указывает на $value, а не на $SERVER_IP — правь руками, скрипт чужие записи не трогает"
    fi
    return
  fi

  # Запись создаётся на РОДИТЕЛЬСКОМ домене, а в subdomain идёт полный FQDN
  # ("notes.kaidstor.ru", не "notes"). POST на /domains/notes.kaidstor.ru/dns-records
  # отвечает bad_subdomain_name, хотя читаются записи именно оттуда.
  local response
  response=$(tw_api POST "/api/v1/domains/$BASE_DOMAIN/dns-records" \
    "$(jq -nc --arg sub "$DOMAIN" --arg ip "$SERVER_IP" '{type: "A", subdomain: $sub, value: $ip}')")

  if jq -e '.dns_record.id' >/dev/null 2>&1 <<<"$response"; then
    success "A-запись создана (id $(jq -r '.dns_record.id' <<<"$response"))"
  else
    error "Timeweb не создал запись: $(jq -c '.' <<<"$response" 2>/dev/null || echo "$response")"
    exit 1
  fi
}

# Контейнер поднимать только после того, как запись увидят публичные резолверы:
# traefik просит сертификат сразу при старте, и на NXDOMAIN Let's Encrypt отвечает
# отказом, после чего повторяет с большой задержкой.
wait_dns() {
  info "Жду, пока A-запись увидят публичные резолверы..."

  for _ in $(seq 1 30); do
    local seen=1
    for ns in 8.8.8.8 1.1.1.1; do
      local resolved
      resolved=$(nslookup "$DOMAIN" "$ns" 2>/dev/null | awk '/^Address: /{print $2}' | tail -1)
      [[ "$resolved" == "$SERVER_IP" ]] || seen=0
    done

    if [[ $seen == 1 ]]; then
      success "DNS разошёлся"
      return
    fi
    sleep 10
  done

  warning "Резолверы всё ещё не видят $DOMAIN — Let's Encrypt откажет в сертификате; повтори деплой позже"
}

# --- сборка образа -----------------------------------------------------------

build_image() {
  info "Сборка образа под linux/amd64..."
  docker build --platform linux/amd64 \
    -t "$IMAGE_NAME:$VERSION" -t "$IMAGE_NAME:latest" .

  # Страховка от регресса в Dockerfile: рантайм-слой не должен нести исходники.
  if docker run --rm --entrypoint sh "$IMAGE_NAME:latest" -c '[ -e /app/src ] || [ -e /app/node_modules ]'; then
    error "в образе оказались исходники или node_modules — проверь Dockerfile"
    exit 1
  fi

  success "Образ собран: $IMAGE_NAME:$VERSION ($(docker images "$IMAGE_NAME:$VERSION" --format '{{.Size}}'))"
}

# --- доставка ----------------------------------------------------------------

push_config() {
  info "compose.yml и секреты → $SSH_HOST:$REMOTE_PATH"
  ssh "$SSH_HOST" "mkdir -p $REMOTE_PATH/data"
  rsync -a compose.yml "$SSH_HOST:$REMOTE_PATH/compose.yml"

  local tmp
  tmp=$(mktemp -t notes-env)
  chmod 600 "$tmp"
  # ловушка на выход из функции: временный .env не должен пережить скрипт даже при ошибке
  trap 'rm -f "$tmp"' RETURN

  sec export "$SEC_PROJECT" --file "$tmp" >/dev/null
  rsync -a --chmod=600 "$tmp" "$SSH_HOST:$REMOTE_PATH/.env"

  success "Конфиг доставлен"
}

push_image() {
  info "docker save → rsync (дельтой к прошлому архиву)"
  docker save "$IMAGE_NAME:latest" "$IMAGE_NAME:$VERSION" > "$TAR_FILE"
  info "Размер архива: $(du -h "$TAR_FILE" | cut -f1)"

  rsync -z --partial "$TAR_FILE" "$SSH_HOST:$REMOTE_PATH/image.tar"

  info "docker load + up на сервере..."
  ssh "$SSH_HOST" "cd $REMOTE_PATH \
    && docker load < image.tar \
    && rm -f image.tar \
    && docker compose up -d $CONTAINER_NAME"

  success "Контейнер поднят"
}

prune_old_images() {
  ssh "$SSH_HOST" "docker images $IMAGE_NAME --format '{{.Tag}}' \
    | grep -v latest | sort -r | tail -n +$((KEEP_IMAGES + 1)) \
    | xargs -r -I{} docker image rm $IMAGE_NAME:{} >/dev/null 2>&1 || true"
  info "На сервере оставлено последних образов для отката: $KEEP_IMAGES"
}

# --- проверка ----------------------------------------------------------------

healthcheck() {
  info "Проверка контейнера..."
  ssh "$SSH_HOST" "docker ps -f name=^$CONTAINER_NAME\$ --format '{{.Names}}\t{{.Status}}'"

  info "Ждём https://$DOMAIN (сертификат Let's Encrypt выдаётся не мгновенно)..."
  for attempt in $(seq 1 20); do
    if curl -sf --max-time 5 "https://$DOMAIN/healthz" >/dev/null 2>&1; then
      success "https://$DOMAIN отвечает: $(curl -s "https://$DOMAIN/healthz")"
      return
    fi
    sleep 3
    if [[ $attempt == 10 ]]; then info "всё ещё ждём (DNS/сертификат)..."; fi
  done

  warning "https://$DOMAIN пока не отвечает — смотри 'docker logs traefik' и 'docker logs $CONTAINER_NAME'"
}

# --- запуск ------------------------------------------------------------------

preflight
if [[ $SKIP_DNS == 0 ]]; then ensure_dns; wait_dns; fi
build_image
push_config
push_image
prune_old_images
healthcheck
if [[ $SHOW_LOGS == 1 ]]; then ssh "$SSH_HOST" "docker logs --tail 50 $CONTAINER_NAME"; fi

success "Готово за $(( $(date +%s) - START_TIME ))с — https://$DOMAIN"
