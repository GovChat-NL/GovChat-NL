#!/bin/sh

set -eu
export GOVCHAT_MINIMAL_UI_SCRIPT="$(dirname "$0")/../../scripts/apply-minimal-ui.js"
export BRANDING_METADATA_SCRIPT="$(dirname "$0")/../../scripts/apply-branding-metadata.js"

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
wrapper="$repo_root/scripts/apply-branding.sh"
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/govchat-branding-tests.XXXXXX")
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM

govchat="$temporary_root/govchat"
custom="$temporary_root/custom"
assets="$temporary_root/assets"
mkdir -p "$govchat" "$custom" "$assets"
printf '<html><head><title>LibreChat</title></head></html>' > "$temporary_root/index.html"
printf '{"name":"LibreChat","short_name":"LibreChat","icons":[]}' > "$temporary_root/manifest.webmanifest"

export BRANDING_GOVCHAT_DIR="$govchat"
export BRANDING_CUSTOM_DIR="$custom"
export BRANDING_ASSETS_DIR="$assets"
export LIBRECHAT_NL_TRANSLATIONS_ENABLED=false
export LIBRECHAT_NL_TRANSLATIONS_SCRIPT="$repo_root/scripts/apply-dutch-translations.js"
export LIBRECHAT_NL_TRANSLATIONS_BACKUP_DIR="$temporary_root/translation-backup"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_file_content() {
  [ "$(cat "$1")" = "$2" ] || fail "onverwachte inhoud in $1"
}

assert_log_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "log bevat niet '$2': $1" ;;
  esac
}

supported_files='logo.svg favicon-32x32.png favicon-16x16.png apple-touch-icon-180x180.png icon-192x192.png maskable-icon.png'
for filename in $supported_files; do
  printf 'govchat:%s\n' "$filename" > "$govchat/$filename"
  printf 'librechat:%s\n' "$filename" > "$assets/$filename"
done

# Empty mode defaults to govchat and applies every available bundled asset.
log=$(BRANDING_MODE= "$wrapper" sh -c 'printf "started:%s\n" "$*"' branding-test backend --flag)
assert_log_contains "$log" 'Branding: GovChat-NL branding toegepast'
assert_log_contains "$log" 'started:backend --flag'
for filename in $supported_files; do
  assert_file_content "$assets/$filename" "govchat:$filename"
done

# An unset mode defaults to govchat too, and the official CMD is the fallback.
unset BRANDING_MODE
mkdir "$temporary_root/default-bin"
cat > "$temporary_root/default-bin/npm" <<'EOF'
#!/bin/sh
printf 'default:%s\n' "$*"
EOF
chmod +x "$temporary_root/default-bin/npm"
log=$(PATH="$temporary_root/default-bin:$PATH" "$wrapper")
assert_log_contains "$log" 'Branding: GovChat-NL branding toegepast'
assert_log_contains "$log" 'default:run backend'

# Custom mode starts from the GovChat defaults and replaces only supplied files.
printf 'custom-logo\n' > "$custom/logo.svg"
printf 'custom-favicon\n' > "$custom/favicon-16x16.png"
log=$(BRANDING_MODE=custom "$wrapper" true)
assert_log_contains "$log" 'custom-bestand overschreven: logo.svg'
assert_log_contains "$log" 'custom-bestand overschreven: favicon-16x16.png'
assert_file_content "$assets/logo.svg" 'custom-logo'
assert_file_content "$assets/favicon-16x16.png" 'custom-favicon'
assert_file_content "$assets/favicon-32x32.png" 'govchat:favicon-32x32.png'
assert_file_content "$assets/apple-touch-icon-180x180.png" 'govchat:apple-touch-icon-180x180.png'
assert_file_content "$assets/icon-192x192.png" 'govchat:icon-192x192.png'
assert_file_content "$assets/maskable-icon.png" 'govchat:maskable-icon.png'

# Supplying all supported custom assets replaces the complete default set.
for filename in $supported_files; do
  printf 'full-custom:%s\n' "$filename" > "$custom/$filename"
done
log=$(BRANDING_MODE=custom "$wrapper" true)
for filename in $supported_files; do
  assert_file_content "$assets/$filename" "full-custom:$filename"
done

# Missing/empty/directory custom entries are skipped and preserve the base.
rm "$custom/favicon-16x16.png"
: > "$custom/favicon-32x32.png"
rm "$custom/apple-touch-icon-180x180.png"
mkdir "$custom/apple-touch-icon-180x180.png"
log=$(BRANDING_MODE=custom "$wrapper" true 2>&1)
assert_log_contains "$log" 'is leeg; overgeslagen: favicon-32x32.png'
assert_log_contains "$log" 'ontbreekt of is geen gewoon bestand; overgeslagen: apple-touch-icon-180x180.png'
assert_file_content "$assets/favicon-32x32.png" 'govchat:favicon-32x32.png'

# A missing GovChat source is skipped without preventing other files applying.
rm "$govchat/favicon-16x16.png"
log=$(BRANDING_MODE=govchat "$wrapper" true 2>&1)
assert_log_contains "$log" 'ontbreekt of is geen gewoon bestand; overgeslagen: favicon-16x16.png'
assert_file_content "$assets/logo.svg" 'govchat:logo.svg'

# LibreChat mode must leave all original assets untouched.
for filename in $supported_files; do
  printf 'original:%s\n' "$filename" > "$assets/$filename"
done
log=$(BRANDING_MODE=librechat "$wrapper" sh -c 'printf "original-cmd:%s\n" "$1"' branding-test npm-run-backend)
assert_log_contains "$log" 'Branding: Originele LibreChat branding actief'
assert_log_contains "$log" 'original-cmd:npm-run-backend'
for filename in $supported_files; do
  assert_file_content "$assets/$filename" "original:$filename"
done

# Invalid modes fail clearly and never start the application command.
if log=$(BRANDING_MODE=unknown "$wrapper" true 2>&1); then
  fail 'ongeldige BRANDING_MODE werd geaccepteerd'
fi
assert_log_contains "$log" "ongeldige BRANDING_MODE 'unknown'"

# Missing target assets and copy errors are fatal.
if log=$(BRANDING_MODE=govchat BRANDING_ASSETS_DIR="$temporary_root/missing-assets" "$wrapper" true 2>&1); then
  fail 'ontbrekende LibreChat-assetsmap werd geaccepteerd'
fi
assert_log_contains "$log" 'LibreChat-assetsmap bestaat niet'

mkdir "$temporary_root/failing-bin"
cat > "$temporary_root/failing-bin/cp" <<'EOF'
#!/bin/sh
exit 42
EOF
chmod +x "$temporary_root/failing-bin/cp"
if log=$(PATH="$temporary_root/failing-bin:$PATH" BRANDING_MODE=govchat "$wrapper" true 2>&1); then
  fail 'kopieerfout werd niet fataal behandeld'
fi
assert_log_contains "$log" 'kopiëren mislukt'

# The wrapper returns the application process exit status unchanged.
if BRANDING_MODE=librechat "$wrapper" sh -c 'exit 23'; then
  fail 'application exit status was not propagated'
else
  status=$?
  [ "$status" -eq 23 ] || fail "application exit status changed: $status"
fi

printf 'PASS: branding modes, fallbacks, fouten en image-CMD doorgifte\n'
