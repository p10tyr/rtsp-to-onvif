const http = require('http');

const MAX_BODY_BYTES = 256 * 1024;

const STRIP_REQ = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'expect']);
const STRIP_RES = new Set(['connection', 'content-length', 'transfer-encoding', 'set-cookie', 'www-authenticate', 'proxy-authenticate', 'server']);

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
                request.destroy();
                reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
                return;
            }
            chunks.push(c);
        });
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
}

function forward(targetUrl, headers, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(targetUrl);
        const req = http.request({
            method: 'POST',
            hostname: u.hostname,
            port: u.port || 80,
            path: u.pathname + u.search,
            headers: {
                ...headers,
                host: u.host,
                'content-length': Buffer.byteLength(body),
            },
            timeout: 15000,
        }, (res) => {
            res.on('error', reject);
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks),
            }));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('upstream timeout')));
        req.end(body);
    });
}

function sanitizeRequestHeaders(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        if (!STRIP_REQ.has(k.toLowerCase())) out[k] = v;
    }
    return out;
}

function sanitizeResponseHeaders(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        if (!STRIP_RES.has(k.toLowerCase())) out[k] = v;
    }
    return out;
}

async function forwardSoap({ logger, name, request, response, upstreamUrl, rewriteRequest, rewriteResponse }) {
    try {
        const reqBody = await readBody(request);
        let body = reqBody.toString('utf8');
        if (typeof rewriteRequest === 'function') {
            const r = rewriteRequest(body);
            if (r != null) body = r;
        }

        const upstreamResp = await forward(upstreamUrl, sanitizeRequestHeaders(request.headers), Buffer.from(body, 'utf8'));

        if (upstreamResp.statusCode >= 400) {
            const snippet = upstreamResp.body.toString('utf8').slice(0, 200).replace(/\s+/g, ' ');
            logger.warn(`PROXY: ${name} - upstream ${upstreamResp.statusCode}: ${snippet}`);
        }

        let outBody = upstreamResp.body;
        if (typeof rewriteResponse === 'function') {
            const r = rewriteResponse(outBody.toString('utf8'), body);
            if (r != null) outBody = Buffer.from(r, 'utf8');
        }

        const respHeaders = sanitizeResponseHeaders(upstreamResp.headers);
        respHeaders['content-length'] = Buffer.byteLength(outBody);
        response.writeHead(upstreamResp.statusCode, respHeaders);
        response.end(outBody);
    } catch (err) {
        logger.error(`PROXY: ${name} - ${err.message}`);
        if (!response.headersSent) {
            response.writeHead(502, { 'content-type': 'text/plain' });
            response.end(`Upstream proxy failure: ${err.message}`);
        }
    }
}

module.exports = {
    readBody,
    forward,
    sanitizeRequestHeaders,
    sanitizeResponseHeaders,
    forwardSoap,
};
