// ============================================================
//  Kitty Lab — API Server (Netlify Functions)
//  Storage: JSONStore via fetch (sem dependências externas)
//  Usa Netlify's built-in KV via REST API nativa
// ============================================================

const DAYS = ['Segunda','Terça','Quarta','Quinta','Sexta','Sábado','Domingo'];

// ── In-memory fallback (persiste durante a execução da função)
// Para persistência real usamos o Netlify Blobs via REST API direta
const MEM = {};

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

// ── Storage via Netlify Blobs REST API (sem SDK) ──────────────
// O Netlify injeta automaticamente NETLIFY_BLOBS_CONTEXT em base64
// quando a função roda no runtime deles
function getBlobsContext() {
    try {
        const ctx = process.env.NETLIFY_BLOBS_CONTEXT;
        if (ctx) return JSON.parse(Buffer.from(ctx, 'base64').toString('utf8'));
    } catch {}
    return null;
}

async function blobGet(key) {
    const ctx = getBlobsContext();
    if (!ctx) return MEM[key] || null;
    try {
        const url = `${ctx.url}kitty-lab-tasks/${encodeURIComponent(key)}`;
        const r = await fetch(url, {
            headers: { Authorization: `Bearer ${ctx.token}` }
        });
        if (r.status === 404) return null;
        if (!r.ok) return MEM[key] || null;
        return await r.text();
    } catch { return MEM[key] || null; }
}

async function blobSet(key, value) {
    MEM[key] = value; // sempre salva em memória como fallback
    const ctx = getBlobsContext();
    if (!ctx) return;
    try {
        const url = `${ctx.url}kitty-lab-tasks/${encodeURIComponent(key)}`;
        await fetch(url, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${ctx.token}`,
                'Content-Type': 'text/plain'
            },
            body: value
        });
    } catch {}
}

async function getTasks(day) {
    try {
        const raw = await blobGet(day);
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}

async function setTasks(day, tasks) {
    await blobSet(day, JSON.stringify(tasks));
}

// ── Handler ───────────────────────────────────────────────────
exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return res(200, {});

    const method = event.httpMethod;
    const path   = (event.path || '')
        .replace('/.netlify/functions/api', '')
        .replace('/api', '')
        .replace(/\/$/, '') || '/';
    const qs = event.queryStringParameters || {};

    // GET /health
    if (path === '/health' && method === 'GET') {
        const ctx = getBlobsContext();
        return res(200, {
            ok: true,
            app: 'Kitty Lab API',
            storage: ctx ? 'netlify-blobs' : 'memory',
            ts: new Date().toISOString()
        });
    }

    // GET /tasks?day=
    if (path === '/tasks' && method === 'GET') {
        if (!qs.day) return res(400, { error: 'Parâmetro "day" obrigatório.' });
        return res(200, { day: qs.day, tasks: await getTasks(qs.day) });
    }

    // GET /tasks/all
    if (path === '/tasks/all' && method === 'GET') {
        const days = {};
        for (const d of DAYS) days[d] = await getTasks(d);
        return res(200, { days });
    }

    // POST /tasks  { day, label, time? }
    if (path === '/tasks' && method === 'POST') {
        let body;
        try { body = JSON.parse(event.body || '{}'); }
        catch { return res(400, { error: 'Body inválido.' }); }

        const { day, label, time } = body;
        if (!day || !label) return res(400, { error: '"day" e "label" são obrigatórios.' });

        const tasks = await getTasks(day);
        if (time) {
            const conflict = tasks.find(t => t.time === time);
            if (conflict) return res(409, { conflict: true, existing: conflict });
        }

        const task = {
            id: Date.now(),
            label: String(label).trim(),
            time: time || '',
            done: false,
            createdBy: 'alexa'
        };
        tasks.push(task);
        tasks.sort((a, b) => (a.time||'99:99').localeCompare(b.time||'99:99'));
        await setTasks(day, tasks);
        return res(201, { success: true, task });
    }

    // PATCH /tasks/:id?day=
    if (path.startsWith('/tasks/') && method === 'PATCH') {
        const id = parseInt(path.split('/')[2]);
        if (!qs.day) return res(400, { error: '"day" obrigatório.' });
        const tasks = await getTasks(qs.day);
        const task  = tasks.find(t => t.id === id);
        if (!task) return res(404, { error: 'Tarefa não encontrada.' });
        let upd; try { upd = JSON.parse(event.body||'{}'); } catch { upd={}; }
        if (typeof upd.done==='boolean') task.done=upd.done;
        if (typeof upd.label==='string') task.label=upd.label.trim();
        await setTasks(qs.day, tasks);
        return res(200, { success: true, task });
    }

    return res(404, { error: 'Endpoint não encontrado.' });
};
