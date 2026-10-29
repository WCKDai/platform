import assert from "node:assert/strict";
import { test } from "node:test";
import { graphProblems, workflowFor } from "../studio.mjs";

test("MiniMax H3 workflow links every node and saves video", () => {
  const graph = workflowFor("comfyui-minimax-h3", "a walk through a station");
  assert.deepEqual(graphProblems(graph), []);
  assert.equal(graph["6"].inputs.text, "a walk through a station");
  assert.equal(graph["6"].inputs.clip[0], "4");
  assert.equal(graph["3"].inputs.model[0], "4");
  assert.equal(graph["8"].inputs.vae[0], "4");
  assert.equal(graph["9"].class_type, "VHS_VideoCombine");
  assert.equal(graph["9"].inputs.images[0], "8");
});

test("a graph with a dangling link is rejected", () => {
  const problems = graphProblems({
    "6": { class_type: "CLIPTextEncode", inputs: { text: "x", clip: ["4", 1] } },
  });
  assert.ok(problems.some((problem) => problem.includes("missing node 4")));
  assert.ok(problems.some((problem) => problem.includes("no video output")));
});
