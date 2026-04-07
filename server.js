const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Docker = require('dockerode');
const pty = require('node-pty');
const yaml = require('js-yaml');
const fs = require('fs');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const docker = new Docker();

let uploadedTopology = null;

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

app.get('/protocol-status/:proto', async (req, res) => {
    const proto = req.params.proto;
    const containers = await docker.listContainers();
    const clabNodes = containers.filter(c => c.Names[0].includes('clab-'));
    const peerings = [];

    const runVtysh = (name, cmd) => new Promise(r => {
        exec(`docker exec ${name} vtysh -q -c "${cmd}"`, (err, stdout) => r(err ? '' : stdout));
    });

    for (const node of clabNodes) {
        const name = node.Names[0].replace('/', '');
        let cmd = '';
        if (proto === 'bgp') cmd = 'show ip bgp summary';
        else if (proto === 'vxlan') cmd = 'show ip bgp l2vpn evpn summary';
        else if (proto === 'ospf') cmd = 'show ip ospf neighbor';

        const output = await runVtysh(name, cmd);
        const lines = output.split('\n');
        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (proto === 'bgp' || proto === 'vxlan') {
                if (parts.length >= 10) {
                    const stateOrPfx = parts[parts.length - 1];
                    const isUp = !isNaN(stateOrPfx) && stateOrPfx !== '';
                    peerings.push({ node: name, neighborIp: parts[0], status: isUp ? 'up' : 'down' });
                }
            } else if (proto === 'ospf' && (line.includes('Full') || line.includes('2-Way'))) {
                peerings.push({ node: name, neighborIp: parts[0], status: 'up' });
            }
        });
    }
    res.json(peerings);
});

app.get('/topology-graph', async (req, res) => {
    const topoData = await discoverTopology();
    if (!topoData || !topoData.topology) return res.json({ nodes: [], links: [] });
    const nodes = []; const links = [];
    const topo = topoData.topology;
    const prefix = 'clab-' + (topoData.name || 'lab') + '-';

    Object.keys(topo.nodes || {}).forEach(name => {
        let type = name.includes('spine') ? 'spine' : (name.includes('leaf') ? 'leaf' : 'client');
        nodes.push({ id: prefix + name, label: name, type });
    });

    (topo.links || []).forEach(l => {
        const [n1, i1] = l.endpoints[0].split(':');
        const [n2, i2] = l.endpoints[1].split(':');
        links.push({ source: prefix + n1, target: prefix + n2, sourceIf: i1, targetIf: i2 });
    });
    res.json({ nodes, links });
});

app.get('/containers', async (req, res) => {
    try {
        const containers = await docker.listContainers({ all: true });
        res.json(containers.filter(c => c.Names.some(n => n.includes('clab-'))).map(c => ({
            name: c.Names[0].replace('/', ''), state: c.State
        })));
    } catch (e) { res.json([]); }
});

app.get('/container-capabilities/:name', async (req, res) => {
    const name = req.params.name;
    const check = (cmd) => new Promise(r => exec(`docker exec ${name} which ${cmd}`, (e) => r(!e)));
    const [hasBash, hasVtysh] = await Promise.all([check('bash'), check('vtysh')]);
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

        term.on('data', d => { if (ws.readyState === WebSocket.OPEN) ws.send(d); });

        ws.on('message', m => {
            try {
                const data = JSON.parse(m);
                if (data.resize) { term.resize(data.resize.cols, data.resize.rows); return; }
            } catch (e) { term.write(m); }
        });

        ws.on('close', () => term.kill());
    }
});

server.listen(3000, () => console.log('Designer: http://localhost:3000'));
