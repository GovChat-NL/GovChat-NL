# Overlays en LibreChat-overrides

GovChat-NL houdt lokale wijzigingen aan de officiële LibreChat-image apart van
de LibreChat-broncode. De Compose-override configureert de startprocedure en
mount alleen de assets of scripts die de container nodig heeft.

| Override | Bestand / instelling | Wat wordt aangepast? | Documentatie |
| --- | --- | --- | --- |
| GovChat-NL-branding | [`branding/`](../branding/) en [`BRANDING_MODE`](../.env.example:10) | Logo en favicons tijdens de containerstart. | [`BRANDING.md`](BRANDING.md) |
| Nederlandse vertalingen | [`overlay/locales/nl/translation.json`](../overlay/locales/nl/translation.json) en [`LIBRECHAT_NL_TRANSLATIONS_ENABLED`](../.env.example:11) | Alleen ingevulde Nederlandse strings; bestaande Nederlandse en Engelse fallback blijven gelden. | [`TRANSLATIONS.md`](TRANSLATIONS.md) |
| LibreChat-startscript | [`scripts/apply-branding.sh`](../scripts/apply-branding.sh) | Past de geselecteerde branding en optionele Nederlandse vertalingen toe vóór het image-commando. | [`BRANDING.md`](BRANDING.md), [`TRANSLATIONS.md`](TRANSLATIONS.md) |
| LibreChat-Compose-override | [`docker-compose.override.yml`](../docker-compose.override.yml) | Mounts scripts, branding en het Nederlandse woordenboek als read-only bestanden. | [`BRANDING.md`](BRANDING.md), [`TRANSLATIONS.md`](TRANSLATIONS.md) |

De hoofdcompose-file bevat de diensten en de vastgezette LibreChat-image; lokale
aanpassingen aan het opstarten horen in de Compose-override. Gebruik bij
expliciete `-f`-opties zowel [`docker-compose.yml`](../docker-compose.yml) als
[`docker-compose.override.yml`](../docker-compose.override.yml).
