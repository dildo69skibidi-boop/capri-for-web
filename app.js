'use strict';
const $ = (id) => document.getElementById(id);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

const MOODS = { hearts:'hearts', confused:'confused', flail:'flail', laptop:'laptop', juggle:'juggle', meditate:'meditate', handstand:'handstand', peek:'peek', chill:'sit_chill' };
const TAG_RE = new RegExp('\\[(' + Object.keys(MOODS).join('|') + ')\\]', 'gi');
const IDLE = ['sit_chill', 'sit_legs', 'lounge_pc', 'laptop', 'juggle', 'peek', 'handstand', 'meditate'];
const LABELS = { original:'Original', dominant:'Dominant', tsundere:'Tsundere', submissive:'Submissive', flirty:'Flirty & romantic (playful)', hopeless_romantic:'Hopelessly romantic (deeply in love)' };
const CONTEXT_MESSAGES = 40, UI_MESSAGES = 120, MEMORY_BATCH = 30, MEMORY_MAX = 9000;

let cfg = Object.assign({ provider:'openai', baseUrl:'https://openrouter.ai/api/v1', model:'openai/gpt-4o-mini', apiKey:'', personality:'original', romantic:false }, LS.get('cfg', {}));
let history = LS.get('history', []);   // [{role, content, t}]
let memory = LS.get('memory', '');
let memCursor = LS.get('memCursor', 0);
let unlocked = false;                   // romantic modes relock every time the app is closed
let busy = false, lastTouch = Date.now(), moodTimer = null;

// Never start in a locked mode.
if (LOCKED.includes(cfg.personality)) cfg.personality = 'original';
cfg.romantic = false;
saveCfg();

function saveCfg() { LS.set('cfg', cfg); }
function saveHistory() { LS.set('history', history.slice(-600)); LS.set('memCursor', memCursor); }

// ---------- sprite ----------
function setSprite(name, holdMs) {
  $('sprite').src = 'sprites/' + name + '.png';
  clearTimeout(moodTimer);
  if (holdMs) moodTimer = setTimeout(() => setSprite('sit_chill'), holdMs);
}
setInterval(() => {
  if (busy || Date.now() - lastTouch < 25000) return;
  setSprite(IDLE[Math.floor(Math.random() * IDLE.length)]);
}, 20000);
$('sprite').addEventListener('click', () => { lastTouch = Date.now(); setSprite(Math.random() < .5 ? 'hearts' : 'flail', 4000); });
document.addEventListener('touchstart', () => { lastTouch = Date.now(); }, { passive: true });

// ---------- chat UI ----------
function addBubble(role, text, cls) {
  const d = document.createElement('div');
  d.className = 'm ' + (cls || role);
  d.textContent = text;
  $('msgs').appendChild(d);
  $('msgs').scrollTop = $('msgs').scrollHeight;
  return d;
}
function renderAll() {
  $('msgs').innerHTML = '';
  for (const m of history.slice(-UI_MESSAGES)) addBubble(m.role === 'user' ? 'user' : 'bot', m.content);
  if (!history.length) addBubble('bot', 'Hey choom. Open the gear and add your API key, then say something.');
}

// ---------- prompt ----------
function personaText() {
  let p = PERSONAS[cfg.personality] || PERSONAS.original;
  if (cfg.romantic && unlocked) p += '\n\n' + ROMANTIC_OVERLAY;
  return p;
}
function buildSystem() {
  const now = new Date();
  const lines = [
    'You are a companion character chatting with the user through a chat screen on their phone.',
    'The <persona> block below defines who you are, how you talk, and what you know. Stay in that character at all times. The user can change your personality from a menu, so if earlier messages sound different from the persona below, the persona wins: switch to it smoothly without commenting on it.',
    '',
    'How to be smart while staying in character:',
    '- Think before answering. When the user asks a real question (how-to, explanation, advice, code, maths, planning), give a correct, complete, genuinely useful answer in your own voice. Be accurate; if you are unsure or do not know, say so instead of guessing.',
    '- For casual banter keep it short (1-4 sentences). For real questions use as much space as the answer needs, but stay compact. Plain text only: no markdown headings or tables; short lists and code are fine.',
    '- Use what you remember naturally, the way a friend would. Do not recite your notes, do not say "according to my memory", and never invent memories.',
    '- If the user corrects you or tells you something new about themselves, accept it; it will be saved to your notes automatically.',
    '- Ask a short follow-up question only when it really helps.',
    'Optionally end a reply with ONE reaction tag that makes your on-screen sprite react: ' + Object.keys(MOODS).map((m) => '[' + m + ']').join(' ') + '. Use it only when it fits; never explain it.',
    '',
    'Current local date and time: ' + now.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' }) + '.',
    '', '<persona>', personaText(), '</persona>',
  ];
  if (memory) lines.push('', '<long_term_memory>', 'Your own notes about the user and your shared history (kept up to date automatically):', memory, '</long_term_memory>');
  return lines.join('\n');
}

// ---------- LLM ----------
function errText(status, body) {
  let detail = '';
  try { const j = JSON.parse(body); detail = (j.error && (j.error.message || j.error)) || j.message || ''; } catch { detail = String(body || '').slice(0, 200); }
  if (typeof detail !== 'string') detail = JSON.stringify(detail);
  if (status === 401 || status === 403) return 'The API key was rejected (' + status + '). Check it in Settings. ' + detail;
  if (status === 402) return 'The provider says you are out of credit (402). ' + detail;
  if (status === 404 || status === 400) return 'Request failed (' + status + '). Check the model name (OpenRouter needs e.g. openai/gpt-4o-mini). ' + detail;
  if (status === 429) return 'Rate limited (429). Wait a moment and try again. ' + detail;
  return 'Request failed (' + status + '). ' + detail;
}
async function callLLM(system, msgs, maxTokens) {
  if (!cfg.apiKey && cfg.provider === 'anthropic') throw new Error('No API key yet. Open Settings and paste your key.');
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 90000);
  try {
    let res, data;
    if (cfg.provider === 'anthropic') {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, system, messages: msgs }),
      });
      const body = await res.text(); if (!res.ok) throw new Error(errText(res.status, body));
      data = JSON.parse(body);
      return (data.content || []).map((b) => b.text || '').join('').trim();
    }
    const headers = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;
    res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', signal: ctl.signal, headers,
      body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...msgs] }),
    });
    const body = await res.text(); if (!res.ok) throw new Error(errText(res.status, body));
    data = JSON.parse(body);
    return ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The request timed out. Try again.');
    if (e instanceof TypeError) throw new Error('Network error. Check your internet connection.');
    throw e;
  } finally { clearTimeout(to); }
}

// ---------- memory ----------
const MEMORY_SYSTEM = 'You keep short private notes for a companion character about the user and their shared history. You get the current notes and a batch of new chat messages. Return the full updated notes as concise markdown bullets: durable facts about the user, preferences, ongoing topics, running jokes, how the user likes to be treated. Merge and drop stale detail to stay under ' + MEMORY_MAX + ' characters. Never store passwords, API keys, payment card numbers, government ID numbers or other secrets. Output only the notes.';
async function updateMemory() {
  const batch = history.slice(memCursor);
  if (batch.length < MEMORY_BATCH) return;
  const upto = history.length;
  const text = batch.map((m) => (m.role === 'user' ? 'User: ' : 'Companion: ') + m.content).join('\n');
  try {
    const out = await callLLM(MEMORY_SYSTEM, [{ role: 'user', content: 'Current notes:\n' + (memory || '(none yet)') + '\n\nNew messages:\n' + text }], 2500);
    if (out) { memory = out.slice(0, MEMORY_MAX); LS.set('memory', memory); memCursor = upto; saveHistory(); }
  } catch { /* try again next time */ }
}

// ---------- sending ----------
function apiMessages() {
  let msgs = history.slice(-CONTEXT_MESSAGES).map((m) => ({ role: m.role, content: m.content }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}
async function send() {
  const text = $('input').value.trim();
  if (!text || busy) return;
  busy = true; $('send').disabled = true; lastTouch = Date.now();
  $('input').value = ''; $('input').style.height = 'auto';
  history.push({ role: 'user', content: text, t: Date.now() });
  addBubble('user', text); saveHistory();
  const typing = addBubble('bot', '...', 'bot typing');
  setSprite('laptop');
  try {
    const raw = await callLLM(buildSystem(), apiMessages(), 1500);
    let mood = null;
    const clean = raw.replace(TAG_RE, (_m, t) => { mood = MOODS[t.toLowerCase()]; return ''; }).trim() || '...';
    typing.remove();
    history.push({ role: 'assistant', content: clean, t: Date.now() });
    addBubble('bot', clean); saveHistory();
    setSprite(mood || 'sit_chill', mood ? 9000 : 0);
    updateMemory();
  } catch (e) {
    typing.remove();
    history.pop(); saveHistory();   // drop the unanswered message so the history stays clean
    $('input').value = text;
    addBubble('bot', e.message, 'err');
    setSprite('confused', 6000);
  } finally { busy = false; $('send').disabled = false; }
}
$('send').addEventListener('click', send);
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('input').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 110) + 'px'; });

// ---------- password lock ----------
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function verifyPw(pw) {
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(PRESET.salt), iterations: 100000 }, key, 256));
    const want = b64(PRESET.hash); if (bits.length !== want.length) return false;
    let d = 0; for (let i = 0; i < want.length; i++) d |= bits[i] ^ want[i];
    return d === 0;
  } catch { return false; }
}
let fails = 0;
function askUnlock() {
  return new Promise((resolve) => {
    $('pw').value = ''; $('pwErr').textContent = ''; $('unlock').classList.remove('hidden'); $('pw').focus();
    const done = (ok) => { $('unlock').classList.add('hidden'); $('pwOk').onclick = $('pwCancel').onclick = null; resolve(ok); };
    $('pwCancel').onclick = () => done(false);
    $('pwOk').onclick = async () => {
      if (await verifyPw($('pw').value)) { unlocked = true; fails = 0; done(true); return; }
      fails++; $('pwErr').textContent = 'Wrong password.';
      $('pwOk').disabled = true; await new Promise((r) => setTimeout(r, Math.min(500 * fails, 5000))); $('pwOk').disabled = false;
    };
  });
}

// ---------- settings ----------
function fillPersonalities() {
  const sel = $('personality'); sel.innerHTML = '';
  for (const id of Object.keys(PERSONAS)) {
    const o = document.createElement('option'); o.value = id;
    o.textContent = LABELS[id] + (LOCKED.includes(id) && !unlocked ? ' (locked)' : ''); sel.appendChild(o);
  }
  sel.value = cfg.personality;
}
function openSettings() {
  $('provider').value = cfg.provider; $('baseUrl').value = cfg.baseUrl; $('model').value = cfg.model;
  $('apiKey').value = cfg.apiKey; $('romantic').checked = !!cfg.romantic;
  fillPersonalities(); $('settings').classList.remove('hidden');
}
$('gear').addEventListener('click', openSettings);
$('personality').addEventListener('change', async (e) => {
  const id = e.target.value;
  if (LOCKED.includes(id) && !unlocked && !(await askUnlock())) { e.target.value = cfg.personality; return; }
  cfg.personality = id; saveCfg(); fillPersonalities();
});
$('romantic').addEventListener('change', async (e) => {
  if (e.target.checked && !unlocked && !(await askUnlock())) { e.target.checked = false; return; }
  cfg.romantic = e.target.checked; saveCfg();
});
$('lock').addEventListener('click', () => {
  unlocked = false; cfg.romantic = false; $('romantic').checked = false;
  if (LOCKED.includes(cfg.personality)) cfg.personality = 'original';
  saveCfg(); fillPersonalities();
});
$('clearChat').addEventListener('click', () => { if (confirm('Clear the chat? Her memory notes are kept.')) { history = []; memCursor = 0; saveHistory(); renderAll(); } });
$('clearMem').addEventListener('click', () => { if (confirm('Clear her long-term memory notes?')) { memory = ''; LS.set('memory', ''); memCursor = history.length; saveHistory(); } });
$('close').addEventListener('click', () => {
  cfg.provider = $('provider').value; cfg.baseUrl = $('baseUrl').value.trim() || 'https://openrouter.ai/api/v1';
  cfg.model = $('model').value.trim() || 'openai/gpt-4o-mini'; cfg.apiKey = $('apiKey').value.trim();
  saveCfg(); $('settings').classList.add('hidden');
});

renderAll();
if (!cfg.apiKey) setTimeout(openSettings, 400);
