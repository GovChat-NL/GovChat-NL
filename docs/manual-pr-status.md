# Configureerbare handleiding: PR-status

## Oplevering en open scope

Deze feature is gebouwd op dev-basis **5b1e251** in een afzonderlijke featureworktree. De PR is bewust een **concept-PR**: de handleiding/editor en veilige algemene agenttoegang zijn geïmplementeerd, maar de volledige oorspronkelijke scope is nog niet geaccepteerd. Er is niets gemerged, geactiveerd of uitgerold. De feature staat standaard uit; automatisch openen staat standaard op nooit.

### Geïmplementeerd

- Eén gevalideerde, configureerbare informatiebron voor admin, bestands-/scriptbeheer, gebruikersweergave en toegestane agentpassages.
- Generieke Nederlandse inhoud met afzonderlijk Limburg/LAICA-profiel: twaalf hoofdstukken, 53 topics en 692 foutartikelen met 851 bronvermeldingen uit 263 gecontroleerde bronartifacts.
- Configureerbare zichtbaarheid van hoofdstukken, onderwerpen, foutcategorieën en afzonderlijke foutartikelen. Ouders overrulen kinderen; beschikbare functies en gebruikersrechten beperken de zichtbaarheid verder. De instellingen wijzigen geen LibreChat-productrechten of -functies.
- Private concepten, preview, expliciet publiceren, revisieconflicten, veldreset, import/export en rollback. Publicatiefalen blokkeert reads in plaats van een oude geactiveerde versie als succesvol te presenteren.
- Responsive modal, inhoudsopgave, zoeken, passagegeschiedenis, volledig scherm, veilige printweergave, toetsenbordbediening en account-/browsergebonden popupvoorkeuren.
- Configureerbaar automatisch openen bij eerste gebruik, een nieuwe handleidingrevisie of iedere nieuwe sessie; geen automatische opening op login of boven andere dialogs.
- Native footerlink, mobiele toegang, helpmenu, startpagina en Beleidskompas via de gedocumenteerde optionele native build. De bestaande disclaimer en juridische links blijven behouden.
- Geauthenticeerde interne agenttool, begrensde bronresultaten en klikbare revisiegebonden verwijzingen. De browser valideert bestemming en actuele gebruikersrechten; verborgen of gewijzigde passages worden niet stilzwijgend geopend.
- Foutcatalogus met bruikbare hersteluitleg. Normale gebruikersartikelen zijn gescheiden van een standaard verborgen technische/aanvullende bijlage. Geen persoonlijke foutlogs.

## Resterende blokkades

1. **Gebruikersgebonden agentcontext ontbreekt.** De agent gebruikt alleen de veilige algemene context. Daardoor kan hij niet alle document- en promptpassages raadplegen die een individuele ingelogde gebruiker wel mag zien. De publiek aantoonbare voorwaardelijke promptbibliotheekintroductie komt inmiddels uit dezelfde compiler en heeft een valide passageverwijzing; ze kent geen persoonlijke rechten toe. Volledige doorgifte en verse verificatie van identiteit, rol en effectieve rechten via LibreChat → bridge → n8n → backend blijven vereist. Een gedeelde bearer of AI-aangeleverde rol is daarvoor geen vervanging.
2. **OpenBesluitvorming, TOPdesk en transcriptie hebben geen volledige vertrouwde beschikbaarheidsadapter.** De betreffende topics zijn aanwezig als configurabele inhoud, maar blijven verborgen zolang beschikbaarheid/rechten niet aantoonbaar zijn. Dit betekent niet dat die functies in een deployment daadwerkelijk uit staan.
3. **Live installatieacceptatie blijft open.** Geen live Entra-aanmelding, echte modelvraag, productiebridge-/n8nketen, schermlezerhardware of OS-printer is gevalideerd. Het native browserbewijs gebruikt echte gepinde frontendmodules met synthetische API/auth. De optionele build en backend-/workflowinstallatie moeten volgens de gewone releaseprocedure worden uitgevoerd vóór activatie.

Deze punten zijn geen kleine documentatievoetnoten en worden niet als afgeronde functionaliteit voorgesteld. Zie de [agentreview](manual-agent-review.md) en [gecombineerde review](manual-final-review.md) voor de onderzochte grenzen.

## Finale parent-controle op 28 november 2026

Na de eerdere gecombineerde review vond de parent twee concrete eindstaatinconsistenties: een niet gesynchroniseerde admin-defaultkopie en een workflowexport die niet gelijk was aan de actuele generatorregel. Beide zijn hergegenereerd; de broninventaris is expliciet opnieuw gecontroleerd. De volledige suite is daarna opnieuw uitgevoerd, zonder gewijzigde asserties om de fouten te verbergen.

| Onafhankelijke eindrun | Geslaagd | Overgeslagen | Fouten |
| --- | ---: | ---: | ---: |
| Volledige handleiding-Node-suite | 92 | 0 | 0 |
| Start-/Beleidskompasregressies | 18 | 0 | 0 |
| Brede native/minimal/branding/auth/retentie/tool/document/prompt-/naamregressies | 166 | 1 live extractie | 0 |
| Python discovery | 59 | 13 proxyintegraties | 0 |
| Fixturebrowser | 29 scenario’s | 0 | 0 |
| Volledige native browser | 5 scenario’s | 0 | 0 |
| Contentgenerator, gepinde upstreaminventaris en whitespace | Groen | — | 0 |

Deze aantallen niet optellen bij oudere runs of overlappende snapshots. De Node-container had geen netwerk, geen productiecredentials en uitsluitend een gesanitiseerde bronkopie plus tijdelijke testdependencies. Browserharnassen draaien lokaal met synthetische identiteit. Testoutput staat uitsluitend in de genegeerde tijdelijke werkmap; reproduceerbare tests en screenshots staan in de repository.

## Beheer en bewijs

- [Configuratie, API’s, bestandsbeheer, privacy en rollback](configurable-manual.md).
- [Frontend en installatie van de optionele native integratie](manual-frontend.md).
- [Native buildvalidatie](manual-native-build-validation.md).
- [Screenshots en machineleesbare browserresultaten](../tests/manual/evidence/README.md).
- [Beveiligings- en contentreview](manual-content-security-review.md).

De concept-PR is geschikt voor inhoudelijke en technische review, niet voor de claim dat de volledige gevraagde feature perfect of productiegevalideerd is afgerond.
