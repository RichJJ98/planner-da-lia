// ============================================================
//  Kitty Lab — API Server (Netlify Functions / Node.js)
//  netlify/functions/api.js
//
//  Endpoints:
//    GET  /api/health             → { ok: true }
//    GET  /api/tasks?day=Segunda  → { tasks: [...] }
//    POST /api/tasks              → { success, task } | { conflict: true }
//    GET  /api/tasks/all          → { days: { Segunda: [...], ... } }
//    PATCH /api/tasks/:id?day=    → { success, task }
// ============================================================

const { getStore } = require('@netlify/blobs');

const STORE  = 'kitty-lab-tasks';
const DAYS   = ['Segunda','Terça','Quarta','Quinta','Sexta','Sábado','Domingo'];

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

async function getTasks(store, day) {
    try {
        const raw = await store.get(day);
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}

async function setTasks(store, day, tasks) {
    await store.set(day, JSON.stringify(tasks));
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return res(200, {});

    const store  = getStore(STORE);
    const method = event.httpMethod;
    const path   = (event.path || '')
        .replace('/.netlify/functions/api', '')
        .replace('/api', '')
        .replace(/\/$/, '') || '/';
    const qs = event.queryStringParameters || {};

    // GET /health
    if (path === '/health' && method === 'GET')
        return res(200, { ok: true, app: 'Kitty Lab API', ts: new Date().toISOString() });

    // GET /tasks?day=
    if (path === '/tasks' && method === 'GET') {
        if (!qs.day) return res(400, { error: 'Parâmetro "day" obrigatório.' });
        return res(200, { day: qs.day, tasks: await getTasks(store, qs.day) });
    }

    // GET /tasks/all
    if (path === '/tasks/all' && method === 'GET') {
        const days = {};
        for (const d of DAYS) days[d] = await getTasks(store, d);
        return res(200, { days });
    }

    // POST /tasks  { day, label, time? }
    if (path === '/tasks' && method === 'POST') {
        let body;
        try { body = JSON.parse(event.body || '{}'); }
        catch { return res(400, { error: 'Body inválido.' }); }

        const { day, label, time } = body;
        if (!day || !label) return res(400, { error: '"day" e "label" são obrigatórios.' });

        const tasks = await getTasks(store, day);

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
        tasks.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
        await setTasks(store, day, tasks);

        return res(201, { success: true, task });
    }

    // PATCH /tasks/:id?day=  { done?, label? }
    if (path.startsWith('/tasks/') && method === 'PATCH') {
        const id = parseInt(path.split('/')[2]);
        if (!qs.day) return res(400, { error: '"day" obrigatório.' });

        const tasks = await getTasks(store, qs.day);
        const task  = tasks.find(t => t.id === id);
        if (!task) return res(404, { error: 'Tarefa não encontrada.' });

        let upd;
        try { upd = JSON.parse(event.body || '{}'); } catch { upd = {}; }
        if (typeof upd.done  === 'boolean') task.done  = upd.done;
        if (typeof upd.label === 'string')  task.label = upd.label.trim();

        await setTasks(store, qs.day, tasks);
        return res(200, { success: true, task });
    }

    return res(404, { error: 'Endpoint não encontrado.' });
};
