const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Docker = require('dockerode');
const pty = require('node-pty');
const yaml = require('js-yaml');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const docker = new Docker();

let uploadedTopology = null;
const activeTerminals = new Map();

app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));

async function discoverTopology() {
    if (uploadedTopology) return uploadedTopology;
    try {
        const containers = await docker.listContainers();
        const clabNode = containers.find(c => c.Labels && c.Labels['containerlab.dev/topo-file']);
        if (clabNode) {
            const topoPath = clabNode.Labels['containerlab.dev/topo-file'];
            if (fs.existsSync(topoPath)) {
                uploadedTopology = yaml.load(fs.readFileSync(topoPath, 'utf8'));
                return uploadedTopology;
            }
        }
    } catch (e) { console.error('Discovery error:', e.message); }
    return null;
}

app.get('/has-topology', async (req, res) => {
    const topo = await discoverTopology();
    res.json({ loaded: topo !== null });
});

app.get('/topology-graph', async (req, res) => {
    const topoData = await discoverTopology();
    if (!topoData || !topoData.topology) return res.json({ nodes: [], links: [] });

    const nodes = []; const links = [];
    const topo = topoData.topology;
    const prefix = 'clab-' + (topoData.name || 'lab') + '-';

    Object.keys(topo.nodes || {}).forEach(name => {
        let type = 'client';
        if (name.includes('spine')) type = 'spine';
        else if (name.includes('leaf')) type = 'leaf';
        nodes.push({ id: prefix + name, label: name, type: type });
    });

    (topo.links || []).forEach(l => {
        const [n1, i1] = l.endpoints[0].split(':');
        const [n2, i2] = l.endpoints[1].split(':');
        const s = prefix + n1, t = prefix + n2;
        links.push({ source: s, target: t, sourceIf: i1, targetIf: i2, type: 'physical' });
        
        // Logical Overlay Flags
        if ((s.includes('spine') || s.includes('leaf')) && (t.includes('spine') || t.includes('leaf'))) {
            links.push({ source: s, target: t, type: 'bgp' });
            links.push({ source: s, target: t, type: 'vxlan' });
            links.push({ source: s, target: t, type: 'ospf' });
            links.push({ source: s, target: t, type: 'isis' });
        }
    });
    res.json({ nodes, links });
});

app.get('/containers', async (req, res) => {
    try {
        const containers = await docker.listContainers({ all: true });
        res.json(containers.filter(c => c.Names.some(n => n.includes('clab-'))).map(c => ({
            name: c.Names[0].replace('/', ''), state: c.State, status: c.Status
        })));
    } catch (e) { res.json([]); }
});

app.get('/container-capabilities/:name', async (req, res) => {
    const name = req.params.name;
    const exec = (cmd) => new Promise(r => require('child_process').exec('docker exec ' + name + ' which ' + cmd, (e) => r(!e)));
    const [hasBash, hasVtysh] = await Promise.all([exec('bash'), exec('vtysh')]);
    res.json({ shell: hasBash ? 'bash' : 'sh', vtysh: hasVtysh });
});

app.post('/upload-yaml', (req, res) => {
    try { uploadedTopology = yaml.load(req.body.yaml); res.json({ status: 'ok' }); }
    catch (e) { res.status(400).json({ error: 'Invalid YAML' }); }
});

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://' + req.headers.host);
    const container = url.searchParams.get('container');
    const type = url.searchParams.get('type');
    if (container && type) {
        const term = pty.spawn('docker', ['exec', '-it', container, type], {
            name: 'xterm-color', cols: 100, rows: 30, env: process.env
        });
        const id = Math.random().toString(36).substring(7);
        activeTerminals.set(id, term);
        term.on('data', d => ws.readyState === WebSocket.OPEN && ws.send(d));
        ws.on('message', m => term.write(m));
        ws.on('close', () => { term.kill(); activeTerminals.delete(id); });
    }
});

server.listen(3000, () => console.log('Designer Online: http://localhost:3000'));
