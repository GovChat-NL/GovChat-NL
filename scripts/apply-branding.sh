#!/bin/sh

# Apply the selected branding before starting LibreChat's image-default CMD.
set -eu

mode=${BRANDING_MODE:-govchat}
govchat_dir=${BRANDING_GOVCHAT_DIR:-/opt/branding/govchat}
custom_dir=${BRANDING_CUSTOM_DIR:-/opt/branding/custom}
assets_dir=${BRANDING_ASSETS_DIR:-/app/client/dist/assets}
supported_files='logo.svg favicon-32x32.png favicon-16x16.png apple-touch-icon-180x180.png'

fail() {
  printf 'Branding: ERROR: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'Branding: waarschuwing: %s\n' "$*" >&2
}

copy_present_files() {
  source_dir=$1
  label=$2

  for filename in $supported_files; do
    source_file="$source_dir/$filename"

    if [ -d "$source_file" ] || [ ! -f "$source_file" ]; then
      warn "$label-bestand ontbreekt of is geen gewoon bestand; overgeslagen: $filename"
      continue
    fi

    if [ ! -s "$source_file" ]; then
      warn "$label-bestand is leeg; overgeslagen: $filename"
      continue
    fi

    if ! cp -f "$source_file" "$assets_dir/$filename"; then
      fail "kopiëren mislukt: $source_file naar $assets_dir/$filename"
    fi

    if [ "$label" = 'Custom' ]; then
      printf 'Branding: custom-bestand overschreven: %s\n' "$filename"
    fi
  done
}

case "$mode" in
  librechat)
    printf 'Branding: Originele LibreChat branding actief\n'
    ;;
  govchat|custom)
    [ -d "$assets_dir" ] || fail "LibreChat-assetsmap bestaat niet: $assets_dir"
    [ -w "$assets_dir" ] || fail "geen schrijfrechten voor LibreChat-assetsmap: $assets_dir"

    if [ "$mode" = 'govchat' ]; then
      copy_present_files "$govchat_dir" 'GovChat-NL'
      printf 'Branding: GovChat-NL branding toegepast\n'
    else
      copy_present_files "$govchat_dir" 'GovChat-NL-basis'
      copy_present_files "$custom_dir" 'Custom'
      printf 'Branding: custom-branding toegepast\n'
    fi
    ;;
  *)
    fail "ongeldige BRANDING_MODE '$mode'; toegestaan: govchat, custom, librechat"
    ;;
esac

# With no arguments, retain the current official LibreChat image CMD.
if [ "$#" -eq 0 ]; then
  set -- npm run backend
fi

exec "$@"
