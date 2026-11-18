#!/usr/bin/env bash
# Run in Google Cloud Shell:
#   bash <(curl -sL https://raw.githubusercontent.com/dooverlang-spec/doover-media/main/server/tiktok/deploy.sh)
# Re-running is safe; press Enter at a prompt to keep the stored value.
set -euo pipefail

PROJECT=doover-promo
REGION=asia-northeast3
SA=tiktok-uploader@${PROJECT}.iam.gserviceaccount.com
SRC=https://raw.githubusercontent.com/dooverlang-spec/doover-media/main/server/tiktok

gcloud config set project "$PROJECT" >/dev/null
echo "== APIs 켜는 중 (처음엔 1~2분)"
gcloud services enable cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com >/dev/null

gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create tiktok-uploader --display-name "Doover TikTok uploader" >/dev/null

ensure_secret() { gcloud secrets describe "$1" >/dev/null 2>&1 || gcloud secrets create "$1" --replication-policy automatic >/dev/null; }
put() { printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null; }
has_version() { [ -n "$(gcloud secrets versions list "$1" --filter=state:ENABLED --limit=1 --format='value(name)')" ]; }

for s in tiktok-client-key tiktok-client-secret tiktok-session-secret tiktok-routine-key tiktok-token; do ensure_secret "$s"; done

echo
echo "== 틱톡 개발자 사이트 앱 화면의 값을 입력하세요 (화면에 안 보여도 입력되고 있어요)"
read -rsp "Client key: " CK; echo
read -rsp "Client secret: " CS; echo
[ -n "$CK" ] && put tiktok-client-key "$CK"
[ -n "$CS" ] && put tiktok-client-secret "$CS"
has_version tiktok-client-key && has_version tiktok-client-secret || { echo "Client key/secret이 비어 있어요. 다시 실행해 주세요."; exit 1; }
has_version tiktok-session-secret || put tiktok-session-secret "$(openssl rand -hex 32)"
has_version tiktok-routine-key || put tiktok-routine-key "$(openssl rand -hex 24)"

for s in tiktok-client-key tiktok-client-secret tiktok-session-secret tiktok-routine-key tiktok-token; do
  gcloud secrets add-iam-policy-binding "$s" --member "serviceAccount:$SA" \
    --role roles/secretmanager.secretAccessor >/dev/null
done
gcloud secrets add-iam-policy-binding tiktok-token --member "serviceAccount:$SA" \
  --role roles/secretmanager.secretVersionManager >/dev/null

DIR=$(mktemp -d)
curl -sfL "$SRC/index.js" -o "$DIR/index.js"
curl -sfL "$SRC/package.json" -o "$DIR/package.json"

echo "== 서버 설치 중 (2~4분)"
gcloud functions deploy tiktok --gen2 --region "$REGION" --runtime nodejs20 \
  --source "$DIR" --entry-point tiktok --trigger-http --allow-unauthenticated \
  --service-account "$SA" --memory 512Mi --timeout 120s --max-instances 2 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT" \
  --set-secrets "TIKTOK_CLIENT_KEY=tiktok-client-key:latest,TIKTOK_CLIENT_SECRET=tiktok-client-secret:latest,SESSION_SECRET=tiktok-session-secret:latest,ROUTINE_KEY=tiktok-routine-key:latest" \
  >/dev/null

URL="https://${REGION}-${PROJECT}.cloudfunctions.net/tiktok"
if curl -sf "$URL/config" | grep -q client_key; then
  echo; echo "완료: 서버가 응답합니다. 채팅에 '설치 끝'이라고만 알려 주세요."
else
  echo; echo "설치는 끝났지만 응답 확인에 실패했어요. 이 화면 마지막 몇 줄을 캡처해서 보내 주세요(비밀값은 화면에 나오지 않아요)."
fi
