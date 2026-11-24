"""Inspect only the owned synthetic image probe; emit answer traits, not contents."""
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = r"""
const mongoose = require('mongoose');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  try {
    const { email } = JSON.parse(input);
    if (!/^tika-probe-[a-f0-9]+@example\.invalid$/.test(email)) throw new Error('scope');
    await mongoose.connect(process.env.MONGO_URI);
    const db = mongoose.connection.db;
    const user = await db.collection('users').findOne({ email });
    if (!user) throw new Error('user');
    const question = 'Hoeveel blauwe vakken in de afbeelding bevatten het cijfer 7? Geef alleen het aantal terug.';
    const restrictedQuestion = 'Gebruik geen tools. ' + question;
    const prompt = await db.collection('messages').find({
      user: { $in: [user._id, String(user._id)] }, isCreatedByUser: true,
      $or: [{ text: { $in: [question, restrictedQuestion] } }, { 'content.text': { $in: [question, restrictedQuestion] } }],
    }).sort({ createdAt: -1 }).limit(1).next();
    if (!prompt) {
      console.log(JSON.stringify({ syntheticImagePromptFound: false }));
    } else {
      const response = await db.collection('messages').find({
        user: { $in: [user._id, String(user._id)] },
        conversationId: prompt.conversationId, isCreatedByUser: false,
      }).sort({ createdAt: -1 }).limit(1).next();
      const text = response ? (response.text || (response.content || []).map(c => c.text || '').join('\n')) : '';
      console.log(JSON.stringify({ syntheticImagePromptFound: true, assistantResponseStored: !!response,
        matchesImageIntentFailure: text === 'De afbeeldingsintentie kon niet veilig worden bepaald. Probeer het verzoek opnieuw.',
        attachedFileCount: Array.isArray(prompt.files) ? prompt.files.length : 0,
        attachedImageCount: Array.isArray(prompt.files) ? prompt.files.filter(f => /^image\//.test(f.type || f.mimetype || '')).length : 0,
        responseChars: text.length, numericTwoPresent: /(^|\D)2(\D|$)/.test(text),
        wordTwoPresent: /\b(twee|two)\b/i.test(text), exactlyTwo: /^\s*2[.!\s]*$/.test(text),
        fixedErrorTerms: ['error', 'fout', 'unable', 'cannot', 'kan niet', 'geen afbeelding', 'niet zien',
          'ontbreekt', 'upload', 'meegestuurd', 'afbeelding', 'blauwe', 'vak', 'document', 'controlecode']
          .filter(term => text.toLowerCase().includes(term)) }));
    }
    await mongoose.disconnect();
  } catch (error) {
    console.log(JSON.stringify({ inspectionFailed: true, errorClass: error.name }));
    process.exit(1);
  }
});
"""

if __name__ == '__main__':
    credentials = json.loads((ROOT / '.tika-upload-local/app-probes/owner-account.json').read_text())
    result = subprocess.run(['docker', 'exec', '-i', 'govchat-tika-local-app-app-1', 'node', '-e', SCRIPT],
                            input=json.dumps({'email': credentials['email']}), text=True,
                            capture_output=True, timeout=30)
    # Child stdout contains only fixed-code, bounded observations by construction.
    print(result.stdout.strip())
    sys.exit(result.returncode)
