#!/usr/bin/env node
// Checks the native shells and the web app against shell/native-api.json: every
// method and event there is implemented by each platform it names (both, unless
// it says otherwise), neither shell offers anything the contract does not list,
// and the web app asks for nothing that is not in it (one only some shells have,
// only where it checks for that shell's feature).
//
//   node scripts/check-native-api.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const contract = JSON.parse(readFileSync(join(root, "shell/native-api.json"), "utf8"));

function files(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!["node_modules", "build", "public", "lab"].includes(name)) out.push(...files(path, ext));
    } else if (path.endsWith(ext)) out.push(path);
  }
  return out;
}

const text = (list) => list.map((f) => readFileSync(f, "utf8")).join("\n");
const all = (source, re) => new Set([...source.matchAll(re)].map((m) => m[1]));

const java = text(files(join(root, "shell/android/app/src/main/java"), ".java"));
const swift = text(files(join(root, "shell/ios/App"), ".swift"));
const web = text(files(join(root, "web"), ".js"));

const platforms = {
  android: {
    methods: all(java, /@PluginMethod\s+public void (\w+)\(/g),
    events: all(java, /notifyListeners\("(\w+)"/g),
  },
  ios: {
    methods: all(swift, /CAPPluginMethod\(name: "(\w+)"/g),
    events: all(swift, /(?:notifyListeners|emit)\("(\w+)"/g),
  },
};
const used = {
  methods: new Set([...all(web, /shell\??\.ivrit\.(\w+)\(/g)].filter((m) => m !== "addListener")),
  events: all(web, /shell\??\.ivrit\.addListener\("(\w+)"/g),
};

const problems = [];
for (const kind of ["methods", "events"]) {
  const listed = contract[kind];
  for (const [name, raw] of Object.entries(listed)) {
    const spec = typeof raw === "string" ? {} : raw;
    for (const platform of spec.platforms ?? Object.keys(platforms)) {
      if (!platforms[platform][kind].has(name)) problems.push(`${platform} lacks ${kind.slice(0, -1)} ${name}`);
    }
  }
  for (const [platform, found] of Object.entries(platforms)) {
    for (const name of found[kind]) {
      if (!listed[name]) problems.push(`${platform} has ${kind.slice(0, -1)} ${name}, which the contract does not list`);
    }
  }
  for (const name of used[kind]) {
    const spec = listed[name];
    if (!spec) problems.push(`the web app uses ${kind.slice(0, -1)} ${name}, which the contract does not list`);
    // Only some shells have it: fine behind its feature check, never otherwise.
    else if (spec.platforms && !(spec.feature && web.includes(`"${spec.feature}"`))) {
      problems.push(`the web app uses ${name}, which only ${spec.platforms} has, without checking for "${spec.feature ?? "its feature"}"`);
    }
  }
}

const counts = Object.entries(platforms).map(([p, f]) => `${p} ${f.methods.size}+${f.events.size}`).join(", ");
if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  process.exit(1);
}
console.log(`native API: ${Object.keys(contract.methods).length} methods, ${Object.keys(contract.events).length} events; ${counts} (methods+events); web uses ${used.methods.size}+${used.events.size}: ok`);
