/*
Iteration 6 FINAL (Stable):
- Fullscreen terminal fixed using xterm fit addon
- Stable pty handling (no crashes)
- TCPDump runs without -it
- Drag/pan/zoom topology
- Node stabilization while dragging
*/

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const Docker = require("dockerode");
const pty = require("node-pty");
const yaml = require("js-yaml");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const docker = new Docker();

let uploadedTopology = null;

app.use(express.static("public"));
app.use(express.json({ limit: "5mb" }));

// ---------------- Containers ----------------
app.get("/containers", async (req, res) => {
  const containers = await docker.listContainers({ all: true });

  const result = containers
    .filter(c => c.Names.some(n => n.includes("clab-")))
    .map(c => ({
      name: c.Names[0].replace("/", ""),
      state: c.State,
      status: c.Status
    }));

  res.json(result);
});

// ---------------- Interfaces ----------------
app.get("/interfaces/:name", (req, res) => {
  const cmd = `docker exec ${req.params.name} ip -o link show`;

  require("child_process").exec(cmd, (err, stdout) => {
    if (err) return res.json([]);

    const ifaces = stdout.split("\n")
      .map(l => (l.match(/^\d+:\s([^:]+):/) || [])[1])
      .filter(Boolean);

    res.json(ifaces);
  });
});

// ---------------- Upload YAML ----------------
app.post("/upload-yaml", (req, res) => {
  try {
    uploadedTopology = yaml.load(req.body.yaml);
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// ---------------- Topology ----------------
app.get("/topology-graph", (req, res) => {
  if (!uploadedTopology?.topology) {
    return res.json({ nodes: [], links: [] });
  }

  const nodes = [];
  const links = [];

  const topo = uploadedTopology.topology;

  Object.keys(topo.nodes).forEach(name => {
    let type = "unknown";
    if (name.includes("spine")) type = "spine";
    else if (name.includes("leaf")) type = "leaf";
    else if (name.includes("client")) type = "client";

    nodes.push({
      id: "clab-evpn-lab-" + name,
      label: name,
      type
    });
  });

  topo.links.forEach(l => {
    const [n1, i1] = l.endpoints[0].split(":");
    const [n2, i2] = l.endpoints[1].split(":");

    links.push({
      source: "clab-evpn-lab-" + n1,
      target: "clab-evpn-lab-" + n2,
      label: `${i1} ↔ ${i2}`
    });
  });

  res.json({ nodes, links });
});

// ---------------- WebSocket Terminal ----------------
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const container = url.searchParams.get("container");
  const type = url.searchParams.get("type");

  if (!container || !type) return ws.close();

  let cmd;
  if (type === "bash") cmd = "bash";
  else if (type === "vtysh") cmd = "vtysh";
  else if (type === "tcpdump") cmd = "tcpdump -l -n";
  else return ws.close();

  const args =
    type === "tcpdump"
      ? ["exec", container, ...cmd.split(" ")]
      : ["exec", "-it", container, cmd];

  const term = pty.spawn("docker", args, {
    name: "xterm-color",
    cols: 120,
    rows: 40
  });

  term.on("data", d => {
    try { ws.send(d); } catch {}
  });

  ws.on("message", m => term.write(m));
  ws.on("close", () => term.kill());
  ws.on("error", () => term.kill());
});

server.listen(3000, () => {
  console.log("http://localhost:3000");
});
