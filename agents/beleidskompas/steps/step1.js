'use strict';

/**
 * Beleidskompas step 1 ("Publiek en provinciaal belang").
 *
 * The output schema (case_summary / public_interest / provincial_interest /
 * reasoning / assumptions_missing_info / disclaimer) condenses the 6-agent
 * chain (001-006) from the prior Python/OpenWebUI/Qdrant Beleidskompas PoC
 * into a single LLM call, keeping the
 * five public-interest test criteria from 002_OVERHEIDSINTERVENTIE and the
 * public/provincial verdict shape from 005_INTEGRALE_AFWEGING.
 *
 * In n8n this code is the content of the Code node "Build Step 1 Answer" in
 * the workflow "Beleidskompas Specialist - Stap 1": generate-workflow.js
 * pastes it there as text, together with runStep from shared.js. Change it
 * here, not in n8n; the next run of the generator overwrites the node.
 */

const { DISCLAIMER } = require('../shared');

function buildSystemPrompt(sources) {
  const sourceList = Array.isArray(sources) && sources.length ? sources.join('; ') : 'geen aanvullende bronlijst aangeleverd';
  return (
    'Je bent een realistisch analysemodel voor stap 1 (Publiek en provinciaal belang) van het Beleidskompas van Provincie Limburg. ' +
    'Je combineert drie deelanalyses tot een samenhangend oordeel: (1) probleemdefinitie - het feitelijke probleem, oorzaken, symptomen en ontbrekende perspectieven; ' +
    '(2) overheidsinterventie - toets langs vijf criteria of publiek belang aanwezig is: marktfalen, publieke goederen/diensten, sociale rechtvaardigheid, externe effecten, consumentenbescherming; ' +
    '(3) provinciaal belang - past de taak binnen de wettelijke taken, bevoegdheden en vastgestelde beleidskaders van de provincie, of is dit een gemeentelijke aangelegenheid? ' +
    'Gebruik uitsluitend expliciete informatie uit de casus en de aangeleverde brondocumenten (' + sourceList + '). ' +
    'Maak geen eigen interpretaties of feitelijke aannames; benoem ontbrekende informatie expliciet in plaats van te verzinnen. Redeneer stap voor stap en wees feitelijk en beknopt. ' +
    // De explanation-velden worden als markdown weergegeven (ook in het
    // opgeslagen LibreChat-bericht), dus per criterium een regel leest daar
    // veel beter dan "(1) ... (2) ..." in één lange alinea.
    'Zet in "explanation" elk criterium op een eigen regel als markdown-opsomming ("- criterium: bevinding"), gescheiden door regeleindes. ' +
    'Zet in "reasoning" elke redeneerstap ook op een eigen regel, genummerd ("1. ...", "2. ...") en gescheiden door regeleindes. ' +
    'Dit is een ondersteunend hulpmiddel: benoem dit resultaat nooit als een besluit. ' +
    'Antwoord UITSLUITEND met een geldig JSON-object, zonder markdown-codeblok, exact met deze velden: ' +
    '{"case_summary": string, "public_interest": {"verdict": "ja"|"nee"|"onduidelijk", "explanation": string}, ' +
    '"provincial_interest": {"verdict": "ja"|"nee"|"beperkt"|"onduidelijk", "explanation": string}, ' +
    '"reasoning": string, "assumptions_missing_info": string[]}'
  );
}

/** The answer when the model's reply is not JSON: every verdict unknown,
 *  the raw reply kept as the reasoning. */
function emptyStructured(rawText) {
  return {
    case_summary: '',
    public_interest: { verdict: 'onduidelijk', explanation: '' },
    provincial_interest: { verdict: 'onduidelijk', explanation: '' },
    reasoning: rawText || 'Het taalmodel gaf geen bruikbare output terug.',
    assumptions_missing_info: ['Kon het modelantwoord niet als JSON verwerken; ruwe tekst is opgenomen in het redeneerveld.'],
  };
}
function buildDemoFallbackStructured({ question, caseText, citations }) {
  const hasCase = Boolean(String(caseText || '').trim());

  const summaryParts = [];
  if (caseText) summaryParts.push(caseText);
  else if (question) summaryParts.push(question);
  const case_summary = summaryParts.join(' ').trim() || 'Onvoldoende informatie aangeleverd om een casusomschrijving samen te stellen.';

  const topDocFilenames = (Array.isArray(citations) ? citations : []).map((c) => c.filename);

  const public_interest = hasCase
    ? {
        verdict: 'onduidelijk',
        explanation:
          'Demo-modus (geen taalmodel geconfigureerd): een deterministische plaatsvervanger kan marktfalen, publieke goederen, sociale rechtvaardigheid, ' +
          'externe effecten en consumentenbescherming niet inhoudelijk beoordelen. Vereist een echte modelanalyse van de casustekst.',
      }
    : { verdict: 'onduidelijk', explanation: 'Onvoldoende casusinformatie aangeleverd om publiek belang te beoordelen.' };

  const provincial_interest = {
    verdict: 'onduidelijk',
    explanation: topDocFilenames.length
      ? 'Demo-modus: mogelijk relevante beleidsbronnen gevonden (' + topDocFilenames.join(', ') + '), maar de daadwerkelijke provinciale-bevoegdheidstoets vereist een taalmodel.'
      : 'Demo-modus: geen relevante beleidsbronnen boven de drempel gevonden en geen taalmodel beschikbaar om provinciale bevoegdheid te toetsen.',
  };

  const reasoning =
    '⚠️ DEMO-MODUS: er is geen LITELLM_API_KEY/OPENAI_API_KEY geconfigureerd, dus deze uitvoer is een deterministische placeholder ' +
    'in plaats van een echte AI-beoordeling. De structuur van het antwoord (samenvatting, publiek belang, provinciaal belang, redenering, aannames, bronnen) ' +
    'is representatief voor de productiemodus, maar de inhoud is niet inhoudelijk beoordeeld.';

  return {
    case_summary,
    public_interest,
    provincial_interest,
    reasoning,
    assumptions_missing_info: [
      'Geen taalmodel geconfigureerd (LITELLM_API_KEY/OPENAI_API_KEY ontbreekt): dit is een demo-fallback, geen AI-beoordeling.',
    ],
  };
}

/** Stelt het antwoord samen als markdown. Dit is niet alleen de tekst voor de
 *  Beleidskompas-interface: LibreChat bewaart hem als gespreksbericht, dus wie
 *  de casus in de gewone chat opent ziet exact dit. Daarom kopjes, vette
 *  labels en een expliciete bronnenlijst - die bronnen zitten verder alleen in
 *  het onzichtbare meta-blok en zouden daar anders ontbreken (F-25). */
function composeAnswerText(structured, mode, citations) {
  const s = structured && typeof structured === 'object' ? structured : {};
  const pub = s.public_interest && typeof s.public_interest === 'object' ? s.public_interest : {};
  const prov = s.provincial_interest && typeof s.provincial_interest === 'object' ? s.provincial_interest : {};
  const assumptions = Array.isArray(s.assumptions_missing_info) ? s.assumptions_missing_info : [];
  const sources = Array.isArray(citations) ? citations : [];

  const lines = [];
  if (mode === 'demo_fallback') {
    lines.push('⚠️ DEMO-UITVOER (geen taalmodel geconfigureerd) - onderstaande tekst is een deterministische placeholder, geen AI-beoordeling.');
    lines.push('');
  }
  lines.push('**Stap 1 · Publiek en provinciaal belang**');
  lines.push('');
  lines.push('### Samenvatting casus');
  lines.push(s.case_summary || 'onbekend');
  lines.push('');
  lines.push('### Publiek belang');
  lines.push(`**Oordeel:** ${pub.verdict || 'onduidelijk'}`);
  if (pub.explanation) {
    lines.push('');
    lines.push(pub.explanation);
  }
  lines.push('');
  lines.push('### Provinciaal belang');
  lines.push(`**Oordeel:** ${prov.verdict || 'onduidelijk'}`);
  if (prov.explanation) {
    lines.push('');
    lines.push(prov.explanation);
  }
  lines.push('');
  lines.push('### Redenering');
  lines.push(s.reasoning || 'onbekend');
  lines.push('');
  lines.push('### Aannames en ontbrekende informatie');
  lines.push(assumptions.length ? assumptions.map((a) => '- ' + a).join('\n') : '- geen');
  lines.push('');
  lines.push('### Bronnen');
  lines.push(
    sources.length
      ? sources
          .map((c, idx) => {
            const score = Number(c && c.score);
            const relevance = Number.isFinite(score) && score > 0 ? ` - relevantie ${score.toFixed(3)}` : '';
            return `${idx + 1}. **${String((c && c.filename) || 'Onbekende bron')}**${relevance}`;
          })
          .join('\n')
      : '- geen bronnen boven de relevantiedrempel',
  );
  lines.push('');
  lines.push('---');
  lines.push(DISCLAIMER);

  return lines.join('\n');
}

/** What makes this step itself; runStep in shared.js does the rest. */
const STEP = {
  id: 'stap1',
  buildSystemPrompt,
  emptyStructured,
  buildDemoFallbackStructured,
  composeAnswerText,
};

module.exports = {
  STEP,
  buildSystemPrompt,
  emptyStructured,
  buildDemoFallbackStructured,
  composeAnswerText,
};
