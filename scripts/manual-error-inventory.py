#!/usr/bin/env python3
"""Source-backed error catalog and change detector. --update is an explicit review action.

Default checks complete catalog coverage independently of visibility. --upstream supplies
an offline tree of the exact release pinned in Compose; no user logs are ever read.
"""
import argparse
import ast
import hashlib
import html
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INVENTORY = ROOT / 'docs/manual-error-inventory.json'
PIN = 'v0.8.8'
SHA = 'e8f3be08623663d4ad7f7241e693c94469b63bb0'
SIGNAL = re.compile(r'error|fail|invalid|denied|banned|exceed|too_large|too_many|unsupported|not_found|unavailable|timeout|expired|refusal|moderation|quota|rate_limit|empty_messages|unauthorized', re.I)
CATEGORIES = {
    'chat-errors': 'Chat, model en context', 'session-errors': 'Aanmelden, sessie en rechten',
    'document-errors': 'Upload, extractie en bestandsbeheer', 'prompt-errors': 'Promptbibliotheek',
    'network-errors': 'Netwerk, proxy en services', 'tool-errors': 'Apps en agenttools',
    'manual-errors': 'Handleiding en bronverwijzingen',
}
# Meaning / safe steps / administrator investigation. First matching rule wins.
RULES = [
    (r'content.?filter|content.?policy|moderation|refusal', 'Een veiligheidscontrole of het model heeft de vraag of het antwoord geweigerd. De melding is geen bewijs dat je verkeerd hebt gehandeld.', 'Controleer of de legitieme taak duidelijk en toegestaan is. Vraag bij een onverwachte blokkade om beoordeling; verberg verboden inhoud niet en probeer filters niet te omzeilen.', 'Beoordeel de concrete foutcode en het geldende beleid; een gewone BadRequest is niet automatisch een contentfilterblokkade.'),
    (r'bad.?request|invalid_request|invalid_action|query_options|multipart|empty_messages', 'De aanvraag voldoet niet aan het verwachte invoercontract. Dat kan een ongeldige combinatie, ontbrekend veld of verwerkingsprobleem zijn; het is niet automatisch een veiligheidsfilter.', 'Controleer de zichtbare invoer en de gekozen actie. Probeer één gewone toegestane opdracht als dat veilig kan. Meld een aanhoudend probleem zonder gevoelige aanvraaginhoud te delen.', 'Controleer endpointcontract, configuratie, toegestane acties en de specifieke upstreamcode.'),
    (r'input.?length|context|tokens|compaction|output_limit|text_limit|response_limit|too_long', 'De beschikbare context- of tekstgrens is bereikt, of het verkleinen van de context is mislukt. Eerdere berichten en bijlagen kunnen samen de grens overschrijden.', 'Beperk de vraag tot de noodzakelijke passages of start een nieuw gesprek met een korte relevante samenvatting. Controleer of de bron nog voldoende volledig is; verander geen serverlimieten.', 'Vergelijk modelcontext, documentlimieten en eventuele samenvattingsinstellingen; verhoog niet blind de grens.'),
    (r'quota|balance|credit|payment|billing', 'Een gebruiks-, tegoed- of leveranciersquotum verhindert de aanvraag. Dit zegt niets over de inhoudelijke kwaliteit van je vraag.', 'Wacht op herstel of neem contact op met de helpdesk. Gebruikers hoeven geen betaalgegevens of API-sleutels te wijzigen.', 'Controleer de juiste provider/deployment, quota, gebruikslimieten en geldigheid van de servercredentials.'),
    (r'rate.?limit|too_many|extractor_busy|limit_reached', 'Er zijn tijdelijk te veel aanvragen of een ingestelde gebruikslimiet is bereikt. De limiet kan bij gebruiker, service of leverancier gelden.', 'Wacht de aangegeven termijn af. Voorkom meerdere gelijktijdige pogingen en meld aanhoudende blokkades met tijdstip en code.', 'Controleer de betrokken limiter en capaciteit; verlaag beveiliging of begrenzing niet om de fout te verbergen.'),
    (r'auth|login|sso|openid|oauth|session|token|unauthorized|cross.?origin|forbidden|permission|access|banned|denied', 'De aanmelding, sessie of toestemming is niet geaccepteerd. Een verlopen sessie is een andere oorzaak dan ontbrekende rechten of een bewuste blokkade.', 'Gebruik de officiële aanmeldroute. Stop bij herhaald mislukken en meld de niet-gevoelige foutcode. Deel nooit cookies, wachtwoorden of toegangstokens en omzeil geen organisatieaanmelding.', 'Controleer huidige gebruiker, rechten, sessiebeleid, SSO-callback en origin/proxyconfiguratie. Gebruik geen onbeveiligde alternatieve route.'),
    (r'api.?key|user_key|service_key|base_url|no_system|model.*(missing|found)|missing_model|models_not_loaded|illegal_model|invalid_agent_provider|google_tool_conflict', 'De ingestelde model- of toolverbinding is niet bruikbaar, of een configuratiecombinatie wordt niet ondersteund.', 'Gebruik alleen aangeboden en toegestane keuzes. Meld de fout als je geen passende keuze hebt; wijzig geen servercredentials en plaats geen sleutel in de chat.', 'Controleer modeltoegang, endpointinstellingen, vereiste credentials en ondersteuning voor systeemmeldingen/toolcombinaties.'),
    (r'encrypt|password.*document', 'Het document is versleuteld of beveiligd en kan in deze route niet worden uitgelezen.', 'Vraag de documenteigenaar om een leesbare versie die volgens beleid mag worden verwerkt. Verwijder beveiliging niet zonder toestemming.', 'Controleer of het documenttype en de beveiligde variant bewust worden ondersteund.'),
    (r'macros_unsupported|unsafe_archive|archive_ratio|archive_expansion|unsafe_xml|signature_mismatch|mime.*mismatch|binary_text|unsafe_sheet|invalid_relationship', 'De veiligheids- of formaatcontrole van het bestand is niet geslaagd. Een extensie kan afwijken van de inhoud of de interne structuur kan onveilig of niet ondersteund zijn.', 'Gebruik een betrouwbare originele versie of vraag de eigenaar om een goedgekeurde export. Hernoem alleen de extensie niet en probeer bestandsbeveiligingen niet te omzeilen. Macro’s worden niet uitgevoerd.', 'Onderzoek alleen in de veilige verwerkingsomgeving de specifieke validatorcode en het originele formaat; voer macro’s of externe koppelingen niet uit.'),
    (r'upload_limit|file.*(size|large)|page_limit|sheet_limit|archive_entries|upload.*limit|extracted.*limit|worker.*limit|memory', 'Een ingestelde grens voor upload, documentstructuur of verwerkingsresources is bereikt.', 'Controleer de effectieve uploadgrenzen. Vraag om een noodzakelijke kleinere selectie of toegestane export met voldoende context. Meld herhaald falen; wijzig geen servicegrenzen.', 'Controleer de afzonderlijke proxy-, upload-, parser- en resourcegrenzen en de benodigde capaciteit.'),
    (r'invalid_(workbook|worksheet|cell|shared|boolean|xml|email)|missing_archive|unsupported_cell|invalid_filename|unsupported_format|invalid_document|unreadable|empty_spreadsheet|empty_or_invalid|invalid_text_encoding|invalid_tika|tika_partial|pdf_page', 'De documentinhoud of structuur is niet goed leesbaar in deze verwerkingsroute. Uitgelezen tekst kan ontbreken of onvolledig zijn.', 'Open en controleer het oorspronkelijke bestand. Vraag de eigenaar om een correcte leesbare export. Bij scans controleer je OCR en paginavolgorde; vraag geen zekere conclusie over ontbrekende passages.', 'Controleer parserroute, validatiecode, OCR en volledige extractie zonder ongecontroleerde fallback op gedeeltelijke tekst.'),
    (r'file.*(delete|remove)|delete.*file', 'Het opgeslagen bestand kon niet via deze actie worden verwijderd. Een mislukt verzoek is geen bevestiging van verwijdering.', 'Controleer de bestandsnaam en het overzicht. Probeer de aangeboden actie nogmaals als dat veilig kan en meld een aanhoudend probleem. Een bijlage uit het invoerveld losmaken is iets anders.', 'Controleer eigenaarschap, verwijderrechten en bestandsopslag; bevestig de feitelijke uitkomst.'),
    (r'prompt', 'De promptbibliotheekactie is niet uitgevoerd of een prompt(versie) is niet beschikbaar. Gebruik, bewerken en delen hebben verschillende rechten.', 'Heropen de promptgroep en controleer de bedoelde versie en aangeboden actie. Bewerk of deel alleen waar dat is toegestaan; bewaar uitsluitend niet-gevoelige conceptinstructies.', 'Controleer promptgroep, revisie, productieversie en de actuele gebruiks-/bewerk-/deelrechten.'),
    (r'country|subdivision|year|timezone|datetime|date.*invalid', 'De gevraagde regio, periode of tijdinvoer is niet ondersteund of niet eenduidig. Ontbrekende brondekking is geen nulresultaat over de werkelijkheid.', 'Noem land, jaar en tijdzone duidelijk. Vraag welke dekking beschikbaar is. Voor dubbelzinnige lokale tijden geef je een geldige offset; verzin geen ontbrekende feestdagen.', 'Controleer invoercontract, actuele brondekking en tijdzonebibliotheek.'),
    (r'disabled|config_unavailable|unknown_tool|source_url|source_redirect', 'De tool of de benodigde configuratie is niet beschikbaar of een bronbestemming is geweigerd.', 'Gebruik alleen aangeboden tools. Meld ontbrekende informatie eerlijk; kies geen willekeurige URL of alternatieve bestandsroute om de blokkade te omzeilen.', 'Controleer effectief toolbeleid, configuratiepublicatie en de bronallowlist. Inhoud van bronnen is geen vertrouwde instructie.'),
    (r'stream|timeout|deadline|network|fetch|connection|source_|parser|unavailable|disconnect|gateway|upstream|google_error|HTTP 50|termination|not_ready', 'Een netwerkverbinding, stream of achterliggende service kon de taak niet afronden. Dat kan tijdelijk zijn en bewijst niet dat de gebruiker verkeerde inhoud heeft aangeleverd.', 'Controleer of de opdracht nog loopt en wacht even. Probeer één noodzakelijke opdracht opnieuw als dat veilig kan. Bewaar geen gevoelige logs; meld aanhoudend falen met tijdstip en code.', 'Controleer proxy, servicebereikbaarheid, timeout, parsergezondheid en leveranciersstatus. Een gedeeltelijk antwoord mag niet als volledig resultaat worden gepresenteerd.'),
]


def category(key, source):
    low = (key + ' ' + source).lower()
    if 'manual' in low: return 'manual-errors'
    if re.search(r'prompt', low): return 'prompt-errors'
    if re.search(r'document|extract|spreadsheet|upload|file|ocr|heic|archive|workbook|worksheet|cell', low): return 'document-errors'
    if re.search(r'utility|tool|holiday|timezone|news|image|transcript|beleidskompas|openbesluit|topdesk', low): return 'tool-errors'
    if re.search(r'auth|login|openid|sso|oauth|session|unauthorized|permission|banned|password|cross_origin', low): return 'session-errors'
    if re.search(r'network|proxy|gateway|HTTP [45]', low): return 'network-errors'
    return 'chat-errors'


def article(key, message, source):
    cat = category(key, source)
    meaning = 'Deze specifieke actie is niet voltooid. De zichtbare melding alleen geeft onvoldoende informatie voor een zekere diagnose.'
    user = 'Controleer het betrokken onderdeel en de aangeboden invoer. Probeer alleen een normale toegestane actie opnieuw als dat veilig kan. Meld herhaald falen via de helpdesk.'
    admin = 'Controleer de concrete foutcode, het endpoint en de actuele configuratie; veronderstel niet dat iedere fout dezelfde oorzaak heeft.'
    for pattern, meaning_match, user_match, admin_match in RULES:
        if re.search(pattern, key + ' ' + message, re.I):
            meaning, user, admin = meaning_match, user_match, admin_match
            break
    id = 'err-' + re.sub(r'[^a-z0-9_-]', '-', key.lower())[:65]
    # Colliding codes from different surfaces are merged deliberately by the caller.
    p = lambda t: '<p>' + html.escape(t) + '</p>'
    content = p('Herkenbare melding/code: ' + (message or key)) + '<h3>Betekenis</h3>' + p(meaning)
    content += '<h3>Wat kun je doen?</h3>' + p(user)
    content += '<h3>Wanneer hulp vragen?</h3>' + p('Bij aanhoudend falen, onduidelijke rechten of een mogelijk informatie-incident volg je de afgesproken helpdesk- of incidentroute. Vermeld tijdstip en tijdzone, onderdeel, code en een korte niet-gevoelige beschrijving. Geen volledige chat, documenten, wachtwoorden, cookies of tokens meesturen.')
    content += '<h3>Alleen voor beheerders</h3>' + p(admin)
    related = {'document-errors': ['document-upload', 'document-kwaliteit'], 'prompt-errors': ['prompt-vinden', 'prompt-versies'], 'session-errors': ['probleem-sessie'], 'network-errors': ['probleem-netwerk']}.get(cat, ['probleem-algemeen'])
    requires, rights = [], []
    if cat == 'document-errors': requires = ['upload']
    if cat == 'prompt-errors': requires, rights = ['prompts'], ['prompts.use']
    if 'holidays' in source: requires = ['holidays']
    if 'utility-time' in source: requires = ['time']
    title = message if source.endswith('translation.json') else CATEGORIES[cat] + ': ' + key
    return cat, dict(id=id, title=title[:180], content=content, items=[], aliases=[], codes=[key], messages=[message] if message else [], requires=requires, rights=rights, related=related + ['ondersteuning'])


def repo_sources():
    explicit = ['overlay/locales/nl/translation.json', 'services/document-extractor/validation-errors.json']
    result = set(explicit)
    # Explicit source roots work in sanitized regression snapshots without Git metadata.
    # Never discover runtime/export/secret directories or local deployment overrides.
    for folder, pattern in [('services/document-extractor', '*.py'), ('services/admin-overlay/admin/lib', '*.js'), ('overlay/src/apps', '*.js'), ('nginx', '*.conf')]:
        for p in (ROOT / folder).rglob(pattern):
            if '.local.' not in p.name: result.add(str(p.relative_to(ROOT)))
    for p in (ROOT / 'scripts').glob('*.js'):
        if p.name.startswith(('librechat-', 'n8n-')): result.add(str(p.relative_to(ROOT)))
    result.add('services/admin-overlay/admin/server.js')
    return sorted(result)


def upstream_sources(tree):
    sources = ['packages/data-provider/src/config.ts']
    for prefix in ['client/src/components/Messages/Content/Error', 'client/src/components/Prompts', 'client/src/components/Files', 'api/server/routes/prompts', 'api/server/routes/files', 'api/server/middleware', 'api/server/controllers/Ask', 'api/server/services/Endpoints', 'api/strategies']:
        folder = tree / prefix
        for p in folder.rglob('*') if folder.exists() else []:
            if p.suffix in {'.js', '.ts', '.tsx'} and not any(x in p.name for x in ['test', 'spec']) and '__tests__' not in p.parts:
                sources.append(str(p.relative_to(tree)))
    for name in ['api/server/routes/auth.js', 'api/server/routes/prompts.js', 'api/server/controllers/PromptController.js', 'api/server/controllers/AuthController.js', 'api/server/routes/oauth.js']:
        if (tree / name).exists(): sources.append(name)
    for name in ['api/app/clients/BaseClient.js', 'packages/api/src/utils/errors.ts', 'packages/api/src/files/upload/errors.ts', 'packages/api/src/auth/openid/errors.ts', 'packages/api/src/middleware/error.ts', 'packages/api/src/endpoints/google/errors.ts', 'packages/api/src/agents/errors.ts']:
        if (tree / name).exists(): sources.append(name)
    return sorted(set(sources))


def extract(path, text):
    entries = []
    if path.endswith('translation.json'):
        data = json.loads(text)
        for key, message in data.items():
            if SIGNAL.search(key): entries.append((key, message, text[:text.find('"' + key + '"')].count('\n') + 1))
    elif path.endswith('validation-errors.json'):
        entries = [(code, '', index + 2) for index, code in enumerate(json.loads(text))]
    else:
        if path.endswith('document-extractor/app.py'):
            # Some reachable parser/worker failures flow through a variable, not a literal
            # HTTPException call. The owned rejection allowlist is the complete contract.
            for node in ast.walk(ast.parse(text)):
                if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'REJECTION_CODES' for t in node.targets):
                    for item in ast.walk(node.value):
                        if isinstance(item, ast.Constant) and isinstance(item.value, str): entries.append((item.value, '', item.lineno))
        for index, line in enumerate(text.splitlines(), 1):
            # Literal error codes and thrown/reachable user-facing messages. Dynamic text gets
            # explicit fallback coverage; no evaluation of provider data or runtime logging.
            if path.endswith('config.ts'):
                if re.search(r'^export enum ErrorTypes', line): pass
            if re.search(r'HTTPException|new (?:ToolError|ManualError)|error(?:Code|_code|code)?\s*[:=]|\.code\s*=|(?:fail|error|invalid)\(|throw new Error|\.status\([45]\d\d\)|ErrorTypes\.', line) and not re.search(r'logger\.|console\.(?:warn|error|log)', line):
                # Match the SAME delimiter, including embedded apostrophes in double quotes;
                # otherwise adjacent literals accidentally inventory JS fragments as messages.
                pattern = r'"((?:\\.|[^"\\\n]){2,300})"|\'((?:\\.|[^\'\\\n]){2,300})\'|`([^`\n]{2,300})`'
                literals = [next(x for x in match.groups() if x is not None) for match in re.finditer(pattern, line)]
                for value in literals:
                    if value in {'string', 'object', 'error', 'utf8', 'json', 'application/json'} or '/' in value and not SIGNAL.search(value): continue
                    if SIGNAL.search(value) or re.match(r'^[A-Z_]{3,}$', value) or 'HTTPException' in line: entries.append((value, value if ' ' in value else '', index))
            if path.endswith('config.ts'):
                match = re.match(r"\s*([A-Z_]+) = '([^']+)'", line)
                # Restrict enum extraction to the ErrorTypes block below.
                if match and text.find('export enum ErrorTypes') <= sum(len(x)+1 for x in text.splitlines()[:index-1]) < text.find('\n}', text.find('export enum ErrorTypes')):
                    entries.append((match[2], '', index))
    return entries


def collect(tree=None, previous=None):
    artifacts, catalog, lookup = [], {k: [] for k in CATEGORIES}, {}
    lists = [('repo', ROOT, repo_sources())]
    if tree: lists.append(('upstream', tree, upstream_sources(tree)))
    # Concrete symbol/translation callsites establish that keys are more than a locale list.
    # Keep all references in the pinned source, but never include source text or user logs.
    references = {}
    if tree:
        enum_text = (tree / 'packages/data-provider/src/config.ts').read_text()
        enum_block = enum_text.split('export enum ErrorTypes {', 1)[1].split('\n}', 1)[0]
        enum_names = dict(re.findall(r"([A-Z_]+) = '([^']+)'", enum_block))
        for prefix in ['api', 'packages/api/src', 'client/src']:
            for p in (tree / prefix).rglob('*'):
                if p.suffix not in {'.js', '.ts', '.tsx'} or any(x in p.name for x in ['test', 'spec']) or '__tests__' in p.parts: continue
                for line, text in enumerate(p.read_text().splitlines(), 1):
                    for symbol in re.findall(r'ErrorTypes\.([A-Z_]+)', text):
                        if symbol in enum_names: references.setdefault(enum_names[symbol], []).append(dict(path=str(p.relative_to(tree)), line=line))
                    for key in re.findall(r'["\'](com_[a-z0-9_]+)["\']', text):
                        if SIGNAL.search(key): references.setdefault(key, []).append(dict(path=str(p.relative_to(tree)), line=line))
    for origin, root, paths in lists:
        for path in paths:
            text = (root / path).read_text()
            entries = extract(path, text)
            # Preserve a fingerprint even for source files with only dynamic errors.
            artifact = dict(origin=origin, path=path, sha256=hashlib.sha256(text.encode()).hexdigest(), entries=[])
            if not entries:
                artifact['exclusion'] = 'Geen letterlijk gebruikersfouttype in deze bron; dynamische provider-/exceptiontekst valt onder probleem-algemeen. Tests en logging zijn geen catalogusinhoud.'
            for key, message, line in entries:
                if '${' in key:
                    artifact['entries'].append(dict(code=key, message='', line=line, article='err-unknown_provider_error', exclusion='Dynamische exception-/provider-/SSO-tekst: geen vaste foutcode en geen betrouwbare tekstmatching. Gebruik probleem-algemeen; ErrorTypes-symbolen worden daarnaast als vaste enum geïnventariseerd.', relevance='Fallback zonder diagnose.'))
                    continue
                cat, item = article(key, message, path)
                # Text aliases with parameter placeholders are displayed, never substring-matched
                # against arbitrary chat text by the frontend.
                existing = lookup.get(item['id'])
                if existing and key not in existing['codes']:
                    item['id'] += '-' + hashlib.sha256(key.encode()).hexdigest()[:8]
                    existing = lookup.get(item['id'])
                if not existing:
                    lookup[item['id']] = item; catalog[cat].append(item)
                elif message and message not in existing['messages']:
                    existing['messages'].append(message)
                artifact['entries'].append(dict(code=key, message=message, line=line, article=item['id'], reachableAt=references.get(key, [])[:20], relevance='Letterlijke foutmelding/code of vertaalalias; bereikbaarheid afhankelijk van effectieve functie en rechten. Geen callsite gevonden betekent dat dit conservatieve catalogusdekking is, geen bevestiging van actieve bereikbaarheid.'))
            artifacts.append(artifact)
    if not tree and previous:
        artifacts.extend(a for a in previous['artifacts'] if a['origin'] == 'upstream')
        for cat in previous['catalog']:
            for item in cat['articles']:
                if item['id'] not in lookup: lookup[item['id']] = item; catalog[cat['id']].append(item)
    # Proxy status types and dynamic SSO/provider failures do not always have literal enums.
    synthetic = ['HTTP 400', 'HTTP 401', 'HTTP 403', 'HTTP 404', 'HTTP 408', 'HTTP 411', 'HTTP 413', 'HTTP 415', 'HTTP 422', 'HTTP 429', 'HTTP 500', 'HTTP 502', 'HTTP 503', 'HTTP 504', 'SSO_CALLBACK_FAILED', 'NETWORK_CONNECTION_FAILED', 'UNKNOWN_PROVIDER_ERROR']
    entries = []
    for code in synthetic:
        cat, item = article(code, '', 'proxy/network/SSO')
        if item['id'] not in lookup: catalog[cat].append(item); lookup[item['id']] = item
        entries.append(dict(code=code, message='', line=0, article=item['id'], relevance='Expliciete transport-/SSO-/providerfallback; code alleen is geen zekere diagnose.'))
    artifacts.append(dict(origin='contract', path='HTTP/SSO/provider fallback', entries=entries, exclusion='Arbitraire providertekst en persoonlijke logs worden niet geïnventariseerd; de algemene fallback geeft geen verzonnen diagnose.'))
    return dict(schemaVersion=1, upstream=dict(tag=PIN, commit=SHA), artifacts=artifacts,
                catalog=[dict(id=k, title=CATEGORIES[k], articles=sorted(v, key=lambda x: x['id'])) for k, v in catalog.items()])


def check(tree):
    baseline = json.loads(INVENTORY.read_text())
    current = collect(tree, baseline)
    expected = {(a['origin'], a['path']): a.get('sha256') for a in baseline['artifacts'] if a['origin'] != 'contract'}
    actual = {(a['origin'], a['path']): a.get('sha256') for a in current['artifacts'] if a['origin'] != 'contract'}
    changed = sorted(k for k in expected.keys() | actual.keys() if expected.get(k) != actual.get(k))
    if changed: raise SystemExit('Foutbronnen gewijzigd; expliciete catalogusreview vereist: ' + ', '.join(str(x) for x in changed))
    model = json.loads((ROOT / 'services/admin-overlay/admin/defaults/manual.json').read_text())
    articles = {a['id']: a for c in model['errorCategories'] for a in c['articles']}
    for artifact in baseline['artifacts']:
        for entry in artifact['entries']:
            if entry['article'] not in articles or not entry.get('exclusion') and entry['code'] not in articles[entry['article']]['codes']:
                raise SystemExit('Ontbrekend foutartikel: ' + entry['code'])
    print(f"Error coverage OK: {len(articles)} artikelen, {sum(len(a['entries']) for a in baseline['artifacts'])} bronvermeldingen; {len(baseline['artifacts'])} artifacts. Upstream " + ('gecontroleerd' if tree else 'gepinde snapshot; gebruik --upstream voor broncontrole'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', type=Path)
    parser.add_argument('--update', action='store_true')
    args = parser.parse_args()
    if 'registry.librechat.ai/librechat-ai/librechat:' + PIN not in (ROOT / 'docker-compose.yml').read_text(): raise SystemExit('Upstreamrelease gewijzigd: inventaris opnieuw reviewen')
    if args.update:
        old = json.loads(INVENTORY.read_text()) if INVENTORY.exists() else None
        if not args.upstream and not old: raise SystemExit('Een gepinde upstreambron is nodig voor de eerste inventaris')
        INVENTORY.write_text(json.dumps(collect(args.upstream, old), ensure_ascii=False, indent=2) + '\n')
    else: check(args.upstream)
