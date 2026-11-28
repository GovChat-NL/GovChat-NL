// Browser host only: imports the actual production modules unchanged.
import * as manual from '/overlay/src/shared/help.js';
import { manualRequest } from '/overlay/src/shared/manual-client.js';
import { applyLibreChatTheme } from '/overlay/src/shared/theme.js';
applyLibreChatTheme();
window.fixtureManual = manual;
window.fixtureRequest = manualRequest;
document.getElementById('native-menu').setAttribute('data-govchat-manual-slot', 'desktop');
document.getElementById('native-footer').setAttribute('data-govchat-manual-slot', 'mobile');
document.getElementById('manual-open').addEventListener('click', () => manual.openManual());
await manual.initializeManual({ nativeEntrypoints: true });
const doc = await manualRequest('document').catch(() => null);
if (doc) {
  for (const [label, href] of [
    ['Canoniek documentcitaat', doc.passages.find(p => p.id === 'documenten').href],
    ['Verouderd citaat', '/c/new?manual=documenten&manualRevision=stale_fixture'],
    ['Verborgen citaat', `/c/new?manual=ouderkind&manualRevision=${doc.revision}`],
    ['Onbekend citaat', `/c/new?manual=unknown&manualRevision=${doc.revision}`],
    ['Gewone bron', '/fixture?source=documenten'],
    ['Niet-canonieke bron', `/c/new?manual=documenten&manualRevision=${doc.revision}&extra=1`],
    ['Externe bron', 'https://example.invalid/source'],
  ]) {
    const a = document.createElement('a'); a.href = href; a.textContent = label;
    a.style.marginRight = '12px'; document.getElementById('citations').append(a);
  }
}
// Simulates the existing overlay route-loop call, not a fake manual adapter.
window.fixtureRoute = path => { history.pushState({}, '', path); manual.manualRouteCheck(); };
window.fixtureReady = true;
