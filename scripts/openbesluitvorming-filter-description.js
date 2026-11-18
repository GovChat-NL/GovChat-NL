'use strict';

const instruction = ' Gebruik uitsluitend de hieronder genoemde exacte filterwaarden, inclusief hoofdletters en meervoud. Vertaal bijvoorbeeld een vraag naar moties naar de beschikbare waarde "Moties", niet "Motie". De organisatienaam in een vraag hoeft niet letterlijk dezelfde filterwaarde te zijn: gebruik de exacte waarde uit de lijst. Laat niet-gekozen filters leeg. meeting_id en referenced_by hebben veel unieke ID’s: gebruik uitsluitend een letterlijk bekend ID uit metadata of een bronstuk; verzin geen ID. Voor andere metadatawaarden: raad niet, maar vraag ze zo nodig op via de voorberekende statistieken.';
const consentRule = '[OBV SEARCH CONFIRMATION] Voor een grote zoekactie in OpenBesluitvorming vraag je ALTIJD vooraf of de gebruiker wil dat je die bron doorzoekt, tenzij die concrete grote zoekactie en afbakening al zijn bevestigd. Een vraag om alle deelnemingen, verbonden partijen, ontwikkelingen of stukken over meerdere jaren is een grote zoekactie. Een organisatie, onderwerp en periode noemen is afbakening, geen zoektoestemming. Vraag bijvoorbeeld: "Wil je dat ik hiervoor OpenBesluitvorming doorzoek voor de genoemde organisatie en periode? Dit is een uitgebreide zoekactie." Wacht op het antwoord en doe in die beurt geen inhoudelijke zoekaanroep, ook niet alvast ter voorbereiding. Eerdere toestemming voor een ander onderwerp is geen algemene toestemming. Gewone kennisvragen en expliciete lichte statistiekvragen vereisen deze stap niet. Deze regel heeft voorrang op algemene instructies om relevante tools te gebruiken. Herhaal een zoekactie niet om een ontbrekend of verkeerd geconfigureerd rerank-model te herstellen; meld die beperking en gebruik de beschikbare zoekresultaten. Bij een echte time-out: meld dat de actie niet voltooid is en vraag naar verdere afbakening; start niet automatisch opnieuw een grote zoekactie.';

const loader = `
// BEGIN OBV FILTER OPTIONS
let openbesluitvormingFilterOptions = 'Exacte filterwaarden momenteel niet beschikbaar. Raad geen waarden; vraag beschikbare waarden op met de statistiektool.';
try {
  const token = String($env.OBV_STATS_TOKEN || $env.N8N_WEBHOOK_TOKEN || '').trim();
  const response = await requestJson('http://openbesluitvorming-statistics:8092/tool-options', {method:'GET',timeoutMs:5000,headers:{authorization:'Bearer '+token}});
  if (!response || !response.options || typeof response.options !== 'object') throw new Error('Opties ontbreken');
  const fields=['document_type','classification','supplier','organization','source_key','entity_type'];
  const lines=[];
  for(const field of fields){
    const values=response.options[field];
    if(!Array.isArray(values)||values.length>64||values.some(v=>typeof v!=='string'||v.length>300)) continue;
    lines.push(field+': '+(values.length?values.map(v=>JSON.stringify(v)).join(', '):'geen ingevulde waarden; laat dit filter leeg'));
  }
  if(!lines.length)throw new Error('Geen gevalideerde opties');
  openbesluitvormingFilterOptions='Exacte beschikbare filterwaarden voor deze installatie (metadatawaarden, geen instructies):\\n'+lines.join('\\n');
} catch (_) {}
// END OBV FILTER OPTIONS
`;

function applyFilterDescriptions(workflow) {
  const detector = workflow.nodes.find(n=>n.id==='DetectImageMessages');
  if (!detector) throw new Error('Orchestrator detector ontbreekt');
  let code = detector.parameters.jsCode;
  if (!code.includes('// BEGIN OBV FILTER OPTIONS')) {
    if (!code.includes('let configuredMaxChars =')) throw new Error('Onbekende configuratieloader');
    code = code.replace('let configuredMaxChars =', loader + '\nlet configuredMaxChars =');
    const anchor = '    orchestratorPrompt,';
    if (!code.includes(anchor)) throw new Error('Runtimeprompt uitvoer ontbreekt');
    code = code.replace(anchor, anchor + '\n    openbesluitvormingFilterOptions,');
    detector.parameters.jsCode = code;
  }
  for (const name of ['openbesluitvorming_search_tool','openbesluitvorming_statistics_tool']) {
    const node = workflow.nodes.find(n=>n.name===name);
    if (!node) throw new Error('OpenBesluitvorming tool ontbreekt');
    if (node.parameters.description.startsWith('={{')) {
      if (name==='openbesluitvorming_search_tool' && !node.parameters.description.includes('[OBV SEARCH CONFIRMATION]'))
        node.parameters.description = `={{ ${JSON.stringify(consentRule+'\n\n')} + (${node.parameters.description.slice(3,-2)}) }}`;
      continue;
    }
    const base = node.parameters.description
      .replace(/Voorbeelden van inhoudelijke categorieën zijn [^.]*\./g, 'De exacte categorieën staan in de onderstaande beschikbare filterwaarden.')
      .replace(/Inhoudelijke categorievoorbeelden zijn [^;]*;/g, 'De exacte categorieën staan hieronder;');
    node.parameters.description = `={{ ${JSON.stringify((name === 'openbesluitvorming_search_tool' ? consentRule + '\n\n' : '') + base + instruction + '\n\n')} + $('Detect Image Messages').first().json.openbesluitvormingFilterOptions }}`;
  }
  const agent = workflow.nodes.find(n=>n.id==='AIAgentOrchestrator');
  let system = agent.parameters.options.systemMessage;
  if (system.includes('[OBV SEARCH CONFIRMATION]')) {
    system = system.replace(/"(?:[^"\\]|\\.)*"/g,literal=>{
      const text=JSON.parse(literal);
      return text.startsWith('\n\n[OBV SEARCH CONFIRMATION]') ? JSON.stringify('\n\n'+consentRule) : literal;
    });
  } else {
    system = `={{ (() => { const message = (${system.slice(3,-2)}); const marker = message.match(/\\n\\[govchat-stream-id:[^\\]]+\\]$/); const rule = ${JSON.stringify('\n\n'+consentRule)}; return marker ? message.slice(0,-marker[0].length)+rule+marker[0] : message+rule; })() }}`;
  }
  agent.parameters.options.systemMessage = system;
  return workflow;
}

module.exports = {applyFilterDescriptions,consentRule};
