'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { workflowFunctionSource } = require('./workflow-function-source');

// The tool schema and subworkflow trigger share the same named parameters.
const field = (name, description, type = 'string', fallback = '') => ({ name, description, type, fallback });
const dateFields = [
  field('date_start', 'Harde begindatum, inclusief, YYYY-MM-DD. Vanaf 2020 betekent 2020-01-01. Leeg als geen begindatum is gevraagd.'),
  field('date_end', 'Harde einddatum, inclusief, YYYY-MM-DD. Leeg bij tot de beschikbare snapshot of zonder expliciete einddatum; verzin geen snapshotdatum.'),
];
const metadataFields = ['source_key', 'organization', 'supplier', 'document_type', 'meeting_id', 'referenced_by', 'classification']
  .map(name => field(name, `Exacte gekozen metadatawaarde voor ${name}; leeg als niet gekozen of onbekend. Raad geen codes of waarden.${['source_key','organization'].includes(name) ? ' Bij een vaste installatiebron is dezelfde organisatie al server-side afgebakend; voeg daarvoor geen onbekend of dubbel filter toe.' : ''}`));
const searchFields = [
  field('query', 'Inhoudelijke zoekterm of onderwerp. Datums en documenttypen horen in de aparte filtervelden, niet uitsluitend in query.', 'string', undefined),
  ...dateFields, ...metadataFields,
  field('query_variants', 'JSON-array van maximaal vier inhoudelijke zoekvarianten/schrijfwijzen voor dezelfde zoekactie. Gebruik één brede toolaanroep, niet één aanroep per variant.', 'json', []),
  field('candidate_limit', 'Maximum kandidaten per zoekvariant, 50-500.', 'number', 500),
  field('rerank_limit', 'Maximum te reranken kandidaten, 50-500.', 'number', 500),
  field('result_limit', 'Maximum resultaten, 10-100; voor een breed dossieroverzicht bij voorkeur 100.', 'number', 40),
  field('include_content', 'Geef beschikbare inhoudspassages mee wanneer nodig voor een inhoudelijk overzicht.', 'boolean', false),
];
const statisticsFields = [
  field('operation', 'Exacte statistiekbewerking: fields, count, group, status of overview.', 'string', undefined),
  field('field', 'Bekend metadata-veldpad voor group. Leeg voor andere bewerkingen.'),
  field('interval', 'Voor group op datum: year of month; anders leeg.'),
  field('filters', 'JSON-array met veilige AND-filters: {field,operator:eq,value}, in met values, exists, missing of range met gt/gte/lt/lte. Geen uitvoerbare expressies.', 'json', []),
  ...dateFields, ...metadataFields,
  field('limit', 'Paginagrootte 1-1000.', 'number', 100),
  field('offset', 'Paginastart 0-1000000.', 'number', 0),
];

function workflowInputs(fields) {
  return { mappingMode: 'defineBelow',
    value: Object.fromEntries(fields.map(f => {
      // n8n's json AI type rejects []/{} even as defaults. Parse a JSON-string
      // into the declared array input instead; empty arrays are valid here.
      const json = f.type === 'json';
      const call = `$fromAI(${JSON.stringify(f.name)}, ${JSON.stringify(f.description + (json ? ' Geef deze array als JSON-string.' : ''))}, ${JSON.stringify(json ? 'string' : f.type)}${f.fallback === undefined ? '' : ', ' + JSON.stringify(json ? JSON.stringify(f.fallback) : f.fallback)})`;
      return [f.name, `={{ ${json ? 'JSON.parse(' + call + ')' : call} }}`];
    })),
    matchingColumns: [],
    schema: fields.map(f => ({ id: f.name, displayName: f.name, required: f.fallback === undefined,
      defaultMatch: false, display: true, canBeUsedToMatch: true,
      type: f.type === 'json' ? 'array' : f.type })),
    attemptToConvertTypes: false, convertFieldsToString: false,
  };
}

function triggerInputs(fields) {
  return { inputSource: 'workflowInputs', workflowInputs: { values: fields.map(f => ({ name: f.name, type: f.type === 'json' ? 'array' : f.type })) } };
}

const searchRule = ' Gebruik voor één dossieroverzicht standaard één brede zoekaanroep met query_variants; de workflow zoekt en combineert varianten intern. Roep niet opnieuw aan voor iedere schrijfwijze of om dezelfde zoekactie te herhalen. Een aanvullende zoekactie is alleen nodig bij een concrete aanvullende vraag, een aantoonbaar ontbrekend onderdeel of een fout; motiveer waarom. Zet opgegeven datums ALTIJD in date_start/date_end en gekozen metadata in de aparte parameters als harde filters, niet alleen in query. Vanaf 2020 betekent date_start=2020-01-01. Tot de beschikbare snapshot zonder concrete einddatum betekent date_end leeg. Geef query_variants als JSON-array mee; vermeld applied_filters uit het resultaat. Een periode of andere metadata-afbakening mag nooit stilzwijgend worden genegeerd.';

const searchDescription = "OpenBesluitvorming is een Nederlands open-data-initiatief en centrale zoekmachine die openbare besluitvorming van gemeenten, provincies en waterschappen toegankelijk maakt. Medewerkers vinden er raadsstukken en statenstukken: bijvoorbeeld iBabs-vergaderdossiers, agenda’s, moties, amendementen, raads- en statenvoorstellen, besluiten, begrotingen, jaarstukken, verslagen en bijlagen. Zoek hiermee ook naar beleidsdossiers, vergunningen, projecten, voortgang en geschiedenis. Deze tool zoekt alleen in de bronnen die in deze GovChat-installatie zijn aangesloten; veronderstel geen landelijke of volledige dekking.\nBij een onduidelijke vraag zoals “Wat weet je van X?” vraag eerst of de gebruiker algemene kennis of zoeken in OpenBesluitvorming wil; wacht zonder alvast te zoeken. Bij een brede zoekopdracht zonder afbakening vraag naar periode of documentcategorie en bied de keuze om bewust breed te zoeken. Een duidelijk afgebakende opdracht mag direct worden uitgevoerd.\nParameters en voorbeelden:\n- query: inhoudelijk onderwerp, bijvoorbeeld “Chemelot”, “moties over wonen” of “begroting openbaar vervoer”.\n- query_variants: JSON-array als string, bijvoorbeeld '[\"Chemelot\",\"Brightlands Chemelot Campus\",\"Chemelot Circular Hub\"]'. Combineer schrijfwijzen in één brede aanroep, niet één aanroep per variant.\n- date_start/date_end: harde, inclusieve datumfilters in YYYY-MM-DD, bijvoorbeeld date_start=\"2020-01-01\" en date_end=\"2024-12-31\". “Vanaf 2020 tot de beschikbare snapshot” betekent date_start=\"2020-01-01\" en date_end leeg; verzin geen einddatum. Zet datums niet uitsluitend in query en verwijder gekozen filters niet zonder toestemming.\n- document_type: exacte metadatawaarde. Voorbeelden van inhoudelijke categorieën zijn Motie, Amendement, Statenvoorstel, Raadsvoorstel, Begroting, Jaarstukken, Verslag, Besluit en Vergunning. Dit zijn herkenbare categorievoorbeelden, geen gegarandeerde filtercodes: labels en beschikbaarheid verschillen per bron. Ontdek de werkelijke waarden met de statistiektool (fields, daarna group op het aanwezige documenttypeveld). Bij ontbrekende type-metadata gebruik de categorie als zoekterm, laat document_type leeg en benoem dat geen hard typefilter kon worden toegepast; raad nooit een code.\n- supplier: exacte leverancier, bijvoorbeeld \"ibabs\" als die waarde aanwezig is. source_key: exacte broncode uit de metadata, bijvoorbeeld \"provincie_limburg\" in een installatie met die bron. organization: exacte organisatienaam uit de metadata. Een reeds server-side vaste bron behoeft geen dubbel organisatiefilter.\n- meeting_id/referenced_by: exact bekend vergader- of verwijzings-ID; classification: exacte bestaande classificatie. Laat onbekende of niet gekozen filters leeg.\n- candidate_limit/rerank_limit: 50-500; result_limit: 10-100, bijvoorbeeld 100 voor een breed dossieroverzicht; include_content: true als inhoudspassages nodig zijn.\nRapporteer de toegepaste filters en dekkingsbeperkingen. Bij een bereikte kandidaatgrens is het resultaat niet volledig; herhaal alleen voor een concreet ontbrekend onderdeel of een fout en motiveer dat. Citeer beschikbare oorspronkelijke document- en downloadlinks. Gebruik voor exacte aantallen, metadata, groeperingen en synchronisatiestatus de statistiektool, niet deze zoektool.";

function applySearchToolInputs(workflow) {
  const tool = workflow.nodes.find(n => n.name === 'openbesluitvorming_search_tool');
  if (!tool) throw new Error('OpenBesluitvorming search tool ontbreekt');
  tool.parameters.workflowInputs = workflowInputs(searchFields);
  tool.parameters.description = searchDescription;
  return workflow;
}

function normalizeSearchInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Ongeldige zoekparameters');
  const input = { ...raw };
  const optional = ['date_start','date_end','date_from','date_to','source_key','organization','supplier','document_type','meeting_id','referenced_by','classification'];
  for (const key of optional) if (input[key] === '' || input[key] === null) delete input[key];
  for (const [alias, key] of [['date_start','date_from'], ['date_end','date_to']]) {
    if (input[alias] !== undefined) {
      if (input[key] !== undefined && input[key] !== input[alias]) throw new Error('Conflicterende datumparameters');
      input[key] = input[alias];
      delete input[alias];
    }
  }
  if (input.query_variants !== undefined && (!Array.isArray(input.query_variants) || input.query_variants.length > 4 || input.query_variants.some(v => typeof v !== 'string' || v.trim().length < 2 || v.length > 1000))) {
    throw new Error('query_variants moet een JSON-array van maximaal vier zoektermen zijn');
  }
  return input;
}

function applySearchWorkflowInputs(workflow) {
  const node = (w, id) => w.nodes.find(n => n.id === id);
  const canonical = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json'), 'utf8'));
  let code = node(canonical, 'ob-search-validate').parameters.jsCode;
  if (!code.includes('const normalizeSearchInput =')) {
    code = code.replace('const input=$input.first()?.json||{};',
      `const normalizeSearchInput = ${workflowFunctionSource(normalizeSearchInput)};\nconst input=normalizeSearchInput($input.first()?.json||{});`);
    code = code.replace('const variants=[query];', 'const variants=[query, ...(input.query_variants || []).map(v=>v.trim())];');
    code = code.replace('query_variants:[...new Set(variants)].slice(0,4)', 'query_variants:[...new Set(variants)].slice(0,5)');
  } else {
    const inputStart = code.indexOf('const input=normalizeSearchInput(');
    if (inputStart < 0) throw new Error('Onbekende zoekvalidatorstructuur');
    code = `const normalizeSearchInput = ${workflowFunctionSource(normalizeSearchInput)};\n` + code.slice(inputStart);
  }
  const prior = node(workflow, 'ob-search-validate').parameters.jsCode;
  // Preserve deployment-owned snapshot and embedding model in a live migration.
  const source = prior.match(/const sourceKey=('(?:[^'\\]|\\.)*');/);
  const collection = prior.match(/const collection=('(?:[^'\\]|\\.)*');/);
  const embedding = prior.match(/embedding_model:('(?:[^'\\]|\\.)*')/);
  if (source) code = code.replace('const sourceKey=filters.source_key||null;',
    `if(filters.source_key && filters.source_key !== ${source[1]}) throw new Error('Bron valt buiten de ingestelde dataset');\nfilters.source_key=${source[1]};\nqdrantFilter.must ||= [];\nif(!qdrantFilter.must.some(c=>c.key==='source_key')) qdrantFilter.must.push({key:'source_key',match:{value:filters.source_key}});\nconst sourceKey=${source[1]};`);
  if (collection) code = code.replace("const collection=String(input.collection||input.collectionName||'openraadsinformatie_v1').trim();", `const collection=${collection[1]};`);
  if (embedding) code = code.replace("embedding_model:String(input.embedding_model||input.embeddingModel||'govchat-embedding')", `embedding_model:${embedding[1]}`);
  // Only enable the canonical indexed date path when the deployment has
  // explicitly verified complete root-date coverage. Legacy imports retain
  // their fallback date semantics.
  if (!code.includes('OBV_CANONICAL_DATE_FIELD')) code = code.replace("conditions.push({should:['date','entity_detail.sortDate','entity_detail.date'].map(key=>({key,range}))});",
    "if($env.OBV_CANONICAL_DATE_FIELD==='date') conditions.push({key:'date',range}); else conditions.push({should:['date','entity_detail.sortDate','entity_detail.date'].map(key=>({key,range}))});");
  if (!code.includes('OBV_CANONICAL_TYPE_FIELD')) code = code.replace('for(const [key,keys] of Object.entries(paths))',
    "if(['classification','document_type'].includes($env.OBV_CANONICAL_TYPE_FIELD)) paths.document_type=[$env.OBV_CANONICAL_TYPE_FIELD];\nfor(const [key,keys] of Object.entries(paths))");
  node(workflow, 'ob-search-trigger').parameters = triggerInputs(searchFields);
  node(workflow, 'ob-search-validate').parameters.jsCode = code;
  node(workflow, 'ob-search-candidates').parameters.jsCode = node(canonical, 'ob-search-candidates').parameters.jsCode;
  const output = node(workflow, 'ob-search-output').parameters;
  if (!output.jsCode.includes('applied_filters:')) output.jsCode = output.jsCode.replace('collection:prepared.collection,results:', 'collection:prepared.collection,applied_filters:prepared.filters,query_variants:prepared.query_variants,results:');
  output.jsCode = output.jsCode.replace('For politically sensitive matters, inspect primary-source links, repeat searches with alternative wording, broaden or remove filters, and verify claims against underlying documents.',
    'Verifieer gevoelige conclusies met primaire bronnen. Zoekvarianten worden binnen deze aanroep gecombineerd; herhaal dezelfde zoekactie niet. Verruim of verwijder door de gebruiker gekozen datum- of metadatafilters nooit zonder toestemming. Meld een bereikte kandidaatgrens; zoek alleen aanvullend voor een concreet ontbrekend onderdeel.');
  require('./openbesluitvorming-search-performance').applySearchPerformance(workflow);
  return workflow;
}

module.exports = { searchFields, statisticsFields, workflowInputs, triggerInputs, searchRule, applySearchToolInputs, normalizeSearchInput, applySearchWorkflowInputs };
