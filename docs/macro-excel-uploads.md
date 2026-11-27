# Macrogeschikte Exceluploads

Macrogeschikte Excelwerkmappen worden expliciet toegelaten via de documentroutering.
Een aparte lezer verwerkt uitsluitend opgeslagen celwaarden, met werkbladnamen en
celadressen. Het oorspronkelijke bestand gaat **niet** naar Tika. Er is geen Excel-
runtime: VBA, formules, externe koppelingen en ingesloten objecten worden niet
uitgevoerd of verwerkt. Macrobladen en grafiekbladen worden overgeslagen.

Formuleresultaten zijn de opgeslagen waarden en kunnen verouderd zijn. Een formule
zonder opgeslagen resultaat krijgt een expliciete melding. Getallen en datums
behouden hun ruwe opgeslagen waarden; Excel-opmaak wordt niet toegepast. De
uitgelezen tekst vermeldt deze beperkingen. Een werkmap zonder opgeslagen
celwaarden wordt geweigerd.

Werkbladen en gedeelde tekenreeksen worden streaming gelezen; verwerkte XML wordt
direct vrijgegeven. Gedeelde tekenreeksen worden compact als UTF-8 met offsets
bewaard, niet als volledige XML-boom. Grote werkbladen vereisen zo geen volledige
DOM in het geheugen.

Voorcontrole en celverwerking zijn afzonderlijke subprocessen. De voorcontrole
behoudt 5 CPU-seconden en maximaal 30 seconden verstreken tijd. De streaming
celverwerking krijgt een eigen plafond van 30 CPU-seconden en maximaal 120
seconden verstreken tijd. Beide stappen vallen binnen de oorspronkelijke
aanvraagdeadline; die wordt niet vernieuwd. Elke worker blijft begrensd tot 256
MiB. Bij timeout wordt de worker beëindigd en afgewacht voordat de volgende
aanvraag wordt toegelaten.

De bestaande upload-, archief-, werkblad- en uitvoerlimieten blijven gelden.
XML met DTD of entiteiten wordt geweigerd. Externe werkbladrelaties
en onveilige paden worden geweigerd. Tijdelijke bestanden worden na iedere poging
verwijderd. Gewone Excelwerkmappen met een VBA-project blijven geblokkeerd.

Voor activering moet de adapter opnieuw worden gebouwd, de gegenereerde LibreChat-
configuratie worden bijgewerkt en LibreChat opnieuw worden gestart. Zowel de
browser-MIME met hoofdletter E als de genormaliseerde transport-MIME wordt
ondersteund. De nieuwe tests gebruiken uitsluitend synthetische bestanden.
