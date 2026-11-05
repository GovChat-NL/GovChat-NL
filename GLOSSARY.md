# Beleidskompas

Beleidskompas guides a province policy officer through a policy question in fixed steps. The admin UI is where its configuration is edited and its feedback is read.

## Language

**Template**:
A named Beleidskompas configuration: its document library, its steps, and per step the system prompt and the step documents. A larger, intentional change is saved as a new template.
_Avoid_: config, flow, profile, major version

**Template version**:
One published state of a template. Small changes (a typo, a document update) are published as a new version of the same template.
_Avoid_: release, revision, minor version

**Document library**:
The set of documents a template can draw on, shared by all its steps.
_Avoid_: knowledge base, collection

**Step documents**:
The documents from the document library that one step actually uses (checked for that step).
_Avoid_: doc tags, step sources

**Step**:
One stage of a Beleidskompas conversation (e.g. Stap 1, Belang), defined by its template.
_Avoid_: phase, stage

**Feedback**:
An anonymous reaction (thumbs up or down, optional comment) a user leaves on one assistant answer within a step. It belongs to the template version the conversation follows.
_Avoid_: rating, review
