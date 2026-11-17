// The configuration of the Beleidskompas screen: the default texts, and how
// the published configuration (the app's entry in apps.json plus the step
// configuration) is merged with them.

const DEFAULT_SPECIALIST_TEAM =
  "Schakel bij complexe juridische, financiële of politiek-bestuurlijke casussen een specialistenteam in.";

const DEFAULT_SOURCES = [
  "SiS 4.0 Strategisch kader",
  "SiS 4.0 Uitvoeringskader",
  "Provinciale Instrumentenkoffer",
  "Coalitieakkoord en beleidskaders",
  "Overzicht wettelijke taken Provincie",
];

const DEFAULT_STEPS = [
  {
    id: "stap1",
    nr: 1,
    title: "Publiek en provinciaal belang",
    short: "Bepaal probleem, publiek belang en provinciale legitimiteit.",
    info:
      "Toets of het vraagstuk publiek relevant is, binnen provinciale wettelijke taken valt en expliciet past binnen coalitieakkoord en beleidskaders.",
    help: [
      "Welk concreet maatschappelijk probleem wil je oplossen?",
      "Wie ondervindt nadeel als de provincie niet handelt?",
      "Welke wettelijke of bestuurlijke grondslag legitimeert provinciaal handelen?",
    ],
    deep: [
      "Welke groepen hebben conflicterende belangen en waarom?",
      "Welke juridische, financiële en organisatorische randvoorwaarden begrenzen het handelen?",
    ],
  },
  {
    id: "stap2",
    nr: 2,
    title: "Rolbepaling provincie",
    short: "Kies passende rol(len): regulerend, regisserend, stimulerend, faciliterend.",
    info:
      "Onderbouw waarom een rol passend is bij doel, bevoegdheid, bestuurlijke context en uitvoerbaarheid. Combineer rollen alleen als dit uitlegbaar en bestuurbaar is.",
    help: [
      "Welke rol heeft de hoogste effectiviteit gegeven urgentie en mandaat?",
      "Welke rol biedt de beste balans tussen impact, kosten en bestuurlijke haalbaarheid?",
      "Is een rolcombinatie nodig of ontstaat dan juist complexiteit?",
    ],
    deep: [
      "Welke governance-risico’s ontstaan bij deze rolkeuze?",
      "Welke afhankelijkheden met ketenpartners zijn kritiek?",
    ],
  },
  {
    id: "stap3",
    nr: 3,
    title: "Instrumentkeuze",
    short: "Weeg en vergelijk instrumenten met score en argumentatie.",
    info:
      "Gebruik de Provinciale Instrumentenkoffer en beoordeel instrumenten op effectiviteit, uitvoerbaarheid, juridische robuustheid, betaalbaarheid en maatschappelijke impact.",
    help: [
      "Welke instrumenten zijn realistisch beschikbaar binnen planning en capaciteit?",
      "Wat is het voorkeursinstrument en waarom?",
      "Welke twee alternatieven zijn serieus en bestuurlijk verdedigbaar?",
    ],
    deep: [
      "Welke risico’s, neveneffecten en mitigerende maatregelen horen per optie?",
      "Welke bron onderbouwt elke score of aanname?",
    ],
  },
  {
    id: "stap4",
    nr: 4,
    title: "Governance-inrichting",
    short: "Adviseer sturing, toezicht, beheersing en verantwoording.",
    info:
      "Sluit aan op hoofdstuk 10 van SiS 4.0 en het uitvoeringskader: wie stuurt, wie houdt toezicht, welke KPI’s gelden en hoe wordt verantwoord.",
    help: [
      "Welke governance-structuur past bij het gekozen instrument?",
      "Hoe richt je besluitvorming, escalatie en verantwoordingslijnen in?",
      "Welke monitoring/KPI’s zijn nodig voor bestuurlijke bijsturing?",
    ],
    deep: [
      "Welke governance-implicaties gelden voor alternatieve instrumenten?",
      "Welke kwaliteitspoorten en validatiestappen voorkómen ongecontroleerde AI-output?",
    ],
  },
];

export function buildConfig(app, flowConfig) {
  const cfg = {
    ...(app?.config && typeof app.config === "object" ? app.config : {}),
    ...(flowConfig && typeof flowConfig === "object" ? flowConfig : {}),
  };
  return {
    title: String(cfg.title || "").trim(),
    disclaimer: String(cfg.disclaimer || "").trim(),
    specialistTeam: String(cfg.specialist_team || DEFAULT_SPECIALIST_TEAM).trim(),
    sources: Array.isArray(cfg.sources) && cfg.sources.length ? cfg.sources : DEFAULT_SOURCES,
    steps: buildSteps(cfg),
  };
}

function buildSteps(cfg) {
  return Array.isArray(cfg.steps) && cfg.steps.length
    ? cfg.steps.map((step, idx) => {
        const fb = DEFAULT_STEPS[Math.min(idx, DEFAULT_STEPS.length - 1)] || DEFAULT_STEPS[0];
        const substeps = Array.isArray(step?.substeps) ? step.substeps : [];
        return {
          id: String(step?.id || `stap${idx + 1}`).trim() || `stap${idx + 1}`,
          nr: idx + 1,
          title: String(step?.title || fb.title || `Stap ${idx + 1}`).trim(),
          short: String(step?.description || fb.short || "").trim() || fb.short,
          info: String(step?.prompt || step?.description || fb.info || "").trim() || fb.info,
          help: substeps.length
            ? substeps.map((s) => String(s?.title || "").trim()).filter(Boolean)
            : fb.help,
          deep: substeps.length
            ? substeps
                .map((s) => String(s?.description || "").trim())
                .filter(Boolean)
                .slice(0, 4)
            : fb.deep,
        };
      })
    : DEFAULT_STEPS;
}
