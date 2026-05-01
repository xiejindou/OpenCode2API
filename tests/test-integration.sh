#!/bin/bash
set -euo pipefail

TEST_PORT="${TEST_PORT:-14096}"
CONTAINER_NAME="opencode2api-test-${TEST_PORT}"
INTERNAL_ALLOWED_TOOLS="${INTERNAL_ALLOWED_TOOLS:-web_fetch,filesystem}"
TOOL_DISCOVERY_FIXTURE="${TOOL_DISCOVERY_FIXTURE:-web_fetch,filesystem,bash}"

cleanup() {
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "--- Running Integration Tests ---"

echo "Building Docker image..."
docker build -t opencode2api:test .

echo "Starting container on port ${TEST_PORT}..."
cleanup

docker run -d --name "${CONTAINER_NAME}" \
    -p ${TEST_PORT}:10000 \
    -e API_KEY=test-key \
    -e OPENCODE_INTERNAL_ALLOWED_TOOLS="${INTERNAL_ALLOWED_TOOLS}" \
    -e OPENCODE_TOOL_DISCOVERY_FIXTURE="${TOOL_DISCOVERY_FIXTURE}" \
    opencode2api:test

echo "Waiting for service to be ready..."
MAX_RETRIES=30
COUNT=0
until curl -sf http://localhost:${TEST_PORT}/health > /dev/null 2>&1; do
    if [ $COUNT -ge $MAX_RETRIES ]; then
        echo "Timeout waiting for service."
        docker logs "${CONTAINER_NAME}"
        exit 1
    fi
    sleep 1
    COUNT=$((COUNT+1))
done
echo "Service is up!"

echo "Testing health endpoint..."
curl -sf http://localhost:${TEST_PORT}/health || { echo "Health check failed"; exit 1; }

echo "Testing models endpoint..."
MODELS_JSON=$(curl -sf -H "Authorization: Bearer test-key" http://localhost:${TEST_PORT}/v1/models)
echo "$MODELS_JSON" | grep -q "opencode" || { echo "Models check failed"; exit 1; }
MODEL_ID=$(python3 -c 'import json,sys; data=json.load(sys.stdin); print(data["data"][0]["id"])' <<< "$MODELS_JSON")

echo "Testing chat completion (non-streaming) with ${MODEL_ID}..."
curl -sf -X POST http://localhost:${TEST_PORT}/v1/chat/completions \
    -H "Authorization: Bearer test-key" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}]}" | grep -q "chat.completion" || { echo "Chat completion failed"; exit 1; }

echo "Testing health details endpoint..."
curl -sf -H "Authorization: Bearer test-key" http://localhost:${TEST_PORT}/health/details > /dev/null || { echo "/health/details check failed"; exit 1; }

echo "Testing Case 1: Full allowlist match"
curl -sf -X POST http://localhost:${TEST_PORT}/v1/chat/completions \
    -H "Authorization: Bearer test-key" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"Use web_fetch\"}]}" > /dev/null
METRICS_JSON=$(curl -sf -H "Authorization: Bearer test-key" http://localhost:${TEST_PORT}/health/details)
ALLOWLIST_REQS=$(python3 -c 'import json,sys; data=json.load(sys.stdin); print(data["internal_tools"]["metrics"]["internalAllowlistRequests"])' <<< "$METRICS_JSON")
if [ "$ALLOWLIST_REQS" -lt 1 ]; then
    echo "Case 1 failed: internalAllowlistRequests did not increment. Metrics: $METRICS_JSON"
    exit 1
fi

echo "Testing Case 2: External tools priority"
curl -sf -X POST http://localhost:${TEST_PORT}/v1/chat/completions \
    -H "Authorization: Bearer test-key" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"Use external tool\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"test_tool\",\"description\":\"desc\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}}]}" > /dev/null
METRICS_JSON=$(curl -sf -H "Authorization: Bearer test-key" http://localhost:${TEST_PORT}/health/details)
BRIDGE_REQS=$(python3 -c 'import json,sys; data=json.load(sys.stdin); print(data["internal_tools"]["metrics"]["externalBridgeRequests"])' <<< "$METRICS_JSON")
if [ "$BRIDGE_REQS" -lt 1 ]; then
    echo "Case 2 failed: externalBridgeRequests did not increment. Metrics: $METRICS_JSON"
    exit 1
fi

echo "Testing Case 3: Partial match"
curl -sf -X POST http://localhost:${TEST_PORT}/v1/chat/completions \
    -H "Authorization: Bearer test-key" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"Use unconfigured tool\"}],\"opencode\":{\"internal_allowed_tools\":[\"filesystem\",\"unconfigured_tool\"]}}" > /dev/null
METRICS_JSON=$(curl -sf -H "Authorization: Bearer test-key" http://localhost:${TEST_PORT}/health/details)
ALLOWLIST_REQS=$(python3 -c 'import json,sys; data=json.load(sys.stdin); print(data["internal_tools"]["metrics"]["internalAllowlistRequests"])' <<< "$METRICS_JSON")
if [ "$ALLOWLIST_REQS" -lt 2 ]; then
    echo "Case 3 failed: internalAllowlistRequests did not increment. Metrics: $METRICS_JSON"
    exit 1
fi

echo "Testing Case 4: No match / Disabled"
curl -sf -X POST http://localhost:${TEST_PORT}/v1/chat/completions \
    -H "Authorization: Bearer test-key" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"Use unconfigured tool\"}],\"opencode\":{\"internal_allowed_tools\":[\"unconfigured_tool\"]}}" > /dev/null
METRICS_JSON=$(curl -sf -H "Authorization: Bearer test-key" http://localhost:${TEST_PORT}/health/details)
DISABLED_REQS=$(python3 -c 'import json,sys; data=json.load(sys.stdin); print(data["internal_tools"]["metrics"]["disabledRequests"])' <<< "$METRICS_JSON")
if [ "$DISABLED_REQS" -lt 1 ]; then
    echo "Case 4 failed: disabledRequests did not increment. Metrics: $METRICS_JSON"
    exit 1
fi

echo "--- Integration Tests Passed! ---"
