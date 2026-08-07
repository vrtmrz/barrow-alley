import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const composePath = path.join(repositoryRoot, "test/fixtures/nostr-relay/compose.yml");
const relayPort = process.env.BARROW_ALLEY_TEST_RELAY_PORT ?? "4010";
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "barrow-alley-trystero-"));
const peerBundle = path.join(temporaryDirectory, "trystero-peer.mjs");
const children = [];
let relayStarted = false;
let cleaningUp = false;

try {
  await symlink(
    path.join(repositoryRoot, "node_modules"),
    path.join(temporaryDirectory, "node_modules"),
    "dir",
  );
  await run("docker", ["compose", "-f", composePath, "up", "-d"]);
  relayStarted = true;
  await waitForWebSocket(relayUrl, 30_000);
  await build({
    entryPoints: [path.join(repositoryRoot, "test/e2e/trystero-peer.ts")],
    outfile: peerBundle,
    bundle: true,
    format: "esm",
    packages: "external",
    platform: "node",
    target: "node24",
    sourcemap: "inline",
  });

  const sender = startPeer("sender");
  children.push(sender.child);
  const senderReady = await sender.waitFor("ready");

  const receiver = startPeer("receiver");
  children.push(receiver.child);
  const receiverReady = await receiver.waitFor("ready");
  const [approvalPending, awaitingApproval] = await Promise.all([
    sender.waitFor("approval-pending"),
    receiver.waitFor("awaiting-approval"),
  ]);

  assert.equal(typeof approvalPending.peerId, "string");
  assert.equal(awaitingApproval.senderPeerId, senderReady.peerId);
  assert.equal(approvalPending.peerId, receiverReady.peerId);
  assert.deepEqual(awaitingApproval.receivedMessages, []);
  assert.equal(awaitingApproval.manifest, undefined);

  sender.child.send({ type: "accept" });
  const [serving, browsing] = await Promise.all([
    sender.waitFor("serving"),
    receiver.waitFor("browsing"),
  ]);
  assert.equal(serving.peerId, approvalPending.peerId);
  assert.deepEqual(
    browsing.manifest?.map(({ id, displayName }) => ({ id, displayName })),
    [{ id: "item-1", displayName: "notes.md" }],
  );
  assert.equal(JSON.stringify(browsing.receivedMessages).includes("local/"), false);

  sender.child.send({ type: "close" });
  const [senderClosed, receiverClosed] = await Promise.all([
    sender.waitFor("closed"),
    receiver.waitFor("closed"),
  ]);
  assert.equal(senderClosed.state, "closed");
  assert.equal(receiverClosed.state, "closed");
  await Promise.all([sender.waitForExit(), receiver.waitForExit()]);
  console.log("Two local Trystero clients reached sender approval without pre-accept metadata.");
} finally {
  cleaningUp = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
  if (relayStarted) {
    await run("docker", ["compose", "-f", composePath, "down", "--volumes"]);
  }
}

function startPeer(role) {
  const child = fork(peerBundle, [], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      BARROW_ALLEY_TEST_ROLE: role,
      BARROW_ALLEY_TEST_RELAY: relayUrl,
    },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  const inbox = [];
  const waiters = [];
  let exit;
  const exited = new Promise((resolve, reject) => {
    exit = { resolve, reject };
  });
  child.on("message", (message) => {
    const index = waiters.findIndex((waiter) => waiter.type === message?.type);
    if (index < 0) inbox.push(message);
    else waiters.splice(index, 1)[0].resolve(message);
  });
  child.once("error", (error) => {
    exit.reject(error);
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });
  child.once("exit", (code, signal) => {
    if (code === 0 || (cleaningUp && signal === "SIGTERM")) exit.resolve();
    else {
      const error = new Error(`${role} peer exited with code ${code ?? "null"} (${signal ?? "no signal"}).`);
      exit.reject(error);
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    }
  });
  return {
    child,
    waitFor(type) {
      const index = inbox.findIndex((message) => message?.type === type);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return withTimeout(
        new Promise((resolve, reject) => waiters.push({ type, resolve, reject })),
        45_000,
        `Timed out waiting for ${role} message '${type}'.`,
      );
    },
    waitForExit() {
      return withTimeout(exited, 15_000, `Timed out waiting for ${role} to exit.`);
    },
  };
}

async function waitForWebSocket(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("WebSocket probe timed out."));
        }, 1_000);
        socket.addEventListener("open", () => {
          clearTimeout(timer);
          socket.close();
          resolve();
        }, { once: true });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("WebSocket probe failed."));
        }, { once: true });
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Local Nostr relay did not open at ${url}.`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: { ...process.env, BARROW_ALLEY_TEST_RELAY_PORT: relayPort },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? "null"} (${signal ?? "no signal"}).`));
    });
  });
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}
