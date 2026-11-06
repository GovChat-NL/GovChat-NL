// Sample data for the parts of the admin UI that have no backend yet.
// Only api.js imports this file. MOCK #n refers to ADMIN_UI_FUTURE_WORK.md (private, local notes for now).

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

// MOCK #1: the server's single template has no name field.
export const REAL_TEMPLATE = { id: "sis40", name: "SiS 4.0", mock: false };

const omgevingsvisieFlow = {
  title: "Beleidskompas Omgevingsvisie",
  orchestrator_workflow_id: "govchat-beleidskompas-hoofdagent",
  orchestrator_webhook_path: "beleidskompas-hoofdagent",
  webhook_token: "",
  disclaimer: "Voorbeeldtemplate: deze configuratie is niet opgeslagen op de server.",
  specialist_team: "Betrek de omgevingsjurist bij ruimtelijke besluiten.",
  sources: ["Omgevingsvisie Limburg", "Omgevingsverordening", "Provinciale Instrumentenkoffer"],
  steps: [
    {
      id: "ov1",
      title: "Opgave en belang",
      description: "Welke ruimtelijke opgave speelt er, en waarom is de provincie aan zet?",
      prompt: "Bepaal de ruimtelijke opgave en het provinciaal belang volgens de Omgevingsvisie.",
      doc_tags: ["Omgevingsvisie"],
      rag: { algorithm: "hybrid", top_k: 3, min_score: 0.1, tag_filter_mode: "any", required_tags: [] },
      substeps: [{ id: "1.1", title: "Gebied", description: "Afbakening van het gebied." }],
    },
    {
      id: "ov2",
      title: "Rol en instrument",
      description: "Welke rol neemt de provincie en welk instrument past?",
      prompt: "Kies rol en instrument; verwijs naar de Omgevingsverordening.",
      doc_tags: ["Verordening", "Instrumenten"],
      rag: { algorithm: "needle", top_k: 4, min_score: 0.12, tag_filter_mode: "any", required_tags: [] },
      substeps: [],
    },
    {
      id: "ov3",
      title: "Governance",
      description: "Wie beslist, wie voert uit en hoe wordt gemonitord?",
      prompt: "Beschrijf governance, besluitvorming en monitoring.",
      doc_tags: [],
      rag: { algorithm: "hybrid", top_k: 3, min_score: 0.08, tag_filter_mode: "any", required_tags: [] },
      substeps: [],
    },
  ],
};

const ovDocs = [
  { id: "ov-doc-1", filename: "Omgevingsvisie Limburg 2024.pdf", mime_type: "application/pdf", size_bytes: 4820000, uploaded_at: daysAgo(40), tags: ["Omgevingsvisie"], preview_text: "Voorbeelddocument (mock). De Omgevingsvisie beschrijft de ruimtelijke ambities van de provincie tot 2040." },
  { id: "ov-doc-2", filename: "Omgevingsverordening.pdf", mime_type: "application/pdf", size_bytes: 2310000, uploaded_at: daysAgo(35), tags: ["Verordening"], preview_text: "Voorbeelddocument (mock). Regels voor de fysieke leefomgeving in Limburg." },
  { id: "ov-doc-3", filename: "Instrumentenkoffer.md", mime_type: "text/markdown", size_bytes: 18400, uploaded_at: daysAgo(12), tags: ["Instrumenten"], preview_text: "Voorbeelddocument (mock).\n\n# Instrumenten\n- Subsidie\n- Regelgeving\n- Kennis en netwerk" },
];

const ovFeedback = [
  { id: "ov-f1", rating: "up", comment: "Duidelijke afbakening van het gebied.", step_id: "ov1", created_at: daysAgo(2), version_id: "ov-v2" },
  { id: "ov-f2", rating: "down", comment: "Verordening werd niet geciteerd.", step_id: "ov2", created_at: daysAgo(5), version_id: "ov-v2" },
  { id: "ov-f3", rating: "up", comment: "", step_id: "ov2", created_at: daysAgo(9), version_id: "ov-v1" },
  { id: "ov-f4", rating: "up", comment: "Goede vragen over monitoring.", step_id: "ov3", created_at: daysAgo(20), version_id: "ov-v1" },
  { id: "ov-f5", rating: "down", comment: "Te algemeen.", step_id: "ov1", created_at: daysAgo(45), version_id: "ov-v1" },
].map((f) => ({ ...f, template_id: "omgevingsvisie", answer_text: mockAnswerText(f.step_id) }));

// MOCK #1: a second template, to show the template selector and the feedback filter.
export const MOCK_TEMPLATES = [
  {
    id: "omgevingsvisie",
    name: "Omgevingsvisie (voorbeeld)",
    mock: true,
    live_version_id: "ov-v2",
    versions: [
      { id: "ov-v2", published_at: daysAgo(7), published_by: "Mock", note: "Verordening toegevoegd", is_live: true, snapshot: omgevingsvisieFlow },
      { id: "ov-v1", published_at: daysAgo(60), published_by: "Mock", note: "Eerste versie", is_live: false, snapshot: omgevingsvisieFlow },
    ],
    documents: ovDocs,
    feedback: ovFeedback,
  },
];

// MOCK #5: the answer a user reacted to is not stored with the feedback.
export function mockAnswerText(stepId) {
  return `MOCK: voorbeeldantwoord voor stap ${stepId || "onbekend"}.`;
}
