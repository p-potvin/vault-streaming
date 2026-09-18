#!/usr/bin/env bash
set -euo pipefail

# Package unsigned VaultStreaming.app into an IPA archive.
# Usage: ./package-unsigned-ipa.sh [build_dir] [output_ipa]

BUILD_DIR="${1:-build/Release-iphoneos}"
OUTPUT_IPA="${2:-build/VaultStreaming-unsigned.ipa}"

APP_PATH="${BUILD_DIR}/VaultStreaming.app"

if [ ! -d "${APP_PATH}" ]; then
  echo "Error: ${APP_PATH} not found. Run xcodebuild first."
  exit 1
fi

PAYLOAD_DIR="$(mktemp -d)/Payload"
mkdir -p "${PAYLOAD_DIR}"

echo "Copying ${APP_PATH} into Payload..."
cp -R "${APP_PATH}" "${PAYLOAD_DIR}/"

OUTPUT_DIR="$(dirname "${OUTPUT_IPA}")"
mkdir -p "${OUTPUT_DIR}"

echo "Creating unsigned IPA archive at ${OUTPUT_IPA}..."
(cd "$(dirname "${PAYLOAD_DIR}")" && zip -qr -9 "${OUTPUT_IPA}" Payload)

rm -rf "$(dirname "${PAYLOAD_DIR}")"

echo "Successfully packaged: ${OUTPUT_IPA}"
