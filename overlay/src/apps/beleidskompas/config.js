// The configuration of the Beleidskompas screen: the steps and substeps from
// steps.json, the default texts around them, and how the published
// configuration (the app's entry in apps.json plus the step configuration)
// is merged with those.

const DEFAULT_SPECIALIST_TEAM =
  "Schakel bij complexe juridische, financiële of politiek-bestuurlijke casussen een specialistenteam in.";

// The texts around each step, shown on the card, the overview and in the
// step's explanation: a short description, the longer explanation and the
// check questions. The description in the published configuration can
// replace the first two; the prompt of a step is not public and never shows
// here. The steps themselves come from steps.json.
//
// TODO: revisit these texts: whether they belong with the step list in
// steps.json (one file for everything the page knows about a step), and
// that, once the admin environment holds the steps and prompts, all of it
// comes from there and nothing stays here.
const DEFAULT_STEP_TEXTS = {
  stap1: {
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
  stap2: {
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
  stap3: {
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
  stap4: {
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
};

/** `stepsData` is steps.json: the steps with their substeps, generated from
 *  the step definitions in agents/beleidskompas/ (one list for the page and
 *  the workflows). It is required; the texts around the steps are not. */
export function buildConfig(app, flowConfig, stepsData) {
  const cfg = {
    ...(app?.config && typeof app.config === "object" ? app.config : {}),
    ...(flowConfig && typeof flowConfig === "object" ? flowConfig : {}),
  };
  return {
    title: String(cfg.title || "").trim(),
    disclaimer: String(cfg.disclaimer || "").trim(),
    specialistTeam: String(cfg.specialist_team || DEFAULT_SPECIALIST_TEAM).trim(),
    steps: buildSteps(cfg, stepsData),
  };
}

/** The steps as steps.json defines them, with the texts around each step
 *  (short description, longer explanation) from the published configuration
 *  when it has them, otherwise from DEFAULT_STEP_TEXTS; the check questions
 *  come from there too. */
function buildSteps(cfg, stepsData) {
  const defined = Array.isArray(stepsData?.steps) ? stepsData.steps : [];
  if (!defined.length) throw new Error("steps.json ontbreekt of bevat geen stappen");
  const configured = Array.isArray(cfg.steps) ? cfg.steps : [];
  return defined.map((step, idx) => {
    const id = String(step.id);
    const texts = DEFAULT_STEP_TEXTS[id] || { short: "", info: "", help: [], deep: [] };
    const own = configured.find((c) => c && String(c.id || "").trim() === id) || configured[idx] || {};
    const substeps = Array.isArray(step.substeps) ? step.substeps : [];
    return {
      id,
      nr: Number(step.nr) || idx + 1,
      title: String(step.title || "").trim(),
      substeps: substeps.map((s) => ({ id: String(s.id), title: String(s.title || "").trim() })),
      short: String(own.description || "").trim() || texts.short,
      info: String(own.description || "").trim() || texts.info,
      help: texts.help,
      deep: texts.deep,
    };
  });
}
