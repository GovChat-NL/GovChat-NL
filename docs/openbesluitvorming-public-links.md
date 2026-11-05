# Openbesluitvorming: openbare Limburg-documentlinks

De Limburg-bron levert download-URL's via iBabs. De zoekworkflow en documentworker
zetten die voor geldige Limburg-document-ID's om naar de officiële provinciale
viewer: `Agenda/Document` voor vergaderstukken, `Reports/Document` voor moties en
`Document/View` als alleen organisatiecontext beschikbaar is. Die laatste route
is een directe document/PDF-fallback, geen verzonnen agenda of rapport.

`public_url` en `original_url` verwijzen naar de openbare viewer; de oorspronkelijke
downloadverwijzing blijft bewaard als `original_download_url` en de ingeste bron
blijft intact in `source_payload`. Andere bronnen en ongeldige ID's worden niet
herschreven. Expliciete geldige agenda-/rapportviewerlinks blijven behouden.

De zelfvoorzienende helper staat in `scripts/openbesluitvorming-public-links.js`.
Na wijzigingen kun je beide workflowexports opnieuw genereren met Node.js 22+:

```sh
node scripts/openbesluitvorming-public-links.js --render-workflows agents/n8n/workflows
node --test tests/agents/openbesluitvorming-public-links.test.js
```

Importeer gewijzigde exports volgens je normale n8n-deploymentprocedure. De
zoekworkflow ondersteunt ook bestaande, nog niet gemigreerde Qdrant-payloads;
een databackfill is daarom niet nodig om nieuwe zoekresultaten te corrigeren.

## Optionele backfill

Gebruik alleen je eigen Qdrant-service, kies expliciet de juiste collectie en
bekijk eerst de dry-run. De voorbeeldnamen hieronder zijn geen productieadvies:

```sh
export QDRANT_URL='http://localhost:6333'
export QDRANT_COLLECTION='your_collection'
node scripts/openbesluitvorming-public-links.js --backfill
node scripts/openbesluitvorming-public-links.js --backfill --apply --backup /secure/private/limburg-links-before.jsonl
```

Voor een beveiligde Qdrant-service kun je `QDRANT_API_KEY` via de omgeving
doorgeven. Gebruik een bereikbare interne URL of lokale tunnel, niet een
onbeveiligde publieke beheerpoort. Zonder `--apply` worden alleen punten gelezen
en tellingen getoond. Toepassen vereist een expliciete collectie en een nieuw
backupbestand; een bestaand bestand wordt nooit overschreven. De backup heeft
modus 0600 en wordt vóór elke batch duurzaam weggeschreven. Iedere regel bevat
het punt-ID, eerdere veldwaarden en de namen van voorheen ontbrekende velden.
Een rollback moet die eerdere waarden terugzetten én die ontbrekende velden
verwijderen; doe dit alleen na controle op eventuele latere wijzigingen.

Backups bevatten bronmetadata: bewaar ze buiten Git en buiten publiek geserveerde
mappen. Het script verandert geen vectoren of overige payloadvelden. Een fout
kan een gedeeltelijk toegepaste migratie opleveren; gebruik de backup bij herstel.
