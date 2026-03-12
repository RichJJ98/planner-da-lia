// ============================================================
//  Kitty Lab — API Server (Netlify Functions)
//  netlify/functions/api.js
// ============================================================

const https = require('https');
const DAYS = ['Segunda','Terça','Quarta','Quinta','Sexta','Sábado','Domingo'];

function res(status, body) {
    return {
        statusCode: status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        },
        body: JSON.stringify(body)
    };
}

// ── Detecta siteID e token de QUALQUER variável de ambiente disponível ──
function getCredentials() {
    const env = process.env;

    // Tenta NETLIFY_BLOBS_CONTEXT primeiro (injetado automaticamente pelo runtime)
    if (env.NETLIFY_BLOBS_CONTEXT) {
        try {
            const ctx = JSON.parse(Buffer.from(env.NETLIFY_BLOBS_CONTEXT, 'base64').toString());
            if (ctx.siteID && ctx.token) return { siteID: ctx.siteID, token: ctx.token, source: 'context' };
        } catch {}
    }

    // Varre TODAS as variáveis de ambiente procurando siteID (UUID) e token (começa com nfp_)
    let siteID = null, token = null;
    for (const [k, v] of Object.entries(env)) {
        if (!v) continue;
        // Token Netlify começa com nfp_
        if (!token && v.startsWith('nfp_')) token = v;
        // Site ID é UUID formato xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
        if (!siteID && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) siteID = v;
    }

    if (siteID && token) return { siteID, token, source: 'env-scan' };
    return null;
}

// ── Blobs via REST API (sem SDK) ──────────────────────────────
function blobRequest(method, siteID, token, key, body) {
    return new Promise((resolve, reject) => {
        const path = `/api/v1/sites/${siteID}/blobs/${encodeURIComponent(key)}?context=production&prefix=kitty-lab-tasks`;
        const opts = {
            hostname: 'api.netlify.com',
            path,
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(body ? { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) } : {})
            }
        };
        const req = https.request(opts, r => {
            let data = '';
            r.on('data', c => data += c);
            r.on('end', () => resolve({ status: r.statusCode, body: data }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

const MEM = {};

async function blobGet(creds, key) {
    if (!creds) return MEM[key] || null;
    try {
        const r = await blobRequest('GET', creds.siteID, creds.token, key);
        if (r.status === 200) return r.body;
        return MEM[key] || null;
    } catch { return MEM[key] || null; }
}

async function blobSet(creds, key, value) {
    MEM[key] = value;
    if (!creds) return;
    try { await blobRequest('PUT', creds.siteID, creds.token, key, value); } catch {}
}

async function getTasks(creds, day) {
    try { const r = await blobGet(creds, day); return r ? JSON.parse(r) : []; }
    catch { return []; }
}
async function setTasks(creds, day, tasks) {
    await blobSet(creds, day, JSON.stringify(tasks));
}

// ── Handler ───────────────────────────────────────────────────
exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return res(200, {});

    const creds  = getCredentials();
    const method = event.httpMethod;
    const path   = (event.path || '')
        .replace('/.netlify/functions/api', '')
        .replace('/api', '')
        .replace(/\/$/, '') || '/';
    const qs = event.queryStringParameters || {};

    // GET /health
    if (path === '/health' && method === 'GET') {
        let storage = 'memory';
        if (creds) {
            try {
                await blobRequest('GET', creds.siteID, creds.token, '__ping__');
                storage = 'netlify-blobs (' + creds.source + ')';
            } catch { storage = 'blobs-error'; }
        }
        return res(200, { ok: true, app: 'Kitty Lab API', storage, ts: new Date().toISOString() });
    }

    // GET /tasks?day=
    if (path === '/tasks' && method === 'GET') {
        if (!qs.day) return res(400, { error: 'Parâmetro "day" obrigatório.' });
        return res(200, { day: qs.day, tasks: await getTasks(creds, qs.day) });
    }

    // GET /tasks/all
    if (path === '/tasks/all' && method === 'GET') {
        const days = {};
        for (const d of DAYS) days[d] = await getTasks(creds, d);
        return res(200, { days });
    }

    // POST /tasks
    if (path === '/tasks' && method === 'POST') {
        let body;
        try { body = JSON.parse(event.body || '{}'); }
        catch { return res(400, { error: 'Body inválido.' }); }
        const { day, label, time } = body;
        if (!day || !label) return res(400, { error: '"day" e "label" são obrigatórios.' });
        const tasks = await getTasks(creds, day);
        if (time) {
            const conflict = tasks.find(t => t.time === time);
            if (conflict) return res(409, { conflict: true, existing: conflict });
        }
        const task = { id: Date.now(), label: String(label).trim(), time: time||'', done: false, createdBy: 'alexa' };
        tasks.push(task);
        tasks.sort((a,b) => (a.time||'99:99').localeCompare(b.time||'99:99'));
        await setTasks(creds, day, tasks);
        return res(201, { success: true, task });
    }

    // PATCH /tasks/:id?day=
    if (path.startsWith('/tasks/') && method === 'PATCH') {
        const id = parseInt(path.split('/')[2]);
        if (!qs.day) return res(400, { error: '"day" obrigatório.' });
        const tasks = await getTasks(creds, qs.day);
        const task  = tasks.find(t => t.id === id);
        if (!task) return res(404, { error: 'Tarefa não encontrada.' });
        let upd; try { upd = JSON.parse(event.body||'{}'); } catch { upd={}; }
        if (typeof upd.done==='boolean') task.done=upd.done;
        if (typeof upd.label==='string') task.label=upd.label.trim();
        await setTasks(creds, qs.day, tasks);
        return res(200, { success: true, task });
    }

    return res(404, { error: 'Endpoint não encontrado.' });
};
